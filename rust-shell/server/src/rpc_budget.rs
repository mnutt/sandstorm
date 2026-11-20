//! Wire admission for the pinned capnp-rpc runtime. Count retained protocol state,
//! not cumulative traffic. Both directions are observed before forwarding bytes.
use capnp_rpc::rpc_capnp::{cap_descriptor, disembargo, message, resolve, return_};
use std::{
    collections::{HashMap, HashSet},
    time::Instant,
};

const MAX_CAPS: usize = 1024;
const MAX_DESCRIPTORS: u32 = 32;
const BURST: f64 = 512.0;
const BYTE_BURST: f64 = (8 * 1024 * 1024) as f64;

#[derive(Default)]
struct References {
    ids: HashMap<u32, usize>,
    total: usize,
}
impl References {
    fn add(&mut self, descriptor: cap_descriptor::Reader<'_>) -> capnp::Result<Option<u32>> {
        match descriptor.which()? {
            cap_descriptor::SenderHosted(id) | cap_descriptor::SenderPromise(id) => {
                if self.total >= MAX_CAPS {
                    return Err(denied());
                }
                *self.ids.entry(id).or_default() += 1;
                self.total += 1;
                Ok(Some(id))
            }
            cap_descriptor::ThirdPartyHosted(_) => Err(denied()),
            _ => Ok(None),
        }
    }
    fn release(&mut self, id: u32, count: usize) -> capnp::Result<()> {
        let refs = self.ids.get_mut(&id).ok_or_else(denied)?;
        if count > *refs {
            return Err(denied());
        }
        *refs -= count;
        self.total -= count;
        if *refs == 0 {
            self.ids.remove(&id);
        }
        Ok(())
    }
    fn release_list(&mut self, ids: &[u32]) -> capnp::Result<()> {
        for id in ids {
            self.release(*id, 1)?;
        }
        Ok(())
    }
}
#[derive(Default)]
struct Call {
    returned: bool,
    finished: bool,
    release_results: bool,
    results: Vec<u32>,
}
#[derive(Default)]
struct Side {
    calls: HashMap<u32, Call>,
    caps: References,
    embargoes: HashSet<u32>,
}
impl Side {
    fn call(&mut self, id: u32, limit: usize) -> capnp::Result<()> {
        if self.calls.len() >= limit || self.calls.contains_key(&id) {
            return Err(denied());
        }
        self.calls.insert(id, Call::default());
        Ok(())
    }
    fn payload(
        &mut self,
        payload: capnp_rpc::rpc_capnp::payload::Reader<'_>,
        discard: bool,
    ) -> capnp::Result<Vec<u32>> {
        let descriptors = payload.get_cap_table()?;
        if descriptors.len() > MAX_DESCRIPTORS {
            return Err(denied());
        }
        let mut ids = Vec::new();
        if !discard {
            for descriptor in descriptors {
                if let Some(id) = self.caps.add(descriptor)? {
                    ids.push(id);
                }
            }
        }
        Ok(ids)
    }
}

pub struct Budget {
    peer: Side,
    local: Side,
    credit: f64,
    byte_credit: f64,
    updated: Instant,
}
fn denied() -> capnp::Error {
    capnp::Error::failed("RPC budget exceeded or invalid reply".into())
}
impl Budget {
    pub fn new() -> Self {
        Self {
            peer: Side::default(),
            local: Side::default(),
            credit: BURST,
            byte_credit: BYTE_BURST,
            updated: Instant::now(),
        }
    }
    // Include control frames. Byte credit also bounds sustained oversized work.
    pub fn frame(&mut self, bytes: usize) -> capnp::Result<()> {
        self.frame_at(bytes, Instant::now())
    }
    fn frame_at(&mut self, bytes: usize, now: Instant) -> capnp::Result<()> {
        let elapsed = now.saturating_duration_since(self.updated).as_secs_f64();
        self.credit = (self.credit + elapsed * 128.0).min(BURST);
        self.byte_credit = (self.byte_credit + elapsed * 1024.0 * 1024.0).min(BYTE_BURST);
        self.updated = now;
        if self.credit < 1.0 || self.byte_credit < bytes as f64 {
            return Err(denied());
        }
        self.credit -= 1.0;
        self.byte_credit -= bytes as f64;
        Ok(())
    }
    pub fn incoming(&mut self, root: message::Reader<'_>) -> capnp::Result<()> {
        Self::message(root, &mut self.peer, &mut self.local, true)
    }
    pub fn outgoing(&mut self, root: message::Reader<'_>) -> capnp::Result<()> {
        Self::message(root, &mut self.local, &mut self.peer, false)
    }
    fn message(
        root: message::Reader<'_>,
        sender: &mut Side,
        receiver: &mut Side,
        incoming: bool,
    ) -> capnp::Result<()> {
        match root.which()? {
            message::Call(call) => {
                let call = call?;
                sender.call(call.get_question_id(), if incoming { 128 } else { 64 })?;
                sender.payload(call.get_params()?, false)?;
            }
            message::Bootstrap(call) => {
                sender.call(call?.get_question_id(), if incoming { 128 } else { 64 })?
            }
            message::Return(ret) => {
                let ret = ret?;
                let id = ret.get_answer_id();
                // Validate IDs before capnp-rpc 0.25 indexes its question Vec.
                let call = receiver.calls.get_mut(&id).ok_or_else(denied)?;
                if call.returned {
                    return Err(denied());
                }
                call.returned = true;
                if let return_::Results(payload) = ret.which()? {
                    // The Rust runtime ignores results of already-canceled questions.
                    call.results = sender.payload(payload?, incoming && call.finished)?;
                }
                // Finish may arrive before a locally generated Return is forwarded.
                // capnp-rpc has already released these result exports in that case.
                if !incoming && call.finished && call.release_results {
                    sender.caps.release_list(&call.results)?;
                }
                // capnp-rpc 0.25 ignores incoming releaseParamCaps; never refund
                // those exports here. Explicit Release still decrements them.
                if call.finished || ret.get_no_finish_needed() {
                    receiver.calls.remove(&id);
                }
            }
            message::Finish(finish) => {
                let finish = finish?;
                let id = finish.get_question_id();
                if let Some(call) = sender.calls.get_mut(&id) {
                    if call.finished {
                        return Ok(());
                    }
                    call.finished = true;
                    call.release_results = finish.get_release_result_caps();
                    if incoming && call.returned && call.release_results {
                        receiver.caps.release_list(&call.results)?;
                    }
                    // An early Finish does not prove cancellation completed.
                    if call.returned {
                        sender.calls.remove(&id);
                    }
                }
                // Unknown Finish is legal after a noFinishNeeded return.
            }
            message::Release(release) => {
                let release = release?;
                receiver
                    .caps
                    .release(release.get_id(), release.get_reference_count() as usize)?;
            }
            message::Resolve(resolution) => {
                if let resolve::Cap(cap) = resolution?.which()? {
                    sender.caps.add(cap?)?;
                }
            }
            message::Disembargo(embargo) => match embargo?.get_context().which()? {
                disembargo::context::SenderLoopback(id) => {
                    if sender.embargoes.len() >= 64 || !sender.embargoes.insert(id) {
                        return Err(denied());
                    }
                }
                disembargo::context::ReceiverLoopback(id) => {
                    if !receiver.embargoes.remove(&id) {
                        return Err(denied());
                    }
                }
                _ => return Err(denied()),
            },
            message::Unimplemented(original) if incoming => {
                // The only optional message supported by capnp-rpc 0.25 is Resolve.
                if let message::Resolve(resolution) = original?.which()? {
                    if let resolve::Cap(cap) = resolution?.which()? {
                        match cap?.which()? {
                            cap_descriptor::SenderHosted(id)
                            | cap_descriptor::SenderPromise(id) => receiver.caps.release(id, 1)?,
                            _ => (),
                        }
                    }
                }
            }
            _ => (),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    type Message = capnp::message::Builder<capnp::message::HeapAllocator>;
    fn call(id: u32) -> Message {
        let mut message = Message::new_default();
        message
            .init_root::<message::Builder>()
            .init_call()
            .set_question_id(id);
        message
    }
    fn reply(id: u32, cap: Option<u32>, no_finish: bool) -> Message {
        let mut message = Message::new_default();
        let mut ret = message.init_root::<message::Builder>().init_return();
        ret.set_answer_id(id);
        ret.set_no_finish_needed(no_finish);
        let mut caps = ret
            .init_results()
            .init_cap_table(if cap.is_some() { 1 } else { 0 });
        if let Some(id) = cap {
            caps.reborrow().get(0).set_sender_hosted(id);
        }
        message
    }
    fn finish(id: u32, release: bool) -> Message {
        let mut message = Message::new_default();
        let mut finish = message.init_root::<message::Builder>().init_finish();
        finish.set_question_id(id);
        finish.set_release_result_caps(release);
        message
    }
    fn release(id: u32, count: u32) -> Message {
        let mut message = Message::new_default();
        let mut release = message.init_root::<message::Builder>().init_release();
        release.set_id(id);
        release.set_reference_count(count);
        message
    }
    #[test]
    fn unsolicited_and_duplicate_returns_are_rejected() {
        let mut budget = Budget::new();
        assert!(budget
            .incoming(reply(u32::MAX, None, false).get_root_as_reader().unwrap())
            .is_err());
        budget
            .outgoing(call(7).get_root_as_reader().unwrap())
            .unwrap();
        budget
            .incoming(reply(7, None, false).get_root_as_reader().unwrap())
            .unwrap();
        assert!(budget
            .incoming(reply(7, None, false).get_root_as_reader().unwrap())
            .is_err());
    }
    #[test]
    fn long_lived_traffic_reuses_completed_calls_and_capabilities() {
        let mut budget = Budget::new();
        let now = budget.updated;
        for i in 0..10000 {
            // More than the former call, cap, frame, byte, and hourly quotas.
            budget.frame_at(2048, now + Duration::from_secs(i)).unwrap();
            budget
                .incoming(call(0).get_root_as_reader().unwrap())
                .unwrap();
            budget
                .outgoing(reply(0, Some(42), false).get_root_as_reader().unwrap())
                .unwrap();
            budget
                .incoming(finish(0, false).get_root_as_reader().unwrap())
                .unwrap();
            budget
                .incoming(release(42, 1).get_root_as_reader().unwrap())
                .unwrap();
            budget
                .outgoing(call(0).get_root_as_reader().unwrap())
                .unwrap();
            budget
                .incoming(reply(0, Some(99), false).get_root_as_reader().unwrap())
                .unwrap();
            budget
                .outgoing(finish(0, false).get_root_as_reader().unwrap())
                .unwrap();
            budget
                .outgoing(release(99, 1).get_root_as_reader().unwrap())
                .unwrap();
        }
        assert_eq!(budget.local.caps.total, 0);
        assert_eq!(budget.peer.caps.total, 0);
        assert!(budget.local.calls.is_empty() && budget.peer.calls.is_empty());
    }
    #[test]
    fn finish_waits_for_return_and_releases_results_exactly_once() {
        for early in [false, true] {
            let mut budget = Budget::new();
            budget
                .incoming(call(3).get_root_as_reader().unwrap())
                .unwrap();
            if early {
                budget
                    .incoming(finish(3, true).get_root_as_reader().unwrap())
                    .unwrap();
                assert_eq!(budget.peer.calls.len(), 1);
            }
            budget
                .outgoing(reply(3, Some(8), false).get_root_as_reader().unwrap())
                .unwrap();
            budget
                .incoming(finish(3, true).get_root_as_reader().unwrap())
                .unwrap();
            budget
                .incoming(finish(3, true).get_root_as_reader().unwrap())
                .unwrap();
            assert_eq!(budget.local.caps.total, 0);
            assert!(budget.peer.calls.is_empty());
            assert!(budget
                .incoming(release(8, 1).get_root_as_reader().unwrap())
                .is_err());
        }
    }
    #[test]
    fn canceled_outbound_call_accepts_one_late_reply_without_importing_caps() {
        let mut budget = Budget::new();
        budget
            .outgoing(call(7).get_root_as_reader().unwrap())
            .unwrap();
        budget
            .outgoing(finish(7, true).get_root_as_reader().unwrap())
            .unwrap();
        budget
            .incoming(reply(7, Some(9), false).get_root_as_reader().unwrap())
            .unwrap();
        assert_eq!(budget.peer.caps.total, 0);
        assert!(budget.local.calls.is_empty());
        assert!(budget
            .incoming(reply(7, None, false).get_root_as_reader().unwrap())
            .is_err());
    }
    #[test]
    fn no_finish_returns_and_unknown_finish_do_not_refund_other_calls() {
        let mut budget = Budget::new();
        budget
            .incoming(call(0).get_root_as_reader().unwrap())
            .unwrap();
        budget
            .outgoing(reply(0, None, true).get_root_as_reader().unwrap())
            .unwrap();
        assert!(budget.peer.calls.is_empty());
        budget
            .incoming(call(1).get_root_as_reader().unwrap())
            .unwrap();
        budget
            .incoming(finish(0, true).get_root_as_reader().unwrap())
            .unwrap();
        assert_eq!(budget.peer.calls.len(), 1);
    }
    #[test]
    fn retained_calls_caps_and_bursts_are_bounded() {
        let mut budget = Budget::new();
        for id in 0..128 {
            budget
                .incoming(call(id).get_root_as_reader().unwrap())
                .unwrap();
            budget
                .incoming(finish(id, true).get_root_as_reader().unwrap())
                .unwrap();
        }
        assert!(budget
            .incoming(call(128).get_root_as_reader().unwrap())
            .is_err());
        let mut budget = Budget::new();
        for _ in 0..MAX_CAPS {
            budget
                .incoming(call(0).get_root_as_reader().unwrap())
                .unwrap();
            budget
                .outgoing(reply(0, Some(42), false).get_root_as_reader().unwrap())
                .unwrap();
            budget
                .incoming(finish(0, false).get_root_as_reader().unwrap())
                .unwrap();
        }
        budget
            .incoming(call(0).get_root_as_reader().unwrap())
            .unwrap();
        assert!(budget
            .outgoing(reply(0, Some(42), false).get_root_as_reader().unwrap())
            .is_err());
        assert!(Budget::new().frame(BYTE_BURST as usize + 1).is_err());
        let mut budget = Budget::new();
        let now = budget.updated;
        for _ in 0..BURST as usize {
            budget.frame_at(1, now).unwrap();
        }
        assert!(budget.frame_at(1, now).is_err());
        assert!(budget.frame_at(1, now + Duration::from_secs(1)).is_ok());
    }
    #[test]
    fn descriptors_are_bounded_and_partial_releases_are_counted() {
        let mut budget = Budget::new();
        let mut message = call(0);
        message
            .get_root::<message::Builder>()
            .unwrap()
            .init_call()
            .init_params()
            .init_cap_table(33);
        assert!(budget
            .incoming(message.get_root_as_reader().unwrap())
            .is_err());
        let mut budget = Budget::new();
        for id in [0, 1] {
            let mut message = call(id);
            let mut root = message.get_root::<message::Builder>().unwrap().init_call();
            root.set_question_id(id);
            root.init_params()
                .init_cap_table(1)
                .get(0)
                .set_sender_hosted(5);
            budget
                .incoming(message.get_root_as_reader().unwrap())
                .unwrap();
        }
        budget
            .outgoing(release(5, 1).get_root_as_reader().unwrap())
            .unwrap();
        assert_eq!(budget.peer.caps.total, 1);
        assert!(budget
            .outgoing(release(5, 2).get_root_as_reader().unwrap())
            .is_err());
    }
    #[test]
    fn resolutions_and_unimplemented_resolutions_account_for_references() {
        let mut budget = Budget::new();
        let mut resolution = Message::new_default();
        resolution
            .init_root::<message::Builder>()
            .init_resolve()
            .init_cap()
            .set_sender_hosted(5);
        budget
            .outgoing(resolution.get_root_as_reader().unwrap())
            .unwrap();
        assert_eq!(budget.local.caps.total, 1);
        let mut rejected = Message::new_default();
        rejected
            .init_root::<message::Builder>()
            .set_unimplemented(resolution.get_root_as_reader().unwrap())
            .unwrap();
        budget
            .incoming(rejected.get_root_as_reader().unwrap())
            .unwrap();
        assert_eq!(budget.local.caps.total, 0);
        assert!(budget
            .incoming(rejected.get_root_as_reader().unwrap())
            .is_err());
    }
    #[test]
    fn embargoes_and_outbound_questions_have_live_limits() {
        let mut budget = Budget::new();
        for id in 0..64 {
            budget
                .outgoing(call(id).get_root_as_reader().unwrap())
                .unwrap();
        }
        assert!(budget
            .outgoing(call(64).get_root_as_reader().unwrap())
            .is_err());
        let mut budget = Budget::new();
        let mut request = Message::new_default();
        request
            .init_root::<message::Builder>()
            .init_disembargo()
            .init_context()
            .set_sender_loopback(0);
        let mut response = Message::new_default();
        response
            .init_root::<message::Builder>()
            .init_disembargo()
            .init_context()
            .set_receiver_loopback(0);
        for _ in 0..1000 {
            budget
                .outgoing(request.get_root_as_reader().unwrap())
                .unwrap();
            budget
                .incoming(response.get_root_as_reader().unwrap())
                .unwrap();
            budget
                .incoming(request.get_root_as_reader().unwrap())
                .unwrap();
            budget
                .outgoing(response.get_root_as_reader().unwrap())
                .unwrap();
        }
        assert!(budget
            .incoming(response.get_root_as_reader().unwrap())
            .is_err());
        assert!(budget.local.embargoes.is_empty() && budget.peer.embargoes.is_empty());
    }
    #[test]
    fn byte_credit_replenishes_without_a_lifetime_allowance() {
        let mut budget = Budget::new();
        let now = budget.updated;
        budget.frame_at(BYTE_BURST as usize, now).unwrap();
        assert!(budget.frame_at(1, now).is_err());
        budget
            .frame_at(1024 * 1024, now + Duration::from_secs(1))
            .unwrap();
        assert!(budget.frame_at(1, now + Duration::from_secs(1)).is_err());
    }
}

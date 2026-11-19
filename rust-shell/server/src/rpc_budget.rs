//! Admission before handing untrusted messages to capnp-rpc. These are lifetime
//! budgets, deliberately not replenished by Finish/Release supplied by a peer.
use capnp_rpc::rpc_capnp::{message, return_};
use std::{collections::HashSet, time::Instant};

const MAX_MESSAGES: usize = 8192;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_CALLS: usize = 1024;
const MAX_CAPS: usize = 1024;
const BURST: f64 = 512.0;

pub struct Budget {
    messages: usize,
    bytes: usize,
    calls: usize,
    caps: usize,
    credit: f64,
    updated: Instant,
    questions: HashSet<u32>,
}

fn denied() -> capnp::Error {
    capnp::Error::failed("RPC budget exceeded or invalid reply".into())
}

impl Budget {
    pub fn new() -> Self {
        Self {
            messages: 0,
            bytes: 0,
            calls: 0,
            caps: 0,
            credit: BURST,
            updated: Instant::now(),
            questions: HashSet::new(),
        }
    }

    // Include ping/pong frames: a valid control frame is still work.
    pub fn frame(&mut self, bytes: usize) -> capnp::Result<()> {
        self.frame_at(bytes, Instant::now())
    }

    fn frame_at(&mut self, bytes: usize, now: Instant) -> capnp::Result<()> {
        self.credit =
            (self.credit + now.duration_since(self.updated).as_secs_f64() * 128.0).min(BURST);
        self.updated = now;
        self.messages += 1;
        self.bytes = self.bytes.checked_add(bytes).ok_or_else(denied)?;
        if self.messages > MAX_MESSAGES || self.bytes > MAX_BYTES || self.credit < 1.0 {
            return Err(denied());
        }
        self.credit -= 1.0;
        Ok(())
    }

    pub fn incoming(&mut self, root: message::Reader<'_>) -> capnp::Result<()> {
        let caps = match root.which()? {
            message::Call(call) => {
                self.calls += 1;
                call?.get_params()?.get_cap_table()?.len() as usize
            }
            message::Bootstrap(_) => {
                self.calls += 1;
                0
            }
            message::Return(ret) => {
                let ret = ret?;
                // capnp-rpc 0.25.1 indexes a Vec with this ID. Reject unsolicited
                // and duplicate returns. Keep IDs across Finish so one late reply
                // to a canceled call remains legal.
                if !self.questions.remove(&ret.get_answer_id()) {
                    return Err(denied());
                }
                match ret.which()? {
                    return_::Results(payload) => payload?.get_cap_table()?.len() as usize,
                    _ => 0,
                }
            }
            message::Resolve(_) => 1,
            _ => 0,
        };
        // Check the list length before the RPC library materializes descriptors.
        if caps > 32 {
            return Err(denied());
        }
        self.caps += caps;
        if self.calls > MAX_CALLS || self.caps > MAX_CAPS {
            return Err(denied());
        }
        Ok(())
    }

    pub fn outgoing(&mut self, root: message::Reader<'_>) -> capnp::Result<()> {
        let id = match root.which()? {
            message::Call(call) => Some(call?.get_question_id()),
            message::Bootstrap(call) => Some(call?.get_question_id()),
            _ => None,
        };
        if let Some(id) = id {
            if self.questions.len() >= 64 || !self.questions.insert(id) {
                return Err(denied());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsolicited_and_duplicate_returns_are_rejected() {
        let mut budget = Budget::new();
        let mut reply = capnp::message::Builder::new_default();
        reply
            .init_root::<message::Builder>()
            .init_return()
            .set_answer_id(u32::MAX);
        assert!(budget
            .incoming(reply.get_root_as_reader().unwrap())
            .is_err());
        let mut call = capnp::message::Builder::new_default();
        call.init_root::<message::Builder>()
            .init_call()
            .set_question_id(7);
        budget.outgoing(call.get_root_as_reader().unwrap()).unwrap();
        reply
            .init_root::<message::Builder>()
            .init_return()
            .set_answer_id(7);
        assert!(budget.incoming(reply.get_root_as_reader().unwrap()).is_ok());
        assert!(budget
            .incoming(reply.get_root_as_reader().unwrap())
            .is_err());
    }

    #[test]
    fn budgets_bound_retained_state_and_bursts() {
        let mut budget = Budget::new();
        let mut call = capnp::message::Builder::new_default();
        call.init_root::<message::Builder>()
            .init_call()
            .init_params()
            .init_cap_table(33);
        assert!(budget.incoming(call.get_root_as_reader().unwrap()).is_err());
        call.init_root::<message::Builder>().init_bootstrap();
        let mut budget = Budget::new();
        for _ in 0..MAX_CALLS {
            budget.incoming(call.get_root_as_reader().unwrap()).unwrap();
        }
        assert!(budget.incoming(call.get_root_as_reader().unwrap()).is_err());
        assert!(Budget::new().frame(MAX_BYTES + 1).is_err());
        let mut budget = Budget::new();
        let now = budget.updated;
        for _ in 0..BURST as usize {
            budget.frame_at(1, now).unwrap();
        }
        assert!(budget.frame_at(1, now).is_err());
    }
}

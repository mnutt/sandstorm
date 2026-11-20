//! Protocol integrity checks for capnp-rpc 0.25.1. No throughput or live-state quotas.
use capnp_rpc::rpc_capnp::message;
use std::collections::HashSet;

pub struct Protocol {
    awaiting_return: HashSet<u32>,
}
impl Protocol {
    pub fn new() -> Self {
        Self {
            awaiting_return: HashSet::new(),
        }
    }
    pub fn incoming(&mut self, root: message::Reader<'_>) -> capnp::Result<()> {
        if let message::Return(ret) = root.which()? {
            // The pinned runtime indexes a Vec with this peer-supplied ID.
            // Retain canceled questions until their one permitted late reply.
            if !self.awaiting_return.remove(&ret?.get_answer_id()) {
                return Err(capnp::Error::failed(
                    "Unexpected or duplicate RPC return".into(),
                ));
            }
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
            if !self.awaiting_return.insert(id) {
                return Err(capnp::Error::failed(
                    "Duplicate outstanding RPC question".into(),
                ));
            }
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replies_are_validated_without_a_question_quota() {
        let mut protocol = Protocol::new();
        for id in 0..2048 {
            let mut call = capnp::message::Builder::new_default();
            call.init_root::<message::Builder>()
                .init_call()
                .set_question_id(id);
            protocol
                .outgoing(call.get_root_as_reader().unwrap())
                .unwrap();
        }
        let mut finish = capnp::message::Builder::new_default();
        finish
            .init_root::<message::Builder>()
            .init_finish()
            .set_question_id(0);
        protocol
            .outgoing(finish.get_root_as_reader().unwrap())
            .unwrap();
        for id in 0..2048 {
            let mut reply = capnp::message::Builder::new_default();
            reply
                .init_root::<message::Builder>()
                .init_return()
                .set_answer_id(id);
            protocol
                .incoming(reply.get_root_as_reader().unwrap())
                .unwrap();
            assert!(protocol
                .incoming(reply.get_root_as_reader().unwrap())
                .is_err());
        }
        let mut forged = capnp::message::Builder::new_default();
        forged
            .init_root::<message::Builder>()
            .init_return()
            .set_answer_id(u32::MAX);
        assert!(protocol
            .incoming(forged.get_root_as_reader().unwrap())
            .is_err());
    }
}

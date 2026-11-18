use axum::extract::ws::{Message, WebSocket};
use capnp::message::ReaderOptions;
use capnp_rpc::{rpc_twoparty_capnp, twoparty, RpcSystem};
use futures::{SinkExt, StreamExt};
use std::{path::PathBuf, rc::Rc};
use tokio::io::AsyncWriteExt;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

pub const MAX_MESSAGE: usize = 256 * 1024;

pub(crate) fn options() -> ReaderOptions {
    ReaderOptions {
        traversal_limit_in_words: Some(MAX_MESSAGE / 8),
        nesting_limit: 32,
    }
}

// One unpacked Cap'n Proto message (including its segment table) per WS message.
// Validate before forwarding: a tiny frame must not request an enormous allocation.
fn validate_frame(bytes: &[u8]) -> capnp::Result<()> {
    if bytes.len() > MAX_MESSAGE {
        return Err(capnp::Error::failed("message too large".into()));
    }
    let mut remaining = bytes;
    capnp::serialize::read_message_from_flat_slice(&mut remaining, options())?;
    if !remaining.is_empty() {
        return Err(capnp::Error::failed("expected exactly one message".into()));
    }
    Ok(())
}

pub async fn serve(
    socket: WebSocket,
    fixture_socket: Option<PathBuf>,
    session: Option<crate::bridge::Session>,
) {
    let initial = if let Some(session) = &session {
        match session.snapshot().await {
            Ok(value) => Some(value),
            Err(_) => return,
        }
    } else {
        None
    };
    let (mut ws_out, mut ws_in) = socket.split();
    let (rpc_io, bridge_io) = tokio::io::duplex(64 * 1024);
    let (rpc_read, rpc_write) = tokio::io::split(rpc_io);
    let (bridge_read, mut bridge_write) = tokio::io::split(bridge_io);
    let network = twoparty::VatNetwork::new(
        rpc_read.compat(),
        rpc_write.compat_write(),
        rpc_twoparty_capnp::Side::Server,
        options(),
    );
    let link = Rc::new(crate::interop::Link::new(fixture_socket));
    let _scope = link.scope();
    let service = crate::service::Shell::new(link.clone(), session, initial);
    let bootstrap: crate::shell_capnp::shell::Client = capnp_rpc::new_client(service.clone());
    let rpc = RpcSystem::new(Box::new(network), Some(bootstrap.client));
    let incoming = async {
        while let Some(Ok(message)) = ws_in.next().await {
            match message {
                Message::Binary(bytes) => {
                    if validate_frame(&bytes).is_err()
                        || bridge_write.write_all(&bytes).await.is_err()
                    {
                        break;
                    }
                }
                Message::Ping(_) | Message::Pong(_) => {}
                _ => break,
            }
        }
    };
    let outgoing = async {
        let mut input = bridge_read.compat();
        while let Ok(message) = capnp_futures::serialize::read_message(&mut input, options()).await
        {
            let bytes = capnp::serialize::write_message_segments_to_words(message.get_segments());
            if bytes.len() > MAX_MESSAGE
                || ws_out.send(Message::Binary(bytes.into())).await.is_err()
            {
                break;
            }
        }
    };
    // Dropping any one future drops the RPC system, capabilities and both IO halves.
    tokio::select! {
        _ = rpc => {},
        _ = incoming => {},
        _ = outgoing => {},
        _ = service.synchronize() => {},
        _ = tokio::time::sleep(std::time::Duration::from_secs(3600)) => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_boundaries_and_limits() {
        let mut message = capnp::message::Builder::new_default();
        message.set_root("hello").unwrap();
        let bytes = capnp::serialize::write_message_to_words(&message);
        assert!(validate_frame(&bytes).is_ok());
        assert!(validate_frame(&bytes[..bytes.len() - 1]).is_err());
        assert!(validate_frame(&[bytes.clone(), bytes].concat()).is_err());
        assert!(validate_frame(&[0xff; 8]).is_err());
        assert!(validate_frame(&vec![0; MAX_MESSAGE + 1]).is_err());
        // Two segments, including the segment table padding word.
        let segmented = [1_u32, 1, 1, 0, 0, 0, 0, 0]
            .into_iter()
            .flat_map(u32::to_le_bytes)
            .collect::<Vec<_>>();
        assert!(validate_frame(&segmented).is_ok());
    }
}

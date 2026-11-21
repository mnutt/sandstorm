use axum::extract::ws::{Message, WebSocket};
use capnp::message::ReaderOptions;
use capnp_rpc::{rpc_twoparty_capnp, twoparty, RpcSystem};
use futures::{SinkExt, StreamExt};
use std::{cell::RefCell, path::PathBuf, rc::Rc};
use tokio::io::AsyncWriteExt;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

// Match Meteor's default SockJS/faye websocket-driver MAX_LENGTH.
pub const MAX_MESSAGE: usize = 0x3ffffff;

pub(crate) fn options() -> ReaderOptions {
    ReaderOptions::new()
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

fn admit_frame(bytes: &[u8], protocol: &mut crate::rpc_protocol::Protocol) -> capnp::Result<()> {
    validate_frame(bytes)?;
    // WebSocket Bytes may be unaligned; inspect aligned storage. Validate the
    // segment table against the frame first, before allocating that storage.
    let message = capnp::serialize::read_message(std::io::Cursor::new(bytes), options())?;
    protocol.incoming(message.get_root()?)
}

pub async fn serve(
    socket: WebSocket,
    fixture_socket: Option<PathBuf>,
    session: Option<crate::session::Session>,
) {
    let initial = if let Some(session) = &session {
        match session.snapshot().await {
            Ok(value) => Some(value),
            Err(_) => return,
        }
    } else {
        None
    };
    let link = Rc::new(crate::interop::Link::new(fixture_socket));
    let _scope = link.scope();
    let Ok(service) = crate::service::Shell::new(link.clone(), session, initial) else {
        return;
    };
    let bootstrap: crate::shell_capnp::shell::Client = capnp_rpc::new_client(service.clone());
    let maintain = async {
        if let Some(scope) = &service.grain {
            scope.maintain().await;
        } else {
            std::future::pending::<()>().await;
        }
    };
    serve_rpc(socket, bootstrap.client, service.synchronize(), maintain).await;
    service.observations.close();
    if let Some(scope) = &service.grain {
        scope.close_all().await;
    }
}

pub async fn serve_shared(
    socket: WebSocket,
    bridge: crate::bridge::Bridge,
    account: Option<crate::session::Session>,
) {
    let Ok(service) = crate::shared::SharedShell::new(bridge, account) else {
        return;
    };
    let bootstrap: crate::shell_capnp::shared_shell::Client =
        capnp_rpc::new_client(service.clone());
    serve_rpc(
        socket,
        bootstrap.client,
        std::future::pending::<()>(),
        service.maintain(),
    )
    .await;
    service.close().await;
}

async fn serve_rpc(
    socket: WebSocket,
    bootstrap: capnp::capability::Client,
    synchronize: impl std::future::Future<Output = ()>,
    maintain: impl std::future::Future<Output = ()>,
) {
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
    let rpc = RpcSystem::new(Box::new(network), Some(bootstrap));
    let protocol = RefCell::new(crate::rpc_protocol::Protocol::new());
    let incoming = async {
        while let Some(Ok(message)) = ws_in.next().await {
            match message {
                Message::Binary(bytes) => {
                    let accepted = admit_frame(&bytes, &mut protocol.borrow_mut());
                    if accepted.is_err() {
                        break;
                    }
                    if bridge_write.write_all(&bytes).await.is_err() {
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
            let accepted = message
                .get_root()
                .and_then(|root| protocol.borrow_mut().outgoing(root));
            if accepted.is_err() {
                break;
            }
            let bytes = capnp::serialize::write_message_segments_to_words(message.get_segments());
            if ws_out.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
    };
    // Dropping any one future drops the RPC system, capabilities and both IO halves.
    tokio::select! {
        _ = rpc => {},
        _ = incoming => {},
        _ = outgoing => {},
        _ = synchronize => {},
        _ = maintain => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unaligned_websocket_envelopes_are_validated_safely() {
        let mut message = capnp::message::Builder::new_default();
        message
            .init_root::<capnp_rpc::rpc_capnp::message::Builder>()
            .init_bootstrap();
        let bytes = capnp::serialize::write_message_to_words(&message);
        let mut unaligned = vec![0];
        unaligned.extend_from_slice(&bytes);
        assert!(admit_frame(&unaligned[1..], &mut crate::rpc_protocol::Protocol::new()).is_ok());
    }

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
        // Valid messages above the original 256 KiB spike ceiling are accepted.
        let mut large = capnp::message::Builder::new_default();
        large.set_root("x".repeat(1024 * 1024).as_str()).unwrap();
        assert!(validate_frame(&capnp::serialize::write_message_to_words(&large)).is_ok());
        // Two segments, including the segment table padding word.
        let segmented = [1_u32, 1, 1, 0, 0, 0, 0, 0]
            .into_iter()
            .flat_map(u32::to_le_bytes)
            .collect::<Vec<_>>();
        assert!(validate_frame(&segmented).is_ok());
    }
}

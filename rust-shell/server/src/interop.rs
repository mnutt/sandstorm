use crate::fixture_capnp::fixture;
use capnp_rpc::{rpc_twoparty_capnp, twoparty, RpcSystem};
use std::{cell::Cell, path::PathBuf, rc::Rc, time::Duration};
use tokio::{net::UnixStream, sync::OnceCell, task::JoinHandle};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

struct Connection {
    client: fixture::Client,
    task: JoinHandle<()>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.task.abort();
    }
}

// One lazy C++ connection per browser connection. Its lifetime is owned by the
// WebSocket task, so releasing the Shell bootstrap cannot orphan a backend task.
pub struct Link {
    path: Option<PathBuf>,
    connection: OnceCell<Connection>,
    closed: Cell<bool>,
}

pub struct Scope(Rc<Link>);

impl Drop for Scope {
    fn drop(&mut self) {
        // Forwarded capabilities may still hold RPC references. End the Unix
        // connection explicitly, including when the WebSocket task is aborted.
        self.0.closed.set(true);
        if let Some(connection) = self.0.connection.get() {
            connection.task.abort();
        }
    }
}

impl Link {
    pub fn scope(self: &Rc<Self>) -> Scope {
        Scope(self.clone())
    }

    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            path,
            connection: OnceCell::new(),
            closed: Cell::new(false),
        }
    }

    pub async fn client(&self) -> capnp::Result<fixture::Client> {
        if self.closed.get() {
            return Err(capnp::Error::disconnected(
                "browser connection ended".into(),
            ));
        }
        let path = self.path.as_ref().ok_or_else(|| {
            capnp::Error::failed("C++ fixture disabled: set RUST_SHELL_FIXTURE_SOCKET".into())
        })?;
        let connection = self
            .connection
            .get_or_try_init(|| async {
                let stream =
                    tokio::time::timeout(Duration::from_secs(2), UnixStream::connect(path))
                        .await
                        .map_err(|_| {
                            capnp::Error::failed("C++ fixture connection timed out".into())
                        })?
                        .map_err(|error| {
                            capnp::Error::failed(format!("C++ fixture unavailable: {error}"))
                        })?;
                if self.closed.get() {
                    return Err(capnp::Error::disconnected(
                        "browser connection ended".into(),
                    ));
                }
                let (read, write) = stream.into_split();
                let network = twoparty::VatNetwork::new(
                    read.compat(),
                    write.compat_write(),
                    rpc_twoparty_capnp::Side::Client,
                    crate::transport::options(),
                );
                let mut rpc = RpcSystem::new(Box::new(network), None);
                let client = rpc.bootstrap(rpc_twoparty_capnp::Side::Server);
                let task = tokio::task::spawn_local(async move {
                    if let Err(error) = rpc.await {
                        eprintln!("C++ fixture RPC ended: {error}");
                    }
                });
                Ok::<_, capnp::Error>(Connection { client, task })
            })
            .await?;
        // Do not silently reconnect an existing capability after backend failure.
        // A fresh browser connection establishes fresh fixture authority.
        Ok(connection.client.clone())
    }
}

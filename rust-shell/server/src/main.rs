mod auth;
mod bridge;
mod grain;
mod interop;
mod service;
mod transport;

pub mod shell_capnp {
    include!(concat!(env!("OUT_DIR"), "/shell_capnp.rs"));
}
pub mod fixture_capnp {
    include!(concat!(env!("OUT_DIR"), "/fixture_capnp.rs"));
}

use axum::{
    extract::{ws::WebSocketUpgrade, DefaultBodyLimit, State},
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Router,
};
use std::{net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

type Connection = (
    axum::extract::ws::WebSocket,
    OwnedSemaphorePermit,
    Option<bridge::Session>,
);

enum Listener {
    Tcp(tokio::net::TcpListener),
    Unix(tokio::net::UnixListener),
}

fn proxy_host(origin: &str) -> Result<String, Box<dyn std::error::Error>> {
    let uri: Uri = origin.parse()?;
    let authority = uri.authority().ok_or("RUST_SHELL_ORIGIN needs a host")?;
    if uri.scheme_str() != Some("https")
        || authority.as_str().contains('@')
        || uri.path_and_query().is_some_and(|p| p.as_str() != "/")
        || origin.ends_with('/')
    {
        return Err("RUST_SHELL_ORIGIN must be an https origin without a path".into());
    }
    Ok(authority.to_string())
}

async fn shutdown() {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("install SIGTERM handler");
    tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
}

#[derive(Clone)]
struct AppState {
    auth: auth::Auth,
    origin: String,
    host: String,
    sockets: mpsc::Sender<Connection>,
    permits: Arc<Semaphore>,
}

async fn upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // Host is checked as well as Origin to reject loopback DNS rebinding.
    if headers.get(header::HOST).and_then(|v| v.to_str().ok()) != Some(&state.host)
        || headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(&state.origin)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(permit) = state.permits.try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let session = if state.auth.bridge.is_some() {
        let Some(session) = auth::session(&state.auth, &headers) else {
            return StatusCode::UNAUTHORIZED.into_response();
        };
        if let Err(error) = session.call("session", serde_json::json!({})).await {
            return auth::error(error);
        }
        Some(session)
    } else {
        None
    };
    ws.max_message_size(transport::MAX_MESSAGE)
        .max_frame_size(transport::MAX_MESSAGE)
        .on_upgrade(move |socket| async move {
            let _ = state.sockets.send((socket, permit, session)).await;
        })
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let assets = std::env::var_os("RUST_SHELL_ASSETS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../frontend/dist"));
    if !assets.join("index.html").is_file() {
        return Err("frontend missing: run npm ci && npm run build in rust-shell/frontend".into());
    }
    let (listener, host, origin) = if let Some(socket) = std::env::var_os("RUST_SHELL_SOCKET") {
        use std::os::unix::fs::PermissionsExt;
        let origin = std::env::var("RUST_SHELL_ORIGIN")?;
        let host = proxy_host(&origin)?;
        // The supervisor owns stale-socket cleanup. Never unlink another listener here.
        let listener = tokio::net::UnixListener::bind(&socket)?;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
        (Listener::Unix(listener), host, origin)
    } else {
        let addr: SocketAddr = std::env::var("RUST_SHELL_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:6082".into())
            .parse()?;
        if !addr.ip().is_loopback() {
            return Err("the fixture shell must bind to a loopback address".into());
        }
        let listener = tokio::net::TcpListener::bind(addr).await?;
        let host = listener.local_addr()?.to_string();
        let origin = format!("http://{host}");
        (Listener::Tcp(listener), host, origin)
    };
    let fixture_socket = std::env::var_os("RUST_SHELL_FIXTURE_SOCKET")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let (sockets, mut receiver) = mpsc::channel::<Connection>(16);
    let main_url = std::env::var("RUST_SHELL_MAIN_URL")
        .unwrap_or_else(|_| "http://sandstorm.localhost:6080".into());
    let bridge = std::env::var_os("RUST_SHELL_BRIDGE_SOCKET")
        .filter(|v| !v.is_empty())
        .map(|path| bridge::Bridge::new(PathBuf::from(path)))
        .transpose()?;
    if bridge.is_some() && !origin.starts_with("https://") {
        return Err("The authenticated bridge requires an HTTPS origin behind the gateway".into());
    }
    let fixture = bridge.is_none();
    let state = AppState {
        auth: auth::Auth {
            bridge,
            main_origin: reqwest::Url::parse(&main_url)?
                .origin()
                .ascii_serialization(),
            main_url: main_url.clone(),
        },
        origin: origin.clone(),
        host,
        sockets,
        permits: Arc::new(Semaphore::new(16)),
    };
    let index = ServeFile::new(assets.join("index.html"));
    let app = Router::new()
        .route_service("/notifications", index.clone())
        .route_service("/grains", index.clone())
        .route_service("/apps", index.clone())
        .route_service("/account", index.clone())
        .route_service("/grain/{id}", index.clone())
        .route_service("/grain/{id}/", index.clone())
        .route_service("/grain/{id}/{*path}", index)
        .route("/healthz", get(move || async move { if fixture { "rust-shell fixture spike\n" } else { "rust-shell authenticated bridge\n" } }))
        .route("/auth/session", get(auth::status))
        .route("/auth/start", get(auth::start))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/main-shell", get(move || {
            let url = main_url.clone();
            async move { Redirect::temporary(&url) }
        }))
        .route("/rpc", get(upgrade))
        .fallback_service(ServeDir::new(assets))
        .with_state(state)
        .layer(DefaultBodyLimit::max(4096))
        .layer(SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-store")))
        .layer(SetResponseHeaderLayer::overriding(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")))
        .layer(axum::middleware::from_fn(|request: axum::http::Request<axum::body::Body>, next: axum::middleware::Next| async move {
            let policy = if request.uri().path() == "/offer-template.html" {
                "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src https:; frame-ancestors https:"
            } else {
                "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; frame-src https:; frame-ancestors 'none'"
            };
            let mut response = next.run(request).await;
            response.headers_mut().insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(policy));
            response
        }))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"),
        ));
    eprintln!(
        "Rust shell: {origin} ({}; Ctrl-C to stop)",
        if fixture {
            "fixture data only"
        } else {
            "Meteor notification bridge"
        }
    );
    // Axum hands Send sockets to this LocalSet; all capability state stays local.
    tokio::task::LocalSet::new()
        .run_until(async move {
            let server = async move {
                match listener {
                    Listener::Tcp(listener) => {
                        axum::serve(listener, app)
                            .with_graceful_shutdown(shutdown())
                            .await
                    }
                    Listener::Unix(listener) => {
                        axum::serve(listener, app)
                            .with_graceful_shutdown(shutdown())
                            .await
                    }
                }
            };
            tokio::pin!(server);
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    result = &mut server => { result?; break; }
                    Some((socket, permit, session)) = receiver.recv() => {
                        let fixture_socket = fixture_socket.clone();
                        connections.spawn_local(async move {
                            let _permit = permit;
                            transport::serve(socket, fixture_socket, session).await;
                        });
                    }
                    Some(_) = connections.join_next(), if !connections.is_empty() => {}
                }
            }
            connections.abort_all();
            while connections.join_next().await.is_some() {}
            Ok::<_, std::io::Error>(())
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::proxy_host;

    #[test]
    fn proxy_origin_is_exact_https_authority() {
        assert_eq!(
            proxy_host("https://example.test:7443").unwrap(),
            "example.test:7443"
        );
        assert_eq!(proxy_host("https://[::1]:7443").unwrap(), "[::1]:7443");
        for invalid in [
            "http://example.test",
            "https://user@example.test",
            "https://example.test/",
            "https://example.test/path",
            "https://example.test?x=1",
        ] {
            assert!(proxy_host(invalid).is_err(), "{invalid}");
        }
    }
}

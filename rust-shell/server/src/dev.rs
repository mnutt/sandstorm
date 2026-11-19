//! Opt-in, same-origin frontend development proxy. API routes never reach Vite.
use axum::{
    extract::{
        ws::{Message, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use futures::{SinkExt, StreamExt};
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, protocol::WebSocketConfig, Message as UpstreamMessage,
};

#[derive(Clone)]
pub struct Frontend {
    port: u16,
    origin: String,
    client: reqwest::Client,
    sockets: Arc<Semaphore>,
    requests: Arc<Semaphore>,
}

impl Frontend {
    pub fn new(port: u16, origin: String) -> Result<Self, reqwest::Error> {
        Ok(Self {
            port,
            origin,
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(15))
                .build()?,
            sockets: Arc::new(Semaphore::new(16)),
            requests: Arc::new(Semaphore::new(32)),
        })
    }
}

fn unavailable() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE,
        "Rust shell development server unavailable. Run make -C rust-shell dev in the checkout, then reload.\n").into_response()
}

pub async fn frontend(State(dev): State<Frontend>, method: Method, uri: Uri) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    // Vite also has developer-control endpoints (for example opening an editor).
    // Expose frontend files and pages, not those controls, through the public origin.
    let path = uri.path();
    if !(matches!(
        path,
        "/" | "/index.html"
            | "/notifications"
            | "/grains"
            | "/apps"
            | "/account"
            | "/install"
            | "/sandstorm-logo.svg"
            | "/favicon.ico"
    ) || [
        "/apps/",
        "/grain/",
        "/shared/",
        "/install/",
        "/src/",
        "/node_modules/",
        "/@vite/",
        "/@id/",
        "/@fs/",
    ]
    .iter()
    .any(|prefix| path.starts_with(prefix)))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(_permit) = dev.requests.try_acquire() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    // Fixed loopback destination; do not forward credentials, cookies, or browser-supplied hosts.
    let url = format!(
        "http://127.0.0.1:{}{}",
        dev.port,
        uri.path_and_query().map(|v| v.as_str()).unwrap_or("/")
    );
    let Ok(url) = reqwest::Url::parse(&url) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    // URL parsing removes dot segments, including encoded ones. Never allow that
    // normalization to turn an allowed asset path into a developer-control route.
    if url.path() != path {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(mut upstream) = dev.client.request(method, url).send().await else {
        return unavailable();
    };
    // Do not let a dev plugin redirect a credential-bearing browser off this origin.
    if upstream.status().is_redirection() {
        return StatusCode::BAD_GATEWAY.into_response();
    }
    let status = upstream.status();
    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
    let mut bytes = Vec::new();
    loop {
        match upstream.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= 16 * 1024 * 1024 => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => break,
            _ => return StatusCode::BAD_GATEWAY.into_response(),
        }
    }
    let mut response = (status, bytes).into_response();
    if let Some(content_type) = content_type {
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, content_type);
    }
    response
}

pub async fn hmr(
    State(dev): State<Frontend>,
    headers: HeaderMap,
    uri: Uri,
    ws: WebSocketUpgrade,
) -> Response {
    if headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(dev.origin.as_str()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let protocol = match headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
    {
        Some("vite-hmr") => "vite-hmr",
        // Vite immediately closes ping connections; they carry no updates.
        Some("vite-ping") => "vite-ping",
        _ => return StatusCode::BAD_REQUEST.into_response(),
    };
    let Ok(permit) = dev.sockets.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let url = format!(
        "ws://127.0.0.1:{}{}",
        dev.port,
        uri.path_and_query()
            .map(|v| v.as_str())
            .unwrap_or("/__vite_hmr")
    );
    let Ok(mut request) = url.into_client_request() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    request.headers_mut().insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static(protocol),
    );
    request
        .headers_mut()
        .insert(header::ORIGIN, headers[header::ORIGIN].clone());
    // Vite verifies the per-process token for HMR; its ping protocol only tests availability.
    let config = WebSocketConfig::default()
        .max_message_size(Some(1024 * 1024))
        .max_frame_size(Some(1024 * 1024));
    let Ok(Ok((upstream, _))) = tokio::time::timeout(
        Duration::from_secs(5),
        tokio_tungstenite::connect_async_with_config(request, Some(config), false),
    )
    .await
    else {
        return unavailable();
    };
    ws.protocols([protocol])
        .max_message_size(1024 * 1024)
        .max_frame_size(1024 * 1024)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            let (mut browser_send, mut browser_read) = socket.split();
            let (mut vite_send, mut vite_read) = upstream.split();
            let to_vite = async {
                while let Some(Ok(message)) = browser_read.next().await {
                    let message = match message {
                        Message::Text(text) => UpstreamMessage::Text(text.to_string().into()),
                        Message::Binary(bytes) => UpstreamMessage::Binary(bytes),
                        Message::Ping(bytes) => UpstreamMessage::Ping(bytes),
                        Message::Pong(bytes) => UpstreamMessage::Pong(bytes),
                        Message::Close(_) => break,
                    };
                    if vite_send.send(message).await.is_err() {
                        break;
                    }
                }
            };
            let to_browser = async {
                while let Some(Ok(message)) = vite_read.next().await {
                    let message = match message {
                        UpstreamMessage::Text(text) => Message::Text(text.to_string().into()),
                        UpstreamMessage::Binary(bytes) => Message::Binary(bytes),
                        UpstreamMessage::Ping(bytes) => Message::Ping(bytes),
                        UpstreamMessage::Pong(bytes) => Message::Pong(bytes),
                        UpstreamMessage::Close(_) => break,
                        UpstreamMessage::Frame(_) => continue,
                    };
                    if browser_send.send(message).await.is_err() {
                        break;
                    }
                }
            };
            tokio::select! { _ = to_vite => {}, _ = to_browser => {} }
            let _ = tokio::time::timeout(Duration::from_secs(1), async {
                let _ = browser_send.close().await;
                let _ = vite_send.close().await;
            })
            .await;
        })
}

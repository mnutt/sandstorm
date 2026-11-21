//! HTTP bytes stay outside the RPC/profile model. The upload is session-bound and
//! same-origin, with the existing image size/type rules enforced by the repository.
use crate::{auth, AppState};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures::StreamExt;

#[derive(serde::Deserialize)]
pub struct Upload {
    account: String,
}

pub async fn upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(upload): Query<Upload>,
    body: Body,
) -> Response {
    // The gateway streams the request body on a reused HTTP connection. Drain
    // it even on rejection, as the legacy uploader does, but never buffer more
    // than the existing 64 KiB limit.
    let content = read_picture(body).await;
    if headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(state.origin.as_str()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(session) = auth::session(&state.auth, &headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(repo) = &session.repository else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    match repo.session(&session.token).await {
        Ok(info) if info.account.key == upload.account => {}
        Ok(_) => return StatusCode::FORBIDDEN.into_response(),
        Err(error) => return auth::error(error.into()),
    }
    let content = match content {
        Ok(content) => content,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };
    match repo.update_picture(&session.token, content).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => auth::error(error.into()),
    }
}

async fn read_picture(body: Body) -> Result<Vec<u8>, &'static str> {
    let mut stream = body.into_data_stream();
    let mut content = Vec::new();
    let mut oversized = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Could not read the uploaded image.")?;
        if !oversized && chunk.len() <= 65536 - content.len() {
            content.extend_from_slice(&chunk);
        } else {
            oversized = true;
        }
    }
    if oversized {
        Err("Picture too large; please use an image under 64 KiB.")
    } else {
        Ok(content)
    }
}

pub async fn download(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(repo) = &state.auth.repository else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    match repo.picture_asset(&id).await {
        Ok(Some(picture)) => {
            let mut response = (
                [
                    (header::CONTENT_TYPE, picture.mime_type),
                    (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
                ],
                picture.content,
            )
                .into_response();
            if picture.gzip {
                response
                    .headers_mut()
                    .insert(header::CONTENT_ENCODING, "gzip".parse().unwrap());
            }
            response
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => auth::error(error.into()),
    }
}

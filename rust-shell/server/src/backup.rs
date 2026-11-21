use crate::{auth, AppState};
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::json;
use tokio_util::io::ReaderStream;

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn filename(name: &str) -> String {
    let mut encoded = String::new();
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    format!("attachment; filename*=UTF-8''{encoded}.zip")
}

pub async fn download(
    State(state): State<AppState>,
    Path(id): Path<String>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    // Axum invokes GET handlers for HEAD too; probing must not consume a backup.
    if method != Method::GET {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    if !valid_id(&id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(directory) = &state.backup_dir else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let Some(session) = auth::session(&state.auth, &headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let metadata = match session
        .call("backupDownload", json!({"id":id,"consume":false}))
        .await
    {
        Ok(value) => value,
        Err(error) => return auth::error(error),
    };
    let file = match tokio::fs::File::open(directory.join(&id)).await {
        Ok(file) => file,
        Err(_) => return (StatusCode::NOT_FOUND, "Backup is no longer available.").into_response(),
    };
    let size = match file.metadata().await {
        Ok(metadata) if metadata.is_file() => metadata.len(),
        _ => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    // Only one request can consume the account-bound token. The backend unlinks
    // the archive while our open file remains readable, including for large ZIPs.
    if let Err(error) = session
        .call("backupDownload", json!({"id":id,"consume":true}))
        .await
    {
        return auth::error(error);
    }
    let mut response = Body::from_stream(ReaderStream::new(file)).into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, "application/zip".parse().unwrap());
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, size.into());
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        filename(metadata["name"].as_str().unwrap_or("backup"))
            .parse()
            .unwrap(),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_paths_and_encodes_download_names() {
        for id in ["", "../secret", "a/b", "a\\b", "%2e%2e", "a\0b"] {
            assert!(!valid_id(id));
        }
        assert!(valid_id("test-Backup_12"));
        assert_eq!(
            filename("résumé\r\n\"/"),
            "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%0D%0A%22%2F.zip"
        );
    }
}

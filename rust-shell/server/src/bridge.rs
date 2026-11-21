use axum::http::StatusCode;
use serde_json::Value;
use std::{path::PathBuf, time::Duration};

pub type Error = (StatusCode, String);

#[derive(Clone)]
pub struct Bridge {
    client: reqwest::Client,
}

impl Bridge {
    pub fn new(socket: PathBuf) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: reqwest::Client::builder()
                .unix_socket(socket)
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        })
    }

    pub async fn call(&self, action: &str, input: Value) -> Result<Value, Error> {
        let unavailable = || {
            (
                StatusCode::BAD_GATEWAY,
                "The main shell is unavailable. Try again shortly.".into(),
            )
        };
        let mut request = self.client.post(format!("http://bridge/{action}"));
        // Archive creation can take arbitrarily long, just as in the Meteor method.
        if !(action == "manageGrain" && input["operation"] == "backup") {
            request = request.timeout(Duration::from_secs(
                if matches!(
                    action,
                    "watch" | "waitGrainResponse" | "waitSharedGrainResponse"
                ) {
                    30
                } else if action == "nativeAuth" {
                    20
                } else {
                    5
                },
            ));
        }
        let mut response = request
            .json(&input)
            .send()
            .await
            .map_err(|_| unavailable())?;
        let status = response.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
        if !status.is_success() {
            return Err((
                status,
                value["error"]
                    .as_str()
                    .unwrap_or("Bridge operation failed.")
                    .into(),
            ));
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::post, Json, Router};
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::sync::Semaphore;

    #[tokio::test]
    async fn concurrent_requests_do_not_have_a_rust_shell_quota() {
        let path =
            std::env::temp_dir().join(format!("rust-bridge-audit-{}.sock", std::process::id()));
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let entered = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(Semaphore::new(0));
        let app = Router::new()
            .route(
                "/getProfile",
                post({
                    let entered = entered.clone();
                    let release = release.clone();
                    move || {
                        let entered = entered.clone();
                        let release = release.clone();
                        async move {
                            entered.fetch_add(1, Ordering::SeqCst);
                            release.acquire().await.unwrap().forget();
                            Json(json!({}))
                        }
                    }
                }),
            )
            .route("/closeGrain", post(|| async { Json(json!({})) }));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let bridge = Bridge::new(path.clone()).unwrap();
        let mut calls = tokio::task::JoinSet::new();
        for _ in 0..40 {
            let bridge = bridge.clone();
            calls.spawn(async move { bridge.call("getProfile", json!({})).await });
        }
        tokio::time::timeout(Duration::from_secs(3), async {
            while entered.load(Ordering::SeqCst) < 40 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(bridge.call("closeGrain", json!({})).await.is_ok());
        release.add_permits(41);
        while let Some(result) = calls.join_next().await {
            assert!(result.unwrap().is_ok());
        }
        assert!(bridge.call("getProfile", json!({})).await.is_ok());
        server.abort();
        let _ = server.await;
        std::fs::remove_file(path).unwrap();
    }
}

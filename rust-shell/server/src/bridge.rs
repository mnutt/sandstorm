use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};

pub type Error = (StatusCode, String);

#[derive(Deserialize)]
pub struct AppAction {
    pub key: String,
    pub title: String,
    #[serde(rename = "appTitle")]
    pub app_title: String,
}
#[derive(Deserialize)]
pub struct AppList {
    pub actions: Vec<AppAction>,
    pub limited: bool,
}

#[derive(Clone)]
pub struct Bridge(reqwest::Client);

impl Bridge {
    pub fn new(socket: PathBuf) -> Result<Self, reqwest::Error> {
        Ok(Self(
            reqwest::Client::builder()
                .unix_socket(socket)
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()?,
        ))
    }

    pub async fn call(&self, action: &str, input: Value) -> Result<Value, Error> {
        let unavailable = || {
            (
                StatusCode::BAD_GATEWAY,
                "The main shell is unavailable. Try again shortly.".into(),
            )
        };
        let mut response = self
            .0
            .post(format!("http://bridge/{action}"))
            .timeout(Duration::from_secs(if action == "watch" { 30 } else { 5 }))
            .json(&input)
            .send()
            .await
            .map_err(|_| unavailable())?;
        let status = response.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
            if bytes.len() + chunk.len() > 220000 {
                return Err(unavailable());
            }
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

#[derive(Clone)]
pub struct Session {
    pub bridge: Bridge,
    pub token: String,
}

impl Session {
    pub async fn call(&self, action: &str, mut input: Value) -> Result<Value, Error> {
        input["token"] = json!(self.token);
        self.bridge.call(action, input).await
    }
    pub async fn snapshot(&self) -> Result<Snapshot, Error> {
        self.projection("snapshot", json!({})).await
    }
    pub async fn watch(&self, version: &str) -> Result<Snapshot, Error> {
        self.projection("watch", json!({ "after": version })).await
    }
    async fn projection(&self, action: &str, input: Value) -> Result<Snapshot, Error> {
        serde_json::from_value(self.call(action, input).await?).map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                "Invalid notification projection.".into(),
            )
        })
    }
}

#[derive(Clone, Deserialize, PartialEq)]
pub struct Entry {
    pub key: String,
    pub title: String,
    pub body: String,
    pub href: String,
    pub unread: bool,
    pub ongoing: bool,
    pub timestamp: String,
    #[serde(default, rename = "senderName")]
    pub sender_name: String,
}

#[derive(Clone, Deserialize, PartialEq)]
pub struct Grain {
    pub key: String,
    pub title: String,
    #[serde(default, rename = "ownerTitle")]
    pub owner_title: String,
    pub href: String,
    pub owned: bool,
    #[serde(rename = "lastUsed")]
    pub last_used: String,
    #[serde(default, rename = "appTitle")]
    pub app_title: String,
}

#[derive(Clone, Deserialize, PartialEq)]
pub struct Snapshot {
    #[serde(default)]
    pub grains: Vec<Grain>,
    #[serde(default, rename = "grainsLimited")]
    pub grains_limited: bool,
    pub version: String,
    pub entries: Vec<Entry>,
    pub total: u32,
}

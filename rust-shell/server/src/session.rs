//! Authenticated application context. Storage reads are typed; unported commands
//! retain their existing Meteor owners. A configured repository never falls back.
use crate::{
    bridge::{Bridge, Error},
    read_model::{AppList, GrainQuery, Pages, SessionInfo, Snapshot},
    repository::Repository,
};
use axum::http::StatusCode;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone)]
pub struct Session {
    pub bridge: Bridge,
    pub token: String,
    pub repository: Option<Arc<Repository>>,
}

impl From<crate::repository::Error> for Error {
    fn from(error: crate::repository::Error) -> Self {
        let status = match error {
            crate::repository::Error::Unauthorized => StatusCode::UNAUTHORIZED,
            crate::repository::Error::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        };
        (status, error.to_string())
    }
}

impl Session {
    pub async fn call(&self, action: &str, mut input: Value) -> Result<Value, Error> {
        input["token"] = json!(self.token);
        self.bridge.call(action, input).await
    }
    async fn read<T: DeserializeOwned>(&self, action: &str, input: Value) -> Result<T, Error> {
        serde_json::from_value(self.call(action, input).await?).map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                "Invalid main-shell response.".into(),
            )
        })
    }
    pub async fn info(&self) -> Result<SessionInfo, Error> {
        match &self.repository {
            Some(repo) => Ok(repo.session(&self.token).await?),
            None => self.read("session", json!({})).await,
        }
    }
    pub async fn apps(&self, page: u32, app_id: &str) -> Result<AppList, Error> {
        match &self.repository {
            Some(repo) => Ok(repo.list_apps(&self.token, page, app_id).await?),
            None => {
                self.read("listApps", json!({"page":page,"appId":app_id}))
                    .await
            }
        }
    }
    pub async fn snapshot(&self) -> Result<Snapshot, Error> {
        match &self.repository {
            Some(repo) => Ok(repo
                .watch(&self.token, None, Pages::default(), None)
                .await?),
            None => self.read("snapshot", json!({})).await,
        }
    }
    pub async fn watch(&self, version: &str, pages: Pages) -> Result<Snapshot, Error> {
        self.watch_query(version, pages, None).await
    }
    pub async fn watch_query(
        &self,
        version: &str,
        pages: Pages,
        query: Option<GrainQuery>,
    ) -> Result<Snapshot, Error> {
        match &self.repository {
            Some(repo) => Ok(repo
                .watch(&self.token, Some(version), pages, query.as_ref())
                .await?),
            None => {
                let mut input = json!({"after":version,"pages":pages});
                if let Some(query) = query {
                    input["query"] = json!(query);
                }
                self.read("watch", input).await
            }
        }
    }
    pub async fn logout(&self) -> Result<Value, Error> {
        // Let Meteor initiate SAML logout when available, but its availability
        // must not prevent revoking a native session in Mongo.
        let legacy = self.call("logout", json!({})).await;
        if let Some(repo) = &self.repository {
            repo.revoke(&self.token).await?;
            return Ok(legacy.unwrap_or_else(|_| json!({})));
        }
        legacy
    }
}

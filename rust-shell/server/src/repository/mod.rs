//! Mongo is a storage adapter, not part of the browser capability contract.
//! During coexistence, reads and linked-session revocation live here; application
//! unported mutations continue through their named Meteor owners.
mod lists;
mod presentation;
mod profile;
mod sessions;
mod snapshot;
#[cfg(test)]
mod tests;
mod writes;

use crate::read_model::{AccountInfo, AppList, GrainQuery, Pages, SessionInfo, Snapshot};
use futures::TryStreamExt;
use mongodb::{
    bson::{doc, Document},
    Client, Database,
};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio::sync::watch;

pub struct Repository {
    db: Database,
    main_url: reqwest::Url,
    static_prefix: String,
    changes: watch::Sender<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Unavailable,
    Unauthorized,
    Invalid(&'static str),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unavailable => "The database is temporarily unavailable.",
            Self::Invalid(message) => message,
            Self::Unauthorized => "Sign in to Sandstorm again.",
        })
    }
}
impl std::error::Error for Error {}
pub(super) fn unavailable() -> Error {
    Error::Unavailable
}
pub(super) fn denied() -> Error {
    Error::Unauthorized
}
pub(super) fn hash(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

impl Repository {
    pub async fn connect(uri: &str, main_url: &str, wildcard: &str) -> Result<Arc<Self>, Error> {
        let mut options = mongodb::options::ClientOptions::parse(uri)
            .await
            .map_err(|_| unavailable())?;
        options.server_selection_timeout = Some(Duration::from_secs(5));
        let db_name = options
            .default_database
            .clone()
            .unwrap_or_else(|| "meteor".into());
        let client = Client::with_options(options).map_err(|_| unavailable())?;
        let main_url = reqwest::Url::parse(main_url).map_err(|_| unavailable())?;
        let static_prefix = format!(
            "{}://{}",
            main_url.scheme(),
            wildcard.replace('*', "static")
        );
        let (changes, _) = watch::channel(false);
        let repo = Arc::new(Self {
            db: client.database(&db_name),
            main_url,
            static_prefix,
            changes,
        });
        tokio::spawn(repo.clone().observe());
        Ok(repo)
    }

    async fn observe(self: Arc<Self>) {
        loop {
            // Establish observation before admitting snapshots. An error invalidates
            // all live projections; a fresh stream requires fresh snapshots.
            if let Ok(mut stream) = self.db.watch().await {
                self.changes.send_replace(true);
                while let Ok(Some(_)) = stream.try_next().await {
                    self.changes.send_replace(true);
                }
            }
            self.changes.send_replace(false);
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    async fn find(&self, collection: &str, query: Document) -> Result<Option<Document>, Error> {
        self.db
            .collection::<Document>(collection)
            .find_one(query)
            .await
            .map_err(|_| unavailable())
    }
    async fn aggregate(
        &self,
        collection: &str,
        stages: Vec<Document>,
    ) -> Result<Vec<Document>, Error> {
        self.db
            .collection::<Document>(collection)
            .aggregate(stages)
            .await
            .map_err(|_| unavailable())?
            .try_collect()
            .await
            .map_err(|_| unavailable())
    }

    pub async fn session(&self, token: &str) -> Result<SessionInfo, Error> {
        let account = self.authorize(token).await?;
        Ok(SessionInfo {
            account: AccountInfo {
                name: account.name,
                key: hash(&account.account_id),
                picture_url: account.picture,
            },
            expires: account.expires,
        })
    }

    pub async fn list_apps(&self, token: &str, page: u32, app_id: &str) -> Result<AppList, Error> {
        let account = self.authorize(token).await?;
        let apps = self.apps(&account.account_id, Some(page), app_id).await?;
        self.authorize(token).await?;
        Ok(apps)
    }

    /// Subscribe before reading so a write during projection cannot be missed.
    /// Versions describe material account data, never the global stream position.
    pub async fn watch(
        &self,
        token: &str,
        after: Option<&str>,
        pages: Pages,
        query: Option<&GrainQuery>,
    ) -> Result<Snapshot, Error> {
        let mut changes = self.changes.subscribe();
        loop {
            if !*changes.borrow_and_update() {
                return Err(unavailable());
            }
            let account = self.authorize(token).await?;
            let value = self.snapshot(&account, pages, query).await?;
            self.authorize(token).await?;
            if !*changes.borrow() {
                return Err(unavailable());
            }
            if after != Some(value.version.as_str()) {
                return Ok(value);
            }
            // Auth remains live even when no UI data changes (including expiry).
            loop {
                tokio::select! {
                    result = changes.changed() => { result.map_err(|_| unavailable())?; break; }
                    _ = tokio::time::sleep(Duration::from_secs(1)) => { self.authorize(token).await?; }
                }
            }
        }
    }
}

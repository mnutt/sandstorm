use crate::{bridge::Session, shell_capnp::grain_session};
use serde::Deserialize;
use serde_json::json;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};
use tokio::sync::watch;

#[derive(Deserialize)]
pub struct View {
    #[serde(default)]
    pub lease: String,
    #[serde(rename = "grainId")]
    pub grain_id: String,
    pub origin: String,
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, rename = "ownerTitle")]
    pub owner_title: String,
    #[serde(default, rename = "iconSrc")]
    pub icon_src: String,
    #[serde(default, rename = "mainHref")]
    pub main_href: String,
}

pub struct GrainScope {
    session: Session,
    key: String,
    active: RefCell<Option<String>>,
    busy: Cell<bool>,
    ended: watch::Sender<bool>,
}
struct Opening<'a>(&'a Cell<bool>);
impl Drop for Opening<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}
impl GrainScope {
    pub fn new(session: Session) -> capnp::Result<Rc<Self>> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|_| capnp::Error::failed("Cannot create grain scope".into()))?;
        Ok(Rc::new(Self {
            session,
            key: bytes.iter().map(|b| format!("{b:02x}")).collect(),
            active: RefCell::new(None),
            busy: Cell::new(false),
            ended: watch::channel(false).0,
        }))
    }
    pub async fn open(
        self: &Rc<Self>,
        grain_id: String,
    ) -> Result<(View, grain_session::Client), crate::bridge::Error> {
        if self.busy.replace(true) {
            return Err((
                axum::http::StatusCode::CONFLICT,
                "A grain is already opening".into(),
            ));
        }
        let _opening = Opening(&self.busy);
        if self.active.borrow().is_some() {
            return Err((
                axum::http::StatusCode::CONFLICT,
                "Close the current grain first".into(),
            ));
        }
        let value = self
            .session
            .call(
                "openGrain",
                json!({ "scope": self.key, "grainId": grain_id }),
            )
            .await?;
        let view: View = match serde_json::from_value(value) {
            Ok(view) => view,
            Err(_) => {
                self.close_all().await;
                return Err((
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "Invalid grain session".into(),
                ));
            }
        };
        *self.active.borrow_mut() = Some(view.lease.clone());
        let client = capnp_rpc::new_client(Lease {
            scope: self.clone(),
            lease: view.lease.clone(),
            closed: Cell::new(false),
        });
        Ok((view, client))
    }
    async fn close(&self, lease: &str) -> capnp::Result<()> {
        if self.active.borrow().as_deref() == Some(lease) {
            *self.active.borrow_mut() = None;
            self.ended.send_replace(true);
        }
        self.session
            .call("closeGrain", json!({ "scope": self.key, "lease": lease }))
            .await
            .map_err(|(_, error)| capnp::Error::failed(error))?;
        Ok(())
    }
    pub async fn close_all(&self) {
        self.ended.send_replace(true);
        // Also closes a creation still in flight in Meteor after RPC cancellation.
        let _ = self
            .session
            .call("closeGrain", json!({ "scope": self.key }))
            .await;
        *self.active.borrow_mut() = None;
    }
    async fn keep(&self) {
        let lease = self.active.borrow().clone();
        if let Some(lease) = lease {
            if self
                .session
                .call("keepGrain", json!({ "scope": self.key, "lease": lease }))
                .await
                .is_err()
                && self.active.borrow().as_deref() == Some(lease.as_str())
            {
                // Invalidate locally before cleanup; an unavailable backend must
                // never leave the browser using a lease we cannot renew.
                self.ended.send_replace(true);
                let _ = self.close(&lease).await;
            }
        }
    }
}
pub(crate) struct Lease {
    scope: Rc<GrainScope>,
    lease: String,
    closed: Cell<bool>,
}
impl Lease {
    pub(crate) async fn bridge_call(
        &self,
        operation: &str,
        mut input: serde_json::Value,
    ) -> Result<serde_json::Value, crate::bridge::Error> {
        if self.closed.get() || *self.scope.ended.borrow() {
            return Err((
                axum::http::StatusCode::CONFLICT,
                "Grain session closed".into(),
            ));
        }
        input["scope"] = json!(self.scope.key);
        input["lease"] = json!(self.lease);
        self.scope.session.call(operation, input).await
    }
}
impl grain_session::Server for Lease {
    async fn sharing(
        self: Rc<Self>,
        _: grain_session::SharingParams,
        mut results: grain_session::SharingResults,
    ) -> capnp::Result<()> {
        results
            .get()
            .set_sharing(capnp_rpc::new_client(crate::sharing::Sharing(self)));
        Ok(())
    }

    async fn when_ready(
        self: Rc<Self>,
        _: grain_session::WhenReadyParams,
        mut results: grain_session::WhenReadyResults,
    ) -> capnp::Result<()> {
        let bridge = self.scope.session.bridge.clone();
        let input =
            json!({"token":self.scope.session.token,"scope":self.scope.key,"lease":self.lease});
        let ended = self.scope.ended.subscribe();
        drop(self);
        match crate::readiness::wait(&bridge, "waitGrainResponse", input, ended).await {
            Ok(()) => {
                results.get().init_result().init_value();
                Ok(())
            }
            Err(error) => {
                crate::workflow::failure(error, results.get().init_result().init_failure())
            }
        }
    }

    async fn when_closed(
        self: Rc<Self>,
        _: grain_session::WhenClosedParams,
        _: grain_session::WhenClosedResults,
    ) -> capnp::Result<()> {
        let mut ended = self.scope.ended.subscribe();
        drop(self);
        ended
            .wait_for(|closed| *closed)
            .await
            .map_err(|_| capnp::Error::disconnected("Grain session ended".into()))?;
        Ok(())
    }

    async fn begin_powerbox(
        self: Rc<Self>,
        params: grain_session::BeginPowerboxParams,
        mut results: grain_session::BeginPowerboxResults,
    ) -> capnp::Result<()> {
        let query = crate::powerbox::query(params.get()?.get_query()?)?;
        match crate::powerbox::Request::open(self, Vec::new(), query).await {
            Ok((request, value)) => {
                crate::powerbox::write(&value, results.get().init_result().init_value())?;
                results.get().set_request(capnp_rpc::new_client(request));
            }
            Err(error) => {
                crate::workflow::failure(error, results.get().init_result().init_failure())?
            }
        }
        Ok(())
    }

    async fn rename(
        self: Rc<Self>,
        params: grain_session::RenameParams,
        mut results: grain_session::RenameResults,
    ) -> capnp::Result<()> {
        let title = params.get()?.get_title()?.to_str()?;
        let value = match self
            .bridge_call("renameGrain", json!({"title":title}))
            .await
        {
            Ok(value) => value,
            Err(error) => {
                return crate::workflow::failure(error, results.get().init_result().init_failure())
            }
        };
        let title = value["title"]
            .as_str()
            .ok_or_else(|| capnp::Error::failed("Invalid grain title response".into()))?;
        let mut out = results.get().init_result().init_value();
        out.set_title(title);
        out.set_owner_title(value["ownerTitle"].as_str().unwrap_or_default());
        Ok(())
    }

    async fn render_template(
        self: Rc<Self>,
        params: grain_session::RenderTemplateParams,
        mut results: grain_session::RenderTemplateResults,
    ) -> capnp::Result<()> {
        let options = crate::template::options(params.get()?.get_options()?)?;
        let value = match self
            .bridge_call("renderTemplate", json!({"options": options}))
            .await
        {
            Ok(value) => value,
            Err(error) => {
                return crate::workflow::failure(error, results.get().init_result().init_failure())
            }
        };
        let token = value["token"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| capnp::Error::failed("Invalid template token".into()))?;
        let host = value["host"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| capnp::Error::failed("Invalid template host".into()))?;
        let mut out = results.get().init_result().init_value();
        out.set_token(token);
        out.set_host(host);
        Ok(())
    }

    async fn close(
        self: Rc<Self>,
        _: grain_session::CloseParams,
        _: grain_session::CloseResults,
    ) -> capnp::Result<()> {
        if !self.closed.replace(true) {
            // Mark before awaiting: repeated close calls must not amplify bridge IO.
            self.scope.close(&self.lease).await?;
        }
        Ok(())
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if !self.closed.replace(true) {
            let scope = self.scope.clone();
            let lease = self.lease.clone();
            tokio::task::spawn_local(async move {
                let _ = scope.close(&lease).await;
            });
        }
    }
}

// One independently authorized Meteor scope per open grain. The browser connection
// owns the group, including pending opens, so disconnect still closes everything.
pub struct Scope {
    session: Session,
    grains: RefCell<Vec<Rc<GrainScope>>>,
}
impl Scope {
    pub fn new(session: Session) -> capnp::Result<Rc<Self>> {
        Ok(Rc::new(Self {
            session,
            grains: RefCell::new(Vec::new()),
        }))
    }
    pub async fn open(
        self: &Rc<Self>,
        grain_id: String,
    ) -> Result<(View, grain_session::Client), crate::bridge::Error> {
        let grain = GrainScope::new(self.session.clone()).map_err(|_| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Could not create grain scope".into(),
            )
        })?;
        {
            let mut grains = self.grains.borrow_mut();
            grains.retain(|grain| grain.busy.get() || grain.active.borrow().is_some());
            grains.push(grain.clone());
        }
        grain.open(grain_id).await
    }
    pub async fn close_all(&self) {
        let grains = std::mem::take(&mut *self.grains.borrow_mut());
        for grain in grains {
            grain.close_all().await;
        }
    }
    pub async fn maintain(&self) {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            let grains = self.grains.borrow().clone();
            // A slow lease must not delay every other renewal.
            futures::future::join_all(grains.iter().map(|grain| grain.keep())).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pending_readiness_does_not_retain_grain_lease() {
        tokio::task::LocalSet::new()
            .run_until(async {
                use axum::{routing::post, Json, Router};
                let path = std::env::temp_dir()
                    .join(format!("rust-grain-ready-{}.sock", std::process::id()));
                let listener = tokio::net::UnixListener::bind(&path).unwrap();
                let entered = std::sync::Arc::new(tokio::sync::Notify::new());
                let notify = entered.clone();
                let app = Router::new()
                    .route(
                        "/waitGrainResponse",
                        post(move || {
                            let notify = notify.clone();
                            async move {
                                notify.notify_one();
                                std::future::pending::<Json<serde_json::Value>>().await
                            }
                        }),
                    )
                    .route("/closeGrain", post(|| async { Json(json!({})) }));
                let server = tokio::spawn(async move {
                    axum::serve(listener, app).await.unwrap();
                });
                let scope = GrainScope::new(Session {
                    bridge: crate::bridge::Bridge::new(path.clone()).unwrap(),
                    token: "token".into(),
                })
                .unwrap();
                *scope.active.borrow_mut() = Some("lease".into());
                let client: grain_session::Client = capnp_rpc::new_client(Lease {
                    scope: scope.clone(),
                    lease: "lease".into(),
                    closed: Cell::new(false),
                });
                let ready = tokio::task::spawn_local(client.when_ready_request().send().promise);
                tokio::time::timeout(Duration::from_secs(1), entered.notified())
                    .await
                    .unwrap();
                drop(client);
                let response = tokio::time::timeout(Duration::from_secs(1), ready)
                    .await
                    .expect("readiness must not retain the lease")
                    .unwrap()
                    .unwrap();
                assert!(response.get().unwrap().get_result().unwrap().has_failure());
                assert!(*scope.ended.borrow());
                server.abort();
                let _ = std::fs::remove_file(path);
            })
            .await;
    }

    #[tokio::test]
    async fn pending_lifetime_call_does_not_retain_grain_lease() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let scope = GrainScope::new(Session {
                    bridge: crate::bridge::Bridge::new("/dev/null/grain-test.sock".into()).unwrap(),
                    token: "test".into(),
                })
                .unwrap();
                *scope.active.borrow_mut() = Some("lease".into());
                let client: grain_session::Client = capnp_rpc::new_client(Lease {
                    scope: scope.clone(),
                    lease: "lease".into(),
                    closed: Cell::new(false),
                });
                let terminal =
                    tokio::task::spawn_local(client.when_closed_request().send().promise);
                tokio::task::yield_now().await;
                drop(client);
                tokio::time::timeout(Duration::from_secs(1), terminal)
                    .await
                    .expect("releasing the capability must end the grain lease")
                    .unwrap()
                    .unwrap();
                assert!(*scope.ended.borrow());
                assert!(scope.active.borrow().is_none());
            })
            .await;
    }
}

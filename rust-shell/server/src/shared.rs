use crate::{
    bridge::{Bridge, Session},
    grain::View,
    shell_capnp::{shared_session, shared_shell},
};
use serde_json::{json, Value};
use std::{cell::Cell, rc::Rc, time::Duration};

#[derive(Clone)]
pub struct SharedShell {
    bridge: Bridge,
    account: Option<Session>,
    key: String,
    busy: Rc<Cell<bool>>,
    active: Rc<Cell<bool>>,
    opened: Rc<Cell<bool>>,
    closed: Rc<Cell<bool>>,
    signed_in: Rc<Cell<bool>>,
}
struct Busy<'a>(&'a Cell<bool>);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}
impl SharedShell {
    pub fn new(bridge: Bridge, account: Option<Session>) -> capnp::Result<Self> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|_| capnp::Error::failed("Cannot create shared scope".into()))?;
        Ok(Self {
            bridge,
            account,
            key: bytes.iter().map(|b| format!("{b:02x}")).collect(),
            busy: Rc::new(Cell::new(false)),
            active: Rc::new(Cell::new(false)),
            opened: Rc::new(Cell::new(false)),
            closed: Rc::new(Cell::new(false)),
            signed_in: Rc::new(Cell::new(false)),
        })
    }
    async fn call(&self, action: &str, mut input: Value) -> Result<Value, crate::bridge::Error> {
        input["scope"] = json!(self.key);
        if let Some(account) = &self.account {
            input["accountToken"] = json!(account.token);
        }
        self.bridge.call(action, input).await
    }
    pub async fn close(&self) {
        self.active.set(false);
        // Repeated close/drop and never-opened public connections need no bridge IO.
        if self.closed.replace(true) || !self.opened.get() {
            return;
        }
        let _ = self.call("closeSharedGrain", json!({})).await;
    }
    pub async fn maintain(&self) {
        let started = std::time::Instant::now();
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            if !self.active.get()
                && started.elapsed().as_secs() >= if self.signed_in.get() { 120 } else { 30 }
            {
                return;
            }
            if self.active.get() && self.call("keepSharedGrain", json!({})).await.is_err() {
                return;
            }
        }
    }
}
impl shared_shell::Server for SharedShell {
    async fn inspect(
        self: Rc<Self>,
        params: shared_shell::InspectParams,
        mut results: shared_shell::InspectResults,
    ) -> capnp::Result<()> {
        if self.busy.replace(true) {
            return crate::workflow::failure(
                (
                    axum::http::StatusCode::CONFLICT,
                    "Request already pending".into(),
                ),
                results.get().init_result().init_failure(),
            );
        }
        let _busy = Busy(&self.busy);
        let webkey = params.get()?.get_webkey()?.to_str()?;
        let info = match self
            .call("inspectSharedGrain", json!({"webkey":webkey}))
            .await
        {
            Ok(value) => value,
            Err(error) => {
                return crate::workflow::failure(error, results.get().init_result().init_failure())
            }
        };
        self.signed_in
            .set(info["signedIn"].as_bool().unwrap_or(false));
        let mut out = results.get().init_result().init_value();
        out.set_title(info["title"].as_str().unwrap_or("Shared grain"));
        out.set_guests_allowed(info["guestsAllowed"].as_bool().unwrap_or(false));
        out.set_signed_in(info["signedIn"].as_bool().unwrap_or(false));
        out.set_account_picture_url(info["accountPictureUrl"].as_str().unwrap_or_default());
        out.set_account_name(info["accountName"].as_str().unwrap_or_default());
        Ok(())
    }
    async fn open(
        self: Rc<Self>,
        params: shared_shell::OpenParams,
        mut results: shared_shell::OpenResults,
    ) -> capnp::Result<()> {
        if self.busy.replace(true) {
            return crate::workflow::failure(
                (
                    axum::http::StatusCode::CONFLICT,
                    "Request already pending".into(),
                ),
                results.get().init_result().init_failure(),
            );
        }
        let _busy = Busy(&self.busy);
        if self.closed.get() || self.opened.replace(true) {
            return crate::workflow::failure(
                (
                    axum::http::StatusCode::CONFLICT,
                    "Reopen this sharing link to start a new session".into(),
                ),
                results.get().init_result().init_failure(),
            );
        }
        let input = params.get()?;
        let webkey = input.get_webkey()?.to_str()?;
        let value = match self
            .call(
                "openSharedGrain",
                json!({"webkey":webkey,"revealIdentity":input.get_reveal_identity()}),
            )
            .await
        {
            Ok(value) => value,
            Err(error) => {
                return crate::workflow::failure(error, results.get().init_result().init_failure())
            }
        };
        let view: View = match serde_json::from_value(value) {
            Ok(view) => view,
            Err(_) => {
                self.close().await;
                return Err(capnp::Error::failed("Invalid shared session".into()));
            }
        };
        self.active.set(true);
        let mut out = results.get().init_result().init_value();
        out.set_session(capnp_rpc::new_client(SharedLease(self.clone())));
        let mut out = out.init_view();
        out.set_grain_id(&view.grain_id);
        out.set_origin(&view.origin);
        out.set_url(&view.url);
        out.set_title(&view.title);
        out.set_owner_title(&view.owner_title);
        out.set_main_href(&view.main_href);
        out.set_icon_src(&view.icon_src);
        Ok(())
    }
}
struct SharedLease(Rc<SharedShell>);
impl shared_session::Server for SharedLease {
    async fn close(
        self: Rc<Self>,
        _: shared_session::CloseParams,
        _: shared_session::CloseResults,
    ) -> capnp::Result<()> {
        self.0.close().await;
        Ok(())
    }
}
impl Drop for SharedLease {
    fn drop(&mut self) {
        let shell = self.0.clone();
        tokio::task::spawn_local(async move {
            shell.close().await;
        });
    }
}

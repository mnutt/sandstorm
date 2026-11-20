use crate::{bridge::Session, shell_capnp::grain_session};
use serde::Deserialize;
use serde_json::json;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

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
        }))
    }
    pub async fn open(
        self: &Rc<Self>,
        grain_id: String,
    ) -> capnp::Result<(View, grain_session::Client)> {
        if self.busy.replace(true) {
            return Err(capnp::Error::failed("A grain is already opening".into()));
        }
        let _opening = Opening(&self.busy);
        if self.active.borrow().is_some() {
            return Err(capnp::Error::failed("Close the current grain first".into()));
        }
        let value = self
            .session
            .call(
                "openGrain",
                json!({ "scope": self.key, "grainId": grain_id }),
            )
            .await
            .map_err(|(_, error)| capnp::Error::failed(error))?;
        let view: View = serde_json::from_value(value)
            .map_err(|_| capnp::Error::failed("Invalid grain session".into()))?;
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
        }
        self.session
            .call("closeGrain", json!({ "scope": self.key, "lease": lease }))
            .await
            .map_err(|(_, error)| capnp::Error::failed(error))?;
        Ok(())
    }
    pub async fn close_all(&self) {
        // Also closes a creation still in flight in Meteor after RPC cancellation.
        let _ = self
            .session
            .call("closeGrain", json!({ "scope": self.key }))
            .await;
        *self.active.borrow_mut() = None;
    }
    async fn keep(&self) -> bool {
        let lease = self.active.borrow().clone();
        if let Some(lease) = lease {
            if self
                .session
                .call("keepGrain", json!({ "scope": self.key, "lease": lease }))
                .await
                .is_err()
                && self.active.borrow().as_deref() == Some(lease.as_str())
            {
                return false;
            }
        }
        true
    }
}
pub(crate) struct Lease {
    scope: Rc<GrainScope>,
    lease: String,
    closed: Cell<bool>,
}
impl Lease {
    pub(crate) async fn sharing_call(
        &self,
        operation: &str,
        mut input: serde_json::Value,
    ) -> capnp::Result<serde_json::Value> {
        if self.closed.get() {
            return Err(capnp::Error::failed("Grain session closed".into()));
        }
        input["scope"] = json!(self.scope.key);
        input["lease"] = json!(self.lease);
        self.scope
            .session
            .call(operation, input)
            .await
            .map_err(|(_, error)| capnp::Error::failed(error))
    }
}
impl grain_session::Server for Lease {
    async fn begin_powerbox(
        self: Rc<Self>,
        params: grain_session::BeginPowerboxParams,
        mut results: grain_session::BeginPowerboxResults,
    ) -> capnp::Result<()> {
        let query = crate::powerbox::query(params.get()?.get_query()?)?;
        let (request, value) = crate::powerbox::Request::open(self, Vec::new(), query).await?;
        crate::powerbox::write(&value, results.get().init_result().init_value())?;
        results.get().set_request(capnp_rpc::new_client(request));
        Ok(())
    }

    async fn powerbox(
        self: Rc<Self>,
        params: grain_session::PowerboxParams,
        mut results: grain_session::PowerboxResults,
    ) -> capnp::Result<()> {
        let params = params.get()?;
        let operation = params.get_operation()?.to_str()?;
        let request = params.get_request()?.to_str()?;
        let input = params.get_input()?.to_str()?;
        if !matches!(operation, "begin" | "select" | "poll" | "cancel")
            || request.len() != 64
            || input.len() > 65536
        {
            return Err(capnp::Error::failed("Invalid Powerbox request".into()));
        }
        let input: serde_json::Value = serde_json::from_str(input)
            .map_err(|_| capnp::Error::failed("Invalid Powerbox input".into()))?;
        let value = self.sharing_call("powerbox", json!({"request": request, "operation": operation,
            "query": input["query"], "key": input["key"], "mode": input["mode"], "role": input["role"], "url": input["url"], "email": input["email"], "code": input["code"], "nestedRequest": input["nestedRequest"], "nestedOperation": input["nestedOperation"], "nestedInput": input["nestedInput"]})).await?;
        results.get().set_state(value.to_string());
        Ok(())
    }

    async fn get_sharing(
        self: Rc<Self>,
        _: grain_session::GetSharingParams,
        mut results: grain_session::GetSharingResults,
    ) -> capnp::Result<()> {
        let value = self.sharing_call("getSharing", json!({})).await?;
        results.get().set_state(value.to_string());
        Ok(())
    }

    async fn create_share(
        self: Rc<Self>,
        params: grain_session::CreateShareParams,
        mut results: grain_session::CreateShareResults,
    ) -> capnp::Result<()> {
        let params = params.get()?;
        let label = params.get_label()?.to_str()?;
        let role = params.get_role()?.to_str()?;
        if label.len() > 640 || role.len() > 16 {
            return Err(capnp::Error::failed("Invalid sharing options".into()));
        }
        let value = self
            .sharing_call("createShare", json!({"label": label, "role": role}))
            .await?;
        results.get().set_token(
            value["token"]
                .as_str()
                .ok_or_else(|| capnp::Error::failed("Invalid sharing token".into()))?,
        );
        Ok(())
    }

    async fn update_share(
        self: Rc<Self>,
        params: grain_session::UpdateShareParams,
        _: grain_session::UpdateShareResults,
    ) -> capnp::Result<()> {
        let params = params.get()?;
        let id = params.get_id()?.to_str()?;
        let changes = params.get_changes()?.to_str()?;
        if id.len() > 128 || changes.len() > 2048 {
            return Err(capnp::Error::failed("Invalid sharing update".into()));
        }
        let changes: serde_json::Value = serde_json::from_str(changes)
            .map_err(|_| capnp::Error::failed("Invalid sharing update".into()))?;
        self.sharing_call("updateShare", json!({"id": id, "changes": changes}))
            .await?;
        Ok(())
    }

    async fn rename(
        self: Rc<Self>,
        params: grain_session::RenameParams,
        mut results: grain_session::RenameResults,
    ) -> capnp::Result<()> {
        if self.closed.get() {
            return Err(capnp::Error::failed("Grain session closed".into()));
        }
        let title = params.get()?.get_title()?.to_str()?;
        if title.len() > 640 {
            return Err(capnp::Error::failed("Grain title too long".into()));
        }
        let value = self
            .scope
            .session
            .call(
                "renameGrain",
                json!({
                    "scope": self.scope.key, "lease": self.lease, "title": title
                }),
            )
            .await
            .map_err(|(_, error)| capnp::Error::failed(error))?;
        results
            .get()
            .set_owner_title(value["ownerTitle"].as_str().unwrap_or_default());
        results.get().set_title(
            value["title"]
                .as_str()
                .ok_or_else(|| capnp::Error::failed("Invalid grain title response".into()))?,
        );
        Ok(())
    }

    async fn render_template(
        self: Rc<Self>,
        params: grain_session::RenderTemplateParams,
        mut results: grain_session::RenderTemplateResults,
    ) -> capnp::Result<()> {
        if self.closed.get() {
            return Err(capnp::Error::failed("Grain session closed".into()));
        }
        let options = params.get()?.get_options()?.to_str()?;
        if options.len() > 6144 {
            return Err(capnp::Error::failed("Template options too large".into()));
        }
        let options: serde_json::Value = serde_json::from_str(options)
            .map_err(|_| capnp::Error::failed("Invalid template options".into()))?;
        let value = self
            .scope
            .session
            .call(
                "renderTemplate",
                json!({
                    "scope": self.scope.key, "lease": self.lease, "options": options
                }),
            )
            .await
            .map_err(|(_, error)| capnp::Error::failed(error))?;
        let token = value["token"]
            .as_str()
            .ok_or_else(|| capnp::Error::failed("Invalid template token".into()))?;
        let host = value["host"]
            .as_str()
            .ok_or_else(|| capnp::Error::failed("Invalid template host".into()))?;
        results.get().set_token(token);
        results.get().set_host(host);
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
    ) -> capnp::Result<(View, grain_session::Client)> {
        let grain = GrainScope::new(self.session.clone())?;
        {
            let mut grains = self.grains.borrow_mut();
            grains.retain(|grain| grain.busy.get() || grain.active.borrow().is_some());
            if grains.len() >= 8 {
                return Err(capnp::Error::failed(
                    "Close a grain before opening another (8 open maximum)".into(),
                ));
            }
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
            for grain in grains {
                if !grain.keep().await {
                    return;
                }
            }
        }
    }
}

use crate::{
    grain::Lease,
    shell_capnp::{self as api, powerbox_request, powerbox_selection},
};
use serde_json::{json, Value};
use std::{cell::Cell, rc::Rc};

pub(crate) struct Request {
    grain: Rc<Lease>,
    path: Vec<String>,
    canceled: Cell<bool>,
}
fn nonce() -> capnp::Result<String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| capnp::Error::failed("Cannot create request".into()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
pub(crate) fn query(input: capnp::text_list::Reader<'_>) -> capnp::Result<Vec<String>> {
    if input.len() > 32 {
        return Err(capnp::Error::failed("Too many query descriptors".into()));
    }
    let result: Vec<String> = input
        .iter()
        .map(|s| Ok(s?.to_str()?.to_owned()))
        .collect::<capnp::Result<_>>()?;
    if result.iter().any(|s| s.len() > 8192)
        || result.iter().map(String::len).sum::<usize>() > 60000
    {
        return Err(capnp::Error::failed("Query too large".into()));
    }
    Ok(result)
}
impl Request {
    pub(crate) async fn open(
        grain: Rc<Lease>,
        mut path: Vec<String>,
        query: Vec<String>,
    ) -> capnp::Result<(Self, Value)> {
        if path.len() >= 4 {
            return Err(capnp::Error::failed("Too many nested requests".into()));
        }
        path.push(nonce()?);
        let request = Self {
            grain,
            path,
            canceled: Cell::new(false),
        };
        let value = request.call("begin", json!({"query":query})).await?;
        Ok((request, value))
    }
    async fn call(&self, operation: &str, mut data: Value) -> capnp::Result<Value> {
        if self.canceled.get() && operation != "cancel" {
            return Err(capnp::Error::failed("Connection request closed".into()));
        }
        let mut operation = operation.to_owned();
        for id in self.path.iter().skip(1).rev() {
            data = json!({"mode":"nested","nestedRequest":id,"nestedOperation":operation,"nestedInput":data});
            operation = "select".to_owned();
        }
        data["request"] = json!(self.path[0]);
        data["operation"] = json!(operation);
        let mut value = self.grain.sharing_call("powerbox", data).await?;
        for _ in self.path.iter().skip(1) {
            value = value["view"].take();
        }
        Ok(value)
    }
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub(crate) fn write(v: &Value, mut out: api::powerbox_state::Builder<'_>) -> capnp::Result<()> {
    match text(v, "status") {
        "choices" => {
            let mut choices = out.init_choices();
            choices.set_limited(v["limited"].as_bool().unwrap_or(false));
            choices.set_legacy(v["legacy"].as_bool().unwrap_or(false));
            let rows = v["candidates"]
                .as_array()
                .ok_or_else(|| capnp::Error::failed("Invalid candidates".into()))?;
            let mut list = choices.init_candidates(rows.len() as u32);
            for (i, row) in rows.iter().enumerate() {
                let mut item = list.reborrow().get(i as u32);
                item.set_key(text(row, "key"));
                item.set_title(text(row, "title"));
                item.set_detail(text(row, "detail"));
                item.set_icon_src(text(row, "iconSrc"));
                item.set_ui_view(row["uiView"].as_bool().unwrap_or(false));
                item.set_hosted_object(row["hostedObject"].as_bool().unwrap_or(false));
                item.set_url_input(row["urlInput"].as_bool().unwrap_or(false));
                item.set_email_input(row["emailInput"].as_bool().unwrap_or(false));
                item.set_github(row["github"].as_bool().unwrap_or(false));
                if let Some(roles) = row["roles"].as_array() {
                    let mut list = item.init_roles(roles.len() as u32);
                    for (j, role) in roles.iter().enumerate() {
                        let mut item = list.reborrow().get(j as u32);
                        item.set_key(text(role, "key"));
                        item.set_title(text(role, "title"));
                    }
                }
            }
        }
        "provider" => {
            let mut item = out.init_provider();
            item.set_title(text(v, "title"));
            item.set_url(text(v, "url"));
            item.set_origin(text(v, "origin"));
        }
        "oauth" => {
            let mut item = out.init_oauth();
            item.set_request(text(v, "request"));
            item.set_url(text(v, "url"));
        }
        "email" => out.set_email(text(v, "address")),
        "complete" => {
            let mut item = out.init_complete();
            item.set_token(text(v, "token"));
            item.set_descriptor(text(v, "descriptor"));
        }
        "waiting" => out.set_waiting(()),
        "" => out.set_closed(()),
        _ => return Err(capnp::Error::failed("Unsupported Powerbox state".into())),
    }
    Ok(())
}
impl powerbox_request::Server for Request {
    async fn select(
        self: Rc<Self>,
        params: powerbox_request::SelectParams,
        mut results: powerbox_request::SelectResults,
    ) -> capnp::Result<()> {
        let selection = params.get()?.get_selection()?;
        let key = selection.get_key()?.to_str()?;
        use powerbox_selection::Which;
        let (mode, field, value) = match selection.which()? {
            Which::Direct(()) => ("direct", "key", key),
            Which::View(v) => ("view", "role", v?.to_str()?),
            Which::Hosted(()) => ("hosted", "key", key),
            Which::Webkey(v) => ("webkey", "url", v?.to_str()?),
            Which::Url(v) => ("url", "url", v?.to_str()?),
            Which::SendEmail(v) => ("sendEmail", "email", v?.to_str()?),
            Which::VerifyEmail(v) => ("verifyEmail", "code", v?.to_str()?),
            Which::StartGithub(()) => ("githubStart", "key", key),
            Which::FinishGithub(()) => ("githubFinish", "key", key),
        };
        if key.len() > 320 || value.len() > 2048 {
            return Err(capnp::Error::failed("Selection too large".into()));
        }
        let mut data = json!({"key":key,"mode":mode});
        data[field] = json!(value);
        let value = self.call("select", data).await?;
        write(&value, results.get().init_result().init_value())
    }
    async fn poll(
        self: Rc<Self>,
        _: powerbox_request::PollParams,
        mut results: powerbox_request::PollResults,
    ) -> capnp::Result<()> {
        let value = self.call("poll", json!({})).await?;
        write(&value, results.get().init_result().init_value())
    }
    async fn cancel(
        self: Rc<Self>,
        _: powerbox_request::CancelParams,
        _: powerbox_request::CancelResults,
    ) -> capnp::Result<()> {
        if !self.canceled.replace(true) {
            self.call("cancel", json!({})).await?;
        }
        Ok(())
    }
    async fn nested(
        self: Rc<Self>,
        params: powerbox_request::NestedParams,
        mut results: powerbox_request::NestedResults,
    ) -> capnp::Result<()> {
        if self.canceled.get() {
            return Err(capnp::Error::failed("Connection request closed".into()));
        }
        let (child, value) = Self::open(
            self.grain.clone(),
            self.path.clone(),
            query(params.get()?.get_query()?)?,
        )
        .await?;
        write(&value, results.get().init_result().init_value())?;
        results.get().set_request(capnp_rpc::new_client(child));
        Ok(())
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        if !self.canceled.replace(true) {
            let cleanup = Self {
                grain: self.grain.clone(),
                path: self.path.clone(),
                canceled: Cell::new(true),
            };
            tokio::task::spawn_local(async move {
                let _ = cleanup.call("cancel", json!({})).await;
            });
        }
    }
}

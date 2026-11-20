use crate::{bridge, shell_capnp as api};
use serde_json::{json, Value};
use std::rc::Rc;

pub struct Installer(pub bridge::Session, pub crate::observation::Scope);
pub struct Account(pub bridge::Session);

// The bridge remains an implementation detail; browser payloads are typed.
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn boolean(value: &Value, key: &str) -> bool {
    value[key].as_bool().unwrap_or(false)
}
fn count(value: &Value, key: &str) -> u32 {
    value[key].as_u64().unwrap_or(0).min(u32::MAX as u64) as u32
}
fn failure(error: bridge::Error, mut out: api::failure::Builder<'_>) -> capnp::Result<()> {
    let (status, message) = error;
    let code = match status.as_u16() {
        400 | 413 | 422 => api::FailureCode::InvalidInput,
        401 => api::FailureCode::SignInRequired,
        403 => api::FailureCode::PermissionDenied,
        404 => api::FailureCode::NotFound,
        409 => api::FailureCode::Conflict,
        429 => api::FailureCode::RateLimited,
        _ => {
            return Err(capnp::Error::failed(
                "The service is unavailable. The operation may not have completed.".into(),
            ))
        }
    };
    out.set_code(code);
    out.set_message(message);
    Ok(())
}
macro_rules! complete {
    ($result:expr, $out:expr, $writer:ident) => {{
        let out = $out;
        match $result {
            Ok(value) => $writer(&value, out.init_value()),
            Err(error) => failure(error, out.init_failure()),
        }
    }};
}
fn url(value: &Value, mut out: api::url::Builder<'_>) -> capnp::Result<()> {
    out.set_url(text(value, "uploadUrl"));
    Ok(())
}
fn catalog(value: &Value, mut out: api::install_catalog::Builder<'_>) -> capnp::Result<()> {
    out.set_market_url(text(value, "marketUrl"));
    let rows = value["updates"]
        .as_array()
        .ok_or_else(|| capnp::Error::failed("Invalid install catalog".into()))?;
    let mut list = out.init_updates(rows.len() as u32);
    for (i, row) in rows.iter().enumerate() {
        let mut item = list.reborrow().get(i as u32);
        item.set_package_id(text(row, "packageId"));
        item.set_title(text(row, "title"));
        item.set_version(text(row, "version"));
        item.set_url(text(row, "url"));
    }
    Ok(())
}
fn installation(value: &Value, mut out: api::installation_state::Builder<'_>) -> capnp::Result<()> {
    out.set_stage(match text(value, "status") {
        "missing" => api::PackageStage::Missing,
        "download" => api::PackageStage::Download,
        "verify" => api::PackageStage::Verify,
        "unpack" => api::PackageStage::Unpack,
        "analyze" => api::PackageStage::Analyze,
        "ready" => api::PackageStage::Ready,
        "failed" => api::PackageStage::Failed,
        "delete" => api::PackageStage::Delete,
        _ => api::PackageStage::Unknown,
    });
    out.set_package_id(text(value, "packageId"));
    out.set_error(text(value, "error"));
    out.set_app_id(text(value, "appId"));
    out.set_title(text(value, "title"));
    out.set_description(text(value, "description"));
    out.set_version(text(value, "version"));
    out.set_fingerprint(text(value, "fingerprint"));
    out.set_icon_src(text(value, "iconSrc"));
    out.set_installed(boolean(value, "installed"));
    out.set_newer_installed(boolean(value, "newerInstalled"));
    out.set_progress(value["progress"].as_f64().unwrap_or(0.0));
    out.set_older_grains(count(value, "olderGrains"));
    Ok(())
}
fn account(value: &Value, mut out: api::account_state::Builder<'_>) -> capnp::Result<()> {
    out.set_email_enabled(boolean(value, "emailEnabled"));
    out.set_github_enabled(boolean(value, "githubEnabled"));
    if let Some(oauth) = value["oauth"].as_object() {
        let mut target = out.reborrow().init_oauth();
        target.set_request(oauth.get("request").and_then(Value::as_str).unwrap_or(""));
        target.set_url(oauth.get("url").and_then(Value::as_str).unwrap_or(""));
        target.set_pending(
            oauth
                .get("pending")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        );
    }
    if let Some(rows) = value["emails"].as_array() {
        let mut list = out.reborrow().init_emails(rows.len() as u32);
        for (i, row) in rows.iter().enumerate() {
            let mut item = list.reborrow().get(i as u32);
            item.set_email(text(row, "email"));
            item.set_verified(boolean(row, "verified"));
            item.set_primary(boolean(row, "primary"));
        }
    }
    if let Some(rows) = value["credentials"].as_array() {
        let mut list = out.init_credentials(rows.len() as u32);
        for (i, row) in rows.iter().enumerate() {
            let mut item = list.reborrow().get(i as u32);
            item.set_id(text(row, "id"));
            item.set_service(text(row, "service"));
            item.set_name(text(row, "name"));
            item.set_picture_url(text(row, "pictureUrl"));
            item.set_login(boolean(row, "login"));
        }
    }
    Ok(())
}
impl api::installer::Server for Installer {
    async fn open(
        self: Rc<Self>,
        params: api::installer::OpenParams,
        mut results: api::installer::OpenResults,
    ) -> capnp::Result<()> {
        let input = params.get()?;
        let id = input.get_package_id()?.to_str()?;
        let url = input.get_url()?.to_str()?;
        if id.len() != 32 || !id.bytes().all(|c| c.is_ascii_hexdigit()) || url.len() > 2048 {
            return Err(capnp::Error::failed("Invalid package".into()));
        }
        results
            .get()
            .set_installation(capnp_rpc::new_client(Installation {
                session: self.0.clone(),
                observations: self.1.clone(),
                id: id.to_owned(),
                url: url.to_owned(),
                watching: std::cell::Cell::new(false),
            }));
        Ok(())
    }

    async fn catalog(
        self: Rc<Self>,
        params: api::installer::CatalogParams,
        mut results: api::installer::CatalogResults,
    ) -> capnp::Result<()> {
        let _ = params;
        let operation = "catalog";
        let data = json!({});
        let value = self
            .0
            .call("install", json!({"operation":operation,"data":data}))
            .await;
        complete!(value, results.get().init_result(), catalog)
    }
    async fn status(
        self: Rc<Self>,
        params: api::installer::StatusParams,
        mut results: api::installer::StatusResults,
    ) -> capnp::Result<()> {
        let input = params.get()?;
        let operation = "status";
        let data = json!({"packageId":input.get_package_id()?.to_str()?});
        let value = self
            .0
            .call("install", json!({"operation":operation,"data":data}))
            .await;
        complete!(value, results.get().init_result(), installation)
    }
    async fn download(
        self: Rc<Self>,
        params: api::installer::DownloadParams,
        mut results: api::installer::DownloadResults,
    ) -> capnp::Result<()> {
        let input = params.get()?;
        let operation = if input.get_retry() {
            "retry"
        } else {
            "download"
        };
        let data =
            json!({"packageId":input.get_package_id()?.to_str()?,"url":input.get_url()?.to_str()?});
        let value = self
            .0
            .call("install", json!({"operation":operation,"data":data}))
            .await;
        complete!(value, results.get().init_result(), installation)
    }
    async fn confirm(
        self: Rc<Self>,
        params: api::installer::ConfirmParams,
        mut results: api::installer::ConfirmResults,
    ) -> capnp::Result<()> {
        let input = params.get()?;
        let operation = "confirm";
        let data = json!({"packageId":input.get_package_id()?.to_str()?});
        let value = self
            .0
            .call("install", json!({"operation":operation,"data":data}))
            .await;
        complete!(value, results.get().init_result(), installation)
    }
    async fn upgrade(
        self: Rc<Self>,
        params: api::installer::UpgradeParams,
        mut results: api::installer::UpgradeResults,
    ) -> capnp::Result<()> {
        let input = params.get()?;
        let operation = "upgrade";
        let data = json!({"packageId":input.get_package_id()?.to_str()?});
        let value = self
            .0
            .call("install", json!({"operation":operation,"data":data}))
            .await;
        complete!(value, results.get().init_result(), installation)
    }
    async fn upload(
        self: Rc<Self>,
        params: api::installer::UploadParams,
        mut results: api::installer::UploadResults,
    ) -> capnp::Result<()> {
        let _ = params;
        let operation = "upload";
        let data = json!({});
        let value = self
            .0
            .call("install", json!({"operation":operation,"data":data}))
            .await;
        complete!(value, results.get().init_result(), url)
    }
}
impl api::account::Server for Account {
    async fn read(
        self: Rc<Self>,
        params: api::account::ReadParams,
        mut results: api::account::ReadResults,
    ) -> capnp::Result<()> {
        let _ = params;
        let data = json!({});
        let value = self
            .0
            .call("accountSettings", json!({"operation":"state","data":data}))
            .await;
        complete!(value, results.get().init_result(), account)
    }
    async fn set_primary_email(
        self: Rc<Self>,
        params: api::account::SetPrimaryEmailParams,
        mut results: api::account::SetPrimaryEmailResults,
    ) -> capnp::Result<()> {
        let input = params.get()?;
        let data = json!({"email":input.get_email()?.to_str()?});
        let value = self
            .0
            .call(
                "accountSettings",
                json!({"operation":"primary","data":data}),
            )
            .await;
        complete!(value, results.get().init_result(), account)
    }
    async fn send_email(
        self: Rc<Self>,
        params: api::account::SendEmailParams,
        mut results: api::account::SendEmailResults,
    ) -> capnp::Result<()> {
        let input = params.get()?;
        let data =
            json!({"email":input.get_email()?.to_str()?,"allowLogin":input.get_allow_login()});
        let value = self
            .0
            .call(
                "accountSettings",
                json!({"operation":"sendEmail","data":data}),
            )
            .await;
        complete!(value, results.get().init_result(), account)
    }
    async fn verify_email(
        self: Rc<Self>,
        params: api::account::VerifyEmailParams,
        mut results: api::account::VerifyEmailResults,
    ) -> capnp::Result<()> {
        let input = params.get()?;
        let data = json!({"email":input.get_email()?.to_str()?,"code":input.get_code()?.to_str()?,"allowLogin":input.get_allow_login()});
        let value = self
            .0
            .call(
                "accountSettings",
                json!({"operation":"verifyEmail","data":data}),
            )
            .await;
        complete!(value, results.get().init_result(), account)
    }
    async fn unlink(
        self: Rc<Self>,
        params: api::account::UnlinkParams,
        mut results: api::account::UnlinkResults,
    ) -> capnp::Result<()> {
        let input = params.get()?;
        let data = json!({"id":input.get_credential_id()?.to_str()?});
        let value = self
            .0
            .call("accountSettings", json!({"operation":"unlink","data":data}))
            .await;
        complete!(value, results.get().init_result(), account)
    }
    async fn set_login_allowed(
        self: Rc<Self>,
        params: api::account::SetLoginAllowedParams,
        mut results: api::account::SetLoginAllowedResults,
    ) -> capnp::Result<()> {
        let input = params.get()?;
        let data =
            json!({"id":input.get_credential_id()?.to_str()?,"allowLogin":input.get_allowed()});
        let value = self
            .0
            .call(
                "accountSettings",
                json!({"operation":"allowLogin","data":data}),
            )
            .await;
        complete!(value, results.get().init_result(), account)
    }
    async fn start_github(
        self: Rc<Self>,
        params: api::account::StartGithubParams,
        mut results: api::account::StartGithubResults,
    ) -> capnp::Result<()> {
        let _ = params;
        let data = json!({});
        let value = self
            .0
            .call(
                "accountSettings",
                json!({"operation":"githubStart","data":data}),
            )
            .await;
        complete!(value, results.get().init_result(), account)
    }
    async fn finish_github(
        self: Rc<Self>,
        params: api::account::FinishGithubParams,
        mut results: api::account::FinishGithubResults,
    ) -> capnp::Result<()> {
        let input = params.get()?;
        let data = json!({"request":input.get_request()?.to_str()?});
        let value = self
            .0
            .call(
                "accountSettings",
                json!({"operation":"githubFinish","data":data}),
            )
            .await;
        complete!(value, results.get().init_result(), account)
    }
    async fn cancel_github(
        self: Rc<Self>,
        params: api::account::CancelGithubParams,
        mut results: api::account::CancelGithubResults,
    ) -> capnp::Result<()> {
        let input = params.get()?;
        let data = json!({"request":input.get_request()?.to_str()?});
        let value = self
            .0
            .call(
                "accountSettings",
                json!({"operation":"githubCancel","data":data}),
            )
            .await;
        complete!(value, results.get().init_result(), account)
    }
}

struct Installation {
    observations: crate::observation::Scope,
    session: bridge::Session,
    id: String,
    url: String,
    watching: std::cell::Cell<bool>,
}
impl Installation {
    async fn call(&self, operation: &str) -> Result<Value, bridge::Error> {
        self.session
            .call(
                "install",
                json!({"operation":operation,"data":{"packageId":self.id,"url":self.url}}),
            )
            .await
    }
}
impl api::installation::Server for Installation {
    async fn read(
        self: Rc<Self>,
        _: api::installation::ReadParams,
        mut results: api::installation::ReadResults,
    ) -> capnp::Result<()> {
        let value = self.call("status").await;
        complete!(value, results.get().init_result(), installation)
    }
    async fn download(
        self: Rc<Self>,
        params: api::installation::DownloadParams,
        mut results: api::installation::DownloadResults,
    ) -> capnp::Result<()> {
        let value = self
            .call(if params.get()?.get_retry() {
                "retry"
            } else {
                "download"
            })
            .await;
        complete!(value, results.get().init_result(), installation)
    }
    async fn confirm(
        self: Rc<Self>,
        _: api::installation::ConfirmParams,
        mut results: api::installation::ConfirmResults,
    ) -> capnp::Result<()> {
        let value = self.call("confirm").await;
        complete!(value, results.get().init_result(), installation)
    }
    async fn upgrade(
        self: Rc<Self>,
        _: api::installation::UpgradeParams,
        mut results: api::installation::UpgradeResults,
    ) -> capnp::Result<()> {
        let value = self.call("upgrade").await;
        complete!(value, results.get().init_result(), installation)
    }
    async fn watch(
        self: Rc<Self>,
        params: api::installation::WatchParams,
        mut results: api::installation::WatchResults,
    ) -> capnp::Result<()> {
        let observer = params.get()?.get_observer()?;
        if self.watching.replace(true) {
            return Err(capnp::Error::failed(
                "Already observing this installation".into(),
            ));
        }
        let owner = self.clone();
        let scope = self.observations.clone();
        let subscription = scope.spawn(
            async move {
                let mut previous = String::new();
                loop {
                    let value = owner.call("status").await;
                    let version = match &value {
                        Ok(value) => value.to_string(),
                        Err((status, message)) => format!("{status}:{message}"),
                    };
                    if version != previous {
                        let mut request = observer.changed_request();
                        complete!(value, request.get().init_result(), installation)?;
                        tokio::time::timeout(
                            std::time::Duration::from_secs(10),
                            request.send().promise,
                        )
                        .await
                        .map_err(|_| {
                            capnp::Error::failed("Installation observer timed out".into())
                        })??;
                        previous = version;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                }
            },
            move || self.watching.set(false),
        )?;
        results.get().set_subscription(subscription);
        Ok(())
    }
}

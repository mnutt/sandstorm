use crate::shell_capnp::shell;
use std::{rc::Rc, time::Duration};
use tokio::sync::watch;

#[derive(Clone, PartialEq)]
struct Entry {
    id: u32,
    title: String,
    body: String,
    real: Option<crate::bridge::Entry>,
}
#[derive(Clone)]
struct Projection {
    revision: u32,
    next_id: u32,
    entries: Vec<Entry>,
    total: u32,
    grains: Vec<crate::bridge::Grain>,
    grains_limited: bool,
    profile_version: String,
    has_unread: bool,
    account_picture_url: String,
}

#[derive(Clone)]
pub struct Shell {
    interop: Rc<crate::interop::Link>,
    state: watch::Sender<Projection>,
    pub observations: crate::observation::Scope,
    session: Option<crate::bridge::Session>,
    version: String,
    pub grain: Option<Rc<crate::grain::Scope>>,
}

impl Shell {
    pub fn new(
        interop: Rc<crate::interop::Link>,
        session: Option<crate::bridge::Session>,
        initial: Option<crate::bridge::Snapshot>,
    ) -> capnp::Result<Self> {
        let entries = if let Some(initial) = &initial {
            initial
                .entries
                .iter()
                .cloned()
                .map(|real| Entry {
                    id: 0,
                    title: real.title.clone(),
                    body: real.body.clone(),
                    real: Some(real),
                })
                .collect()
        } else {
            vec![Entry {
                id: 1,
                title: "Welcome to the Rust shell".into(),
                body: "This is a test notification. Your existing Sandstorm data is unchanged."
                    .into(),
                real: None,
            }]
        };
        let version = initial
            .as_ref()
            .map(|snapshot| snapshot.version.clone())
            .unwrap_or_default();
        let (state, _) = watch::channel(Projection {
            profile_version: initial
                .as_ref()
                .map(|s| s.profile_version.clone())
                .unwrap_or_default(),
            account_picture_url: initial
                .as_ref()
                .map(|s| s.account_picture_url.clone())
                .unwrap_or_default(),
            has_unread: initial.as_ref().is_some_and(|s| s.has_unread),
            revision: 0,
            next_id: 2,
            entries,
            grains: initial
                .as_ref()
                .map(|snapshot| snapshot.grains.clone())
                .unwrap_or_default(),
            grains_limited: initial
                .as_ref()
                .is_some_and(|snapshot| snapshot.grains_limited),
            total: initial.map(|snapshot| snapshot.total).unwrap_or(1),
        });
        let grain = session.clone().map(crate::grain::Scope::new).transpose()?;
        Ok(Self {
            grain,
            interop,
            state,
            observations: crate::observation::Scope::default(),
            session,
            version,
        })
    }

    pub async fn synchronize(&self) {
        let Some(session) = &self.session else {
            return std::future::pending().await;
        };
        let mut version = self.version.clone();
        loop {
            // Mongo observation wakes this bounded long-poll on legacy or Rust writes.
            // The bridge revalidates authority while waiting and before returning data.
            let Ok(snapshot) = session.watch(&version, serde_json::json!({})).await else {
                return;
            };
            version = snapshot.version.clone();
            self.state.send_if_modified(|state| {
                let entries: Vec<_> = snapshot
                    .entries
                    .into_iter()
                    .map(|real| Entry {
                        id: 0,
                        title: real.title.clone(),
                        body: real.body.clone(),
                        real: Some(real),
                    })
                    .collect();
                if state.has_unread == snapshot.has_unread
                    && state.account_picture_url == snapshot.account_picture_url
                    && state.profile_version == snapshot.profile_version
                    && state.entries == entries
                    && state.total == snapshot.total
                    && state.grains == snapshot.grains
                    && state.grains_limited == snapshot.grains_limited
                {
                    return false;
                }
                state.has_unread = snapshot.has_unread;
                state.account_picture_url = snapshot.account_picture_url;
                state.profile_version = snapshot.profile_version;
                state.grains = snapshot.grains;
                state.grains_limited = snapshot.grains_limited;
                state.entries = entries;
                state.total = snapshot.total;
                state.revision += 1;
                true
            });
        }
    }

    async fn mutate_real(&self, action: &str, input: serde_json::Value) -> capnp::Result<()> {
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| capnp::Error::failed("Not connected to a real account".into()))?;
        session
            .call(action, input)
            .await
            .map_err(|(_, error)| capnp::Error::failed(error))?;
        Ok(())
    }
}

impl shell::Server for Shell {
    async fn watch_grains(
        self: Rc<Self>,
        params: shell::WatchGrainsParams,
        mut results: shell::WatchGrainsResults,
    ) -> capnp::Result<()> {
        let input = params.get()?;
        let query = input.get_query()?;
        let page = query.get_page();
        let search = query.get_search()?.to_str()?.to_owned();
        let app_id = query.get_app_id()?.to_str()?.to_owned();
        let sort = match query.get_sort()? {
            crate::shell_capnp::GrainSort::Recent => "recent",
            crate::shell_capnp::GrainSort::Title => "title",
        };
        let ownership = match query.get_ownership()? {
            crate::shell_capnp::GrainOwnership::All => "all",
            crate::shell_capnp::GrainOwnership::Owned => "owned",
            crate::shell_capnp::GrainOwnership::Shared => "shared",
        };
        let filter =
            serde_json::json!({"search":search,"appId":app_id,"sort":sort,"ownership":ownership});
        let observer = input.get_observer()?;
        let session = self
            .session
            .clone()
            .ok_or_else(|| capnp::Error::failed("Sign in to browse grains".into()))?;
        let subscription = self.observations.spawn(
            async move {
                let mut version = "0".repeat(64);
                let mut previous = None;
                loop {
                    let snapshot = session
                        .watch_query(
                            &version,
                            serde_json::json!({"grains":page}),
                            Some(filter.clone()),
                        )
                        .await
                        .map_err(|(_, e)| capnp::Error::failed(e))?;
                    version = snapshot.version.clone();
                    let signature = (snapshot.grains.clone(), snapshot.grains_limited);
                    if previous.as_ref() == Some(&signature) {
                        continue;
                    }
                    let mut request = observer.replace_request();
                    {
                        let mut out = request.get().init_page();
                        out.set_page(page);
                        out.set_has_more(snapshot.grains_limited);
                        let mut list = out.init_grains(snapshot.grains.len() as u32);
                        for (i, grain) in snapshot.grains.iter().enumerate() {
                            write_grain(grain, list.reborrow().get(i as u32));
                        }
                    }
                    tokio::time::timeout(Duration::from_secs(10), request.send().promise)
                        .await
                        .map_err(|_| capnp::Error::failed("Grain observer timed out".into()))??;
                    previous = Some(signature);
                }
            },
            || {},
        )?;
        results.get().set_subscription(subscription);
        Ok(())
    }
    async fn watch_notifications(
        self: Rc<Self>,
        params: shell::WatchNotificationsParams,
        mut results: shell::WatchNotificationsResults,
    ) -> capnp::Result<()> {
        let input = params.get()?;
        let page = input.get_page();
        let observer = input.get_observer()?;
        let session = self
            .session
            .clone()
            .ok_or_else(|| capnp::Error::failed("Sign in to browse notifications".into()))?;
        let subscription = self.observations.spawn(
            async move {
                let mut version = "0".repeat(64);
                let mut previous = None;
                loop {
                    let snapshot = session
                        .watch_query(&version, serde_json::json!({"notifications":page}), None)
                        .await
                        .map_err(|(_, e)| capnp::Error::failed(e))?;
                    version = snapshot.version.clone();
                    let signature = (snapshot.entries.clone(), snapshot.total);
                    if previous.as_ref() == Some(&signature) {
                        continue;
                    }
                    let mut request = observer.replace_request();
                    {
                        let mut out = request.get().init_page();
                        out.set_page(page);
                        out.set_total(snapshot.total);
                        let mut list = out.init_entries(snapshot.entries.len() as u32);
                        for (i, entry) in snapshot.entries.iter().enumerate() {
                            write_notification(entry, list.reborrow().get(i as u32));
                        }
                    }
                    tokio::time::timeout(Duration::from_secs(10), request.send().promise)
                        .await
                        .map_err(|_| {
                            capnp::Error::failed("Notification observer timed out".into())
                        })??;
                    previous = Some(signature);
                }
            },
            || {},
        )?;
        results.get().set_subscription(subscription);
        Ok(())
    }

    async fn installer(
        self: Rc<Self>,
        _: shell::InstallerParams,
        mut results: shell::InstallerResults,
    ) -> capnp::Result<()> {
        let session = self
            .session
            .clone()
            .ok_or_else(|| capnp::Error::failed("Sign in to install apps".into()))?;
        results
            .get()
            .set_installer(capnp_rpc::new_client(crate::workflow::Installer(
                session,
                self.observations.clone(),
            )));
        Ok(())
    }
    async fn account(
        self: Rc<Self>,
        _: shell::AccountParams,
        mut results: shell::AccountResults,
    ) -> capnp::Result<()> {
        let session = self
            .session
            .clone()
            .ok_or_else(|| capnp::Error::failed("Sign in to manage your account".into()))?;
        results
            .get()
            .set_account(capnp_rpc::new_client(crate::workflow::Account(session)));
        Ok(())
    }

    async fn upload_picture(
        self: Rc<Self>,
        _: shell::UploadPictureParams,
        mut results: shell::UploadPictureResults,
    ) -> capnp::Result<()> {
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| capnp::Error::failed("Sign in to upload a picture".into()))?;
        let value = session
            .call("uploadPicture", serde_json::json!({}))
            .await
            .map_err(|(_, error)| capnp::Error::failed(error))?;
        let url = value
            .get("uploadUrl")
            .and_then(|v| v.as_str())
            .ok_or_else(|| capnp::Error::failed("Invalid upload URL".into()))?;
        results.get().set_upload_url(url);
        Ok(())
    }

    async fn notification(
        self: Rc<Self>,
        params: shell::NotificationParams,
        mut results: shell::NotificationResults,
    ) -> capnp::Result<()> {
        let session = self
            .session
            .clone()
            .ok_or_else(|| capnp::Error::failed("Sign in to view notifications".into()))?;
        let key = params.get()?.get_key()?.to_str()?.to_owned();
        results
            .get()
            .set_notice(capnp_rpc::new_client(crate::notification::Notice::new(
                session, key,
            )));
        Ok(())
    }

    async fn get_profile(
        self: Rc<Self>,
        _: shell::GetProfileParams,
        mut results: shell::GetProfileResults,
    ) -> capnp::Result<()> {
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| capnp::Error::failed("Profile requires a signed-in account".into()))?;
        let value = session
            .call("getProfile", serde_json::json!({}))
            .await
            .map_err(|(_, error)| capnp::Error::failed(error))?;
        let profile: crate::bridge::AccountProfile = serde_json::from_value(value)
            .map_err(|_| capnp::Error::failed("Invalid profile response".into()))?;
        profile.write(results.get().init_profile());
        Ok(())
    }

    async fn update_profile(
        self: Rc<Self>,
        params: shell::UpdateProfileParams,
        mut results: shell::UpdateProfileResults,
    ) -> capnp::Result<()> {
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| capnp::Error::failed("Profile requires a signed-in account".into()))?;
        let input = params.get()?;
        let name = input.get_name()?.to_str()?;
        let handle = input.get_handle()?.to_str()?;
        let pronoun = input.get_pronoun()?.to_str()?;
        let value = session
            .call(
                "updateProfile",
                serde_json::json!({
                    "profile": { "name": name, "handle": handle, "pronoun": pronoun }
                }),
            )
            .await
            .map_err(|(_, error)| capnp::Error::failed(error))?;
        let profile: crate::bridge::AccountProfile = serde_json::from_value(value)
            .map_err(|_| capnp::Error::failed("Invalid profile response".into()))?;
        profile.write(results.get().init_profile());
        Ok(())
    }

    async fn list_apps(
        self: Rc<Self>,
        params: shell::ListAppsParams,
        mut results: shell::ListAppsResults,
    ) -> capnp::Result<()> {
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| capnp::Error::failed("Apps require a signed-in account".into()))?;
        let input = params.get()?;
        let page = input.get_page();
        let app_id = input.get_app_id()?.to_str()?;
        let value = session
            .call("listApps", serde_json::json!({"page":page,"appId":app_id}))
            .await
            .map_err(|(_, error)| capnp::Error::failed(error))?;
        let list: crate::bridge::AppList = serde_json::from_value(value)
            .map_err(|_| capnp::Error::failed("Invalid app list".into()))?;
        let mut out = results.get();
        out.set_limited(list.limited || list.actions.len() > 100);
        let mut actions = out.init_actions(list.actions.len().min(100) as u32);
        for (i, action) in list.actions.iter().take(100).enumerate() {
            let mut out = actions.reborrow().get(i as u32);
            out.set_key(&action.key);
            out.set_title(&action.title);
            out.set_app_title(&action.app_title);
            out.set_short_description(&action.short_description);
            out.set_app_id(&action.app_id);
            out.set_icon_src(&action.icon_src);
            out.set_last_used(&action.last_used);
            out.set_grain_count(action.grain_count);
        }
        Ok(())
    }

    async fn create_grain(
        self: Rc<Self>,
        params: shell::CreateGrainParams,
        mut results: shell::CreateGrainResults,
    ) -> capnp::Result<()> {
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| capnp::Error::failed("Creation requires a signed-in account".into()))?;
        let input = params.get()?;
        let action = input.get_action_id()?.to_str()?;
        let title = input.get_title()?.to_str()?;
        let value = session
            .call(
                "createGrain",
                serde_json::json!({ "actionId": action, "title": title }),
            )
            .await
            .map_err(|(_, error)| capnp::Error::failed(error))?;
        let grain_id = value["grainId"]
            .as_str()
            .ok_or_else(|| capnp::Error::failed("Missing created grain ID".into()))?;
        results.get().set_grain_id(grain_id);
        Ok(())
    }

    async fn open_grain(
        self: Rc<Self>,
        params: shell::OpenGrainParams,
        mut results: shell::OpenGrainResults,
    ) -> capnp::Result<()> {
        let scope = self
            .grain
            .as_ref()
            .ok_or_else(|| capnp::Error::failed("Grains require a signed-in account".into()))?;
        let grain_id = params.get()?.get_grain_id()?.to_str()?;
        let grain_id = grain_id.to_owned();
        let (view, session) = scope.open(grain_id).await?;
        let mut out = results.get();
        out.set_session(session);
        let mut out = out.init_view();
        out.set_grain_id(&view.grain_id);
        out.set_origin(&view.origin);
        out.set_url(&view.url);
        out.set_title(&view.title);
        out.set_owner_title(&view.owner_title);
        out.set_icon_src(&view.icon_src);
        out.set_main_href(&view.main_href);
        Ok(())
    }

    async fn dismiss_real(
        self: Rc<Self>,
        params: shell::DismissRealParams,
        _: shell::DismissRealResults,
    ) -> capnp::Result<()> {
        let key = params.get()?.get_key()?.to_str()?;
        let key = key.to_owned();
        self.mutate_real("dismiss", serde_json::json!({ "id": key }))
            .await
    }

    async fn mark_read(
        self: Rc<Self>,
        params: shell::MarkReadParams,
        _: shell::MarkReadResults,
    ) -> capnp::Result<()> {
        let input = params.get()?;
        let key = input.get_key()?.to_str()?;
        let payload = if key.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::json!({"key":key})
        };
        self.mutate_real("read", payload).await
    }

    async fn interop(
        self: Rc<Self>,
        _: shell::InteropParams,
        mut results: shell::InteropResults,
    ) -> capnp::Result<()> {
        results.get().set_fixture(self.interop.client().await?);
        Ok(())
    }

    async fn watch(
        self: Rc<Self>,
        params: shell::WatchParams,
        mut results: shell::WatchResults,
    ) -> capnp::Result<()> {
        let observer = params.get()?.get_observer()?;
        let mut receiver = self.state.subscribe();
        let subscription = self.observations.spawn(
            async move {
                loop {
                    let snapshot = receiver.borrow_and_update().clone();
                    let mut request = observer.replace_request();
                    {
                        let mut out = request.get().init_snapshot();
                        out.set_account_picture_url(&snapshot.account_picture_url);
                        out.set_profile_version(&snapshot.profile_version);
                        out.set_has_unread(snapshot.has_unread);
                        out.set_revision(snapshot.revision);
                        out.set_total(snapshot.total);
                        out.set_grains_limited(snapshot.grains_limited);
                        {
                            let mut grains =
                                out.reborrow().init_grains(snapshot.grains.len() as u32);
                            for (i, grain) in snapshot.grains.iter().enumerate() {
                                let mut out = grains.reborrow().get(i as u32);
                                out.set_key(&grain.key);
                                out.set_title(&grain.title);
                                out.set_owner_title(&grain.owner_title);
                                out.set_href(&grain.href);
                                out.set_owned(grain.owned);
                                out.set_last_used(&grain.last_used);
                                out.set_app_title(&grain.app_title);
                                out.set_app_id(&grain.app_id);
                                out.set_icon_src(&grain.icon_src);
                            }
                        }
                        let mut entries = out.init_entries(snapshot.entries.len() as u32);
                        for (i, entry) in snapshot.entries.iter().enumerate() {
                            let mut out = entries.reborrow().get(i as u32);
                            out.set_id(entry.id);
                            out.set_title(&entry.title);
                            out.set_body(&entry.body);
                            if let Some(real) = &entry.real {
                                out.set_key(&real.key);
                                out.set_unread(real.unread);
                                out.set_ongoing(real.ongoing);
                                out.set_href(&real.href);
                                out.set_timestamp(&real.timestamp);
                                out.set_sender_picture_url(&real.sender_picture_url);
                                out.set_sender_name(&real.sender_name);
                                out.set_native_path(&real.native_path);
                                out.set_native_action(&real.native_action);
                            }
                        }
                    }
                    // At most one callback in flight. watch retains only the latest full snapshot.
                    if !matches!(
                        tokio::time::timeout(Duration::from_secs(10), request.send().promise).await,
                        Ok(Ok(_))
                    ) {
                        return Err(capnp::Error::failed(
                            "Live update delivery failed or timed out".into(),
                        ));
                    }
                    if receiver.changed().await.is_err() {
                        return Err(capnp::Error::failed("Live update source closed".into()));
                    }
                }
            },
            || {},
        )?;
        results.get().set_subscription(subscription);
        Ok(())
    }

    async fn dismiss(
        self: Rc<Self>,
        params: shell::DismissParams,
        _: shell::DismissResults,
    ) -> capnp::Result<()> {
        if self.session.is_some() {
            return Err(capnp::Error::failed(
                "Use dismissReal for real notifications".into(),
            ));
        }
        let id = params.get()?.get_id();
        self.state.send_if_modified(|state| {
            let before = state.entries.len();
            state.entries.retain(|entry| entry.id != id);
            let changed = state.entries.len() != before;
            if changed {
                state.revision += 1;
                state.total = state.entries.len() as u32;
            }
            changed
        });
        Ok(())
    }

    async fn add_fixture(
        self: Rc<Self>,
        _: shell::AddFixtureParams,
        _: shell::AddFixtureResults,
    ) -> capnp::Result<()> {
        if self.session.is_some() {
            return Err(capnp::Error::failed(
                "Test notifications are disabled for real accounts".into(),
            ));
        }
        self.state.send_modify(|state| {
            let id = state.next_id;
            state.next_id += 1;
            state.revision += 1;
            state.entries.push(Entry {
                id,
                title: format!("Test notification {id}"),
                body: "Delivered by a Rust capability callback over WebSocket.".into(),
                real: None,
            });
            state.total = state.entries.len() as u32;
        });
        Ok(())
    }
}

fn write_grain(grain: &crate::bridge::Grain, mut out: crate::shell_capnp::grain::Builder<'_>) {
    out.set_key(&grain.key);
    out.set_title(&grain.title);
    out.set_owner_title(&grain.owner_title);
    out.set_href(&grain.href);
    out.set_owned(grain.owned);
    out.set_last_used(&grain.last_used);
    out.set_app_title(&grain.app_title);
    out.set_app_id(&grain.app_id);
    out.set_icon_src(&grain.icon_src);
}
fn write_notification(
    entry: &crate::bridge::Entry,
    mut out: crate::shell_capnp::notification::Builder<'_>,
) {
    out.set_key(&entry.key);
    out.set_title(&entry.title);
    out.set_body(&entry.body);
    out.set_unread(entry.unread);
    out.set_ongoing(entry.ongoing);
    out.set_href(&entry.href);
    out.set_timestamp(&entry.timestamp);
    out.set_sender_name(&entry.sender_name);
    out.set_sender_picture_url(&entry.sender_picture_url);
    out.set_native_path(&entry.native_path);
    out.set_native_action(&entry.native_action);
}

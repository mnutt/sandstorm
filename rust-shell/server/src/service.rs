use crate::read_model::{GrainQuery, GrainSort, Ownership, Pages};
use crate::shell_capnp::shell;
use std::{rc::Rc, time::Duration};
use tokio::sync::watch;

#[derive(Clone, PartialEq)]
struct Entry {
    id: u32,
    title: String,
    body: String,
    real: Option<crate::read_model::Entry>,
}
#[derive(Clone)]
struct Projection {
    revision: u32,
    next_id: u32,
    entries: Vec<Entry>,
    total: u32,
    grains: Vec<crate::read_model::Grain>,
    grains_limited: bool,
    profile_version: String,
    apps_version: String,
    has_unread: bool,
    account_picture_url: String,
}

#[derive(Clone)]
pub struct Shell {
    interop: Rc<crate::interop::Link>,
    state: watch::Sender<Projection>,
    pub observations: crate::observation::Scope,
    session: Option<crate::session::Session>,
    version: String,
    pub grain: Option<Rc<crate::grain::Scope>>,
}

impl Shell {
    pub fn new(
        interop: Rc<crate::interop::Link>,
        session: Option<crate::session::Session>,
        initial: Option<crate::read_model::Snapshot>,
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
            apps_version: initial
                .as_ref()
                .map(|s| s.apps_version.clone())
                .unwrap_or_default(),
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
            // Reads revalidate authority while waiting and before returning data.
            let Ok(snapshot) = session.watch(&version, Pages::default()).await else {
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
                    && state.apps_version == snapshot.apps_version
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
                state.apps_version = snapshot.apps_version;
                state.grains = snapshot.grains;
                state.grains_limited = snapshot.grains_limited;
                state.entries = entries;
                state.total = snapshot.total;
                state.revision += 1;
                true
            });
        }
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
            crate::shell_capnp::GrainSort::Recent => GrainSort::Recent,
            crate::shell_capnp::GrainSort::Title => GrainSort::Title,
        };
        let ownership = match query.get_ownership()? {
            crate::shell_capnp::GrainOwnership::All => Ownership::All,
            crate::shell_capnp::GrainOwnership::Owned => Ownership::Owned,
            crate::shell_capnp::GrainOwnership::Shared => Ownership::Shared,
        };
        let filter = GrainQuery {
            search,
            app_id,
            sort,
            ownership,
            trash: query.get_trash(),
        };
        let observer = input.get_observer()?;
        let session = self
            .session
            .clone()
            .ok_or_else(|| capnp::Error::failed("Sign in to browse grains".into()))?;
        let subscription = self.observations.spawn(
            async move {
                let mut version = "0".repeat(64);
                let mut previous = None;
                let mut revision = 0;
                loop {
                    let snapshot = session
                        .watch_query(
                            &version,
                            Pages {
                                grains: page,
                                ..Pages::default()
                            },
                            Some(filter.clone()),
                        )
                        .await;
                    let snapshot = match snapshot {
                        Ok(value) => value,
                        Err(error) => {
                            let mut request = observer.update_request();
                            crate::workflow::failure(
                                error,
                                request.get().init_result().init_failure(),
                            )?;
                            tokio::time::timeout(Duration::from_secs(10), request.send().promise)
                                .await
                                .map_err(|_| capnp::Error::failed("Observer timed out".into()))??;
                            return Ok(());
                        }
                    };
                    version = snapshot.version.clone();
                    let signature = (snapshot.grains.clone(), snapshot.grains_limited);
                    if previous.as_ref() == Some(&signature) {
                        continue;
                    }
                    revision += 1;
                    let delta = crate::list_delta::Changes::between(
                        previous.as_ref().map(|p| p.0.as_slice()),
                        &snapshot.grains,
                        |row| row.key.clone(),
                    )?;
                    let mut request = observer.update_request();
                    {
                        let mut out = request.get().init_result().init_value();
                        out.set_page(page);
                        out.set_has_more(snapshot.grains_limited);
                        delta.write(revision, out.reborrow().init_delta());
                        let mut list = out.init_upserts(delta.upserts.len() as u32);
                        for (i, index) in delta.upserts.iter().enumerate() {
                            write_grain(&snapshot.grains[*index], list.reborrow().get(i as u32));
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
                let mut revision = 0;
                loop {
                    let snapshot = session
                        .watch_query(
                            &version,
                            Pages {
                                notifications: page,
                                ..Pages::default()
                            },
                            None,
                        )
                        .await;
                    let snapshot = match snapshot {
                        Ok(value) => value,
                        Err(error) => {
                            let mut request = observer.update_request();
                            crate::workflow::failure(
                                error,
                                request.get().init_result().init_failure(),
                            )?;
                            tokio::time::timeout(Duration::from_secs(10), request.send().promise)
                                .await
                                .map_err(|_| capnp::Error::failed("Observer timed out".into()))??;
                            return Ok(());
                        }
                    };
                    version = snapshot.version.clone();
                    let signature = (snapshot.entries.clone(), snapshot.total);
                    if previous.as_ref() == Some(&signature) {
                        continue;
                    }
                    revision += 1;
                    let delta = crate::list_delta::Changes::between(
                        previous.as_ref().map(|p| p.0.as_slice()),
                        &snapshot.entries,
                        |row| row.key.clone(),
                    )?;
                    let mut request = observer.update_request();
                    {
                        let mut out = request.get().init_result().init_value();
                        out.set_page(page);
                        out.set_total(snapshot.total);
                        delta.write(revision, out.reborrow().init_delta());
                        let mut list = out.init_upserts(delta.upserts.len() as u32);
                        for (i, index) in delta.upserts.iter().enumerate() {
                            write_notification(
                                &snapshot.entries[*index],
                                list.reborrow().get(i as u32),
                            );
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

    async fn list_apps(
        self: Rc<Self>,
        params: shell::ListAppsParams,
        mut results: shell::ListAppsResults,
    ) -> capnp::Result<()> {
        let Some(session) = self.session.as_ref() else {
            return crate::workflow::failure(
                (
                    axum::http::StatusCode::UNAUTHORIZED,
                    "Sign in to browse apps".into(),
                ),
                results.get().init_result().init_failure(),
            );
        };
        let input = params.get()?;
        let page = input.get_page();
        let app_id = input.get_app_id()?.to_str()?;
        let list = match session.apps(page, app_id).await {
            Ok(value) => value,
            Err(error) => {
                return crate::workflow::failure(error, results.get().init_result().init_failure())
            }
        };
        let mut out = results.get().init_result().init_value();
        out.set_limited(list.limited);
        let mut actions = out.init_actions(list.actions.len() as u32);
        for (i, action) in list.actions.iter().enumerate() {
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

    async fn action(
        self: Rc<Self>,
        params: shell::ActionParams,
        mut results: shell::ActionResults,
    ) -> capnp::Result<()> {
        let session = self
            .session
            .clone()
            .ok_or_else(|| capnp::Error::failed("Sign in to select an app action".into()))?;
        let key = params.get()?.get_key()?.to_str()?.to_owned();
        results
            .get()
            .set_action(capnp_rpc::new_client(crate::resources::Action {
                session,
                key,
            }));
        Ok(())
    }
    async fn grain(
        self: Rc<Self>,
        params: shell::GrainParams,
        mut results: shell::GrainResults,
    ) -> capnp::Result<()> {
        let session = self
            .session
            .clone()
            .ok_or_else(|| capnp::Error::failed("Sign in to manage grains".into()))?;
        let grain_id = params.get()?.get_grain_id()?.to_str()?.to_owned();
        results
            .get()
            .set_handle(capnp_rpc::new_client(crate::resources::GrainHandle {
                session,
                grain_id,
            }));
        Ok(())
    }
    async fn grain_view(
        self: Rc<Self>,
        params: shell::GrainViewParams,
        mut results: shell::GrainViewResults,
    ) -> capnp::Result<()> {
        let scope = self
            .grain
            .clone()
            .ok_or_else(|| capnp::Error::failed("Sign in to select a grain view".into()))?;
        let grain_id = params.get()?.get_grain_id()?.to_str()?.to_owned();
        results
            .get()
            .set_view(capnp_rpc::new_client(crate::resources::ViewReference {
                scope,
                grain_id,
            }));
        Ok(())
    }

    async fn mark_all_read(
        self: Rc<Self>,
        _: shell::MarkAllReadParams,
        mut results: shell::MarkAllReadResults,
    ) -> capnp::Result<()> {
        let outcome = match self.session.as_ref() {
            Some(session) => session.call("read", serde_json::json!({})).await,
            None => Err((
                axum::http::StatusCode::UNAUTHORIZED,
                "Sign in to update notifications".into(),
            )),
        };
        match outcome {
            Ok(_) => {
                results.get().init_result().init_value();
                Ok(())
            }
            Err(error) => {
                crate::workflow::failure(error, results.get().init_result().init_failure())
            }
        }
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
                let mut previous: Option<Projection> = None;
                let mut revision = 0;
                loop {
                    let snapshot = receiver.borrow_and_update().clone();
                    let mut request = observer.replace_request();
                    {
                        let mut out = request.get().init_snapshot();
                        out.set_account_picture_url(&snapshot.account_picture_url);
                        out.set_profile_version(&snapshot.profile_version);
                        out.set_apps_version(&snapshot.apps_version);
                        out.set_has_unread(snapshot.has_unread);
                        out.set_revision(snapshot.revision);
                        revision += 1;
                        let grains = crate::list_delta::Changes::between(
                            previous.as_ref().map(|p| p.grains.as_slice()),
                            &snapshot.grains,
                            |row| row.key.clone(),
                        )?;
                        let entries = crate::list_delta::Changes::between(
                            previous.as_ref().map(|p| p.entries.as_slice()),
                            &snapshot.entries,
                            |row| {
                                row.real
                                    .as_ref()
                                    .map(|r| r.key.clone())
                                    .unwrap_or_else(|| row.id.to_string())
                            },
                        )?;
                        {
                            let mut page = out.reborrow().init_grains();
                            page.set_has_more(snapshot.grains_limited);
                            grains.write(revision, page.reborrow().init_delta());
                            let mut rows = page.init_upserts(grains.upserts.len() as u32);
                            for (i, index) in grains.upserts.iter().enumerate() {
                                write_grain(
                                    &snapshot.grains[*index],
                                    rows.reborrow().get(i as u32),
                                );
                            }
                        }
                        let mut page = out.init_entries();
                        page.set_total(snapshot.total);
                        entries.write(revision, page.reborrow().init_delta());
                        let mut rows = page.init_upserts(entries.upserts.len() as u32);
                        for (i, index) in entries.upserts.iter().enumerate() {
                            let entry = &snapshot.entries[*index];
                            let mut out = rows.reborrow().get(i as u32);
                            if let Some(real) = &entry.real {
                                write_notification(real, out);
                            } else {
                                out.set_key(entry.id.to_string());
                                out.set_id(entry.id);
                                out.set_title(&entry.title);
                                out.set_body(&entry.body);
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
                    previous = Some(snapshot);
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
                "Use a notification handle for real notifications".into(),
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

fn write_grain(grain: &crate::read_model::Grain, mut out: crate::shell_capnp::grain::Builder<'_>) {
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
    entry: &crate::read_model::Entry,
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

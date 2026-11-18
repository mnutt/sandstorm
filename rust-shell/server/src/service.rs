use crate::shell_capnp::{shell, subscription};
use std::{cell::Cell, rc::Rc, time::Duration};
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
}

#[derive(Clone)]
pub struct Shell {
    interop: Rc<crate::interop::Link>,
    state: watch::Sender<Projection>,
    watching: Rc<Cell<bool>>,
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
            watching: Rc::new(Cell::new(false)),
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
            let Ok(snapshot) = session.watch(&version).await else {
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
                if state.entries == entries
                    && state.total == snapshot.total
                    && state.grains == snapshot.grains
                    && state.grains_limited == snapshot.grains_limited
                {
                    return false;
                }
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

struct Subscription {
    task: tokio::task::JoinHandle<()>,
    closed: watch::Sender<Option<String>>,
    watching: Rc<Cell<bool>>,
    active: Cell<bool>,
}
impl Subscription {
    fn stop(&self) {
        if self.active.replace(false) {
            self.task.abort();
            self.watching.set(false);
            self.closed.send_if_modified(|state| {
                if state.is_some() {
                    return false;
                }
                *state = Some(String::new());
                true
            });
        }
    }
}
impl Drop for Subscription {
    fn drop(&mut self) {
        self.stop();
    }
}
impl subscription::Server for Subscription {
    async fn when_closed(
        self: Rc<Self>,
        _: subscription::WhenClosedParams,
        _: subscription::WhenClosedResults,
    ) -> capnp::Result<()> {
        let mut receiver = self.closed.subscribe();
        let reason = receiver
            .wait_for(|state| state.is_some())
            .await
            .map_err(|_| capnp::Error::disconnected("Subscription ended".into()))?
            .clone()
            .unwrap();
        if reason.is_empty() {
            Ok(())
        } else {
            Err(capnp::Error::failed(reason))
        }
    }

    async fn cancel(
        self: Rc<Self>,
        _: subscription::CancelParams,
        _: subscription::CancelResults,
    ) -> capnp::Result<()> {
        self.stop();
        Ok(())
    }
}

impl shell::Server for Shell {
    async fn list_apps(
        self: Rc<Self>,
        _: shell::ListAppsParams,
        mut results: shell::ListAppsResults,
    ) -> capnp::Result<()> {
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| capnp::Error::failed("Apps require a signed-in account".into()))?;
        let value = session
            .call("listApps", serde_json::json!({}))
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
        if action.len() > 128 || title.len() > 640 {
            return Err(capnp::Error::failed(
                "Invalid grain creation request".into(),
            ));
        }
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
        let grain_id = params.get()?.get_grain_id()?.to_str()?.to_owned();
        let (view, session) = scope.open(grain_id).await?;
        let mut out = results.get();
        out.set_session(session);
        let mut out = out.init_view();
        out.set_grain_id(&view.grain_id);
        out.set_origin(&view.origin);
        out.set_url(&view.url);
        out.set_title(&view.title);
        out.set_owner_title(&view.owner_title);
        out.set_main_href(&view.main_href);
        Ok(())
    }

    async fn dismiss_real(
        self: Rc<Self>,
        params: shell::DismissRealParams,
        _: shell::DismissRealResults,
    ) -> capnp::Result<()> {
        let key = params.get()?.get_key()?.to_str()?.to_owned();
        self.mutate_real("dismiss", serde_json::json!({ "id": key }))
            .await
    }

    async fn mark_read(
        self: Rc<Self>,
        _: shell::MarkReadParams,
        _: shell::MarkReadResults,
    ) -> capnp::Result<()> {
        self.mutate_real("read", serde_json::json!({})).await
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
        if self.watching.replace(true) {
            return Err(capnp::Error::failed(
                "one subscription per connection".into(),
            ));
        }
        let mut receiver = self.state.subscribe();
        let (closed, _) = watch::channel(None);
        let ended = closed.clone();
        let task = tokio::task::spawn_local(async move {
            loop {
                let snapshot = receiver.borrow_and_update().clone();
                let mut request = observer.replace_request();
                {
                    let mut out = request.get().init_snapshot();
                    out.set_revision(snapshot.revision);
                    out.set_total(snapshot.total);
                    out.set_grains_limited(snapshot.grains_limited);
                    {
                        let mut grains = out.reborrow().init_grains(snapshot.grains.len() as u32);
                        for (i, grain) in snapshot.grains.iter().enumerate() {
                            let mut out = grains.reborrow().get(i as u32);
                            out.set_key(&grain.key);
                            out.set_title(&grain.title);
                            out.set_owner_title(&grain.owner_title);
                            out.set_href(&grain.href);
                            out.set_owned(grain.owned);
                            out.set_last_used(&grain.last_used);
                            out.set_app_title(&grain.app_title);
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
                            out.set_sender_name(&real.sender_name);
                        }
                    }
                }
                // At most one callback in flight. watch retains only the latest full snapshot.
                if !matches!(
                    tokio::time::timeout(Duration::from_secs(10), request.send().promise).await,
                    Ok(Ok(_))
                ) {
                    ended.send_replace(Some("Live update delivery failed or timed out".into()));
                    break;
                }
                if receiver.changed().await.is_err() {
                    ended.send_replace(Some("Live update source closed".into()));
                    break;
                }
            }
        });
        results
            .get()
            .set_subscription(capnp_rpc::new_client(Subscription {
                task,
                closed,
                watching: self.watching.clone(),
                active: Cell::new(true),
            }));
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
        if self.state.borrow().entries.len() >= 50 {
            return Err(capnp::Error::failed(
                "fixture limit reached (50 notifications)".into(),
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

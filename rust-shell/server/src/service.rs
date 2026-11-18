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
}

impl Shell {
    pub fn new(
        interop: Rc<crate::interop::Link>,
        session: Option<crate::bridge::Session>,
        initial: Option<crate::bridge::Snapshot>,
    ) -> Self {
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
        Self {
            interop,
            state,
            watching: Rc::new(Cell::new(false)),
            session,
            version,
        }
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
    watching: Rc<Cell<bool>>,
    active: Cell<bool>,
}
impl Subscription {
    fn stop(&self) {
        if self.active.replace(false) {
            self.task.abort();
            self.watching.set(false);
        }
    }
}
impl Drop for Subscription {
    fn drop(&mut self) {
        self.stop();
    }
}
impl subscription::Server for Subscription {
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
                            out.set_href(&grain.href);
                            out.set_owned(grain.owned);
                            out.set_last_used(&grain.last_used);
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
                    break;
                }
                if receiver.changed().await.is_err() {
                    break;
                }
            }
        });
        results
            .get()
            .set_subscription(capnp_rpc::new_client(Subscription {
                task,
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

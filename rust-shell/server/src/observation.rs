//! Explicitly cancellable observation. A pending terminal-state call must not
//! retain the observation object after the remote capability is released.
use crate::shell_capnp::subscription;
use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};
use tokio::sync::watch;

struct Observation {
    task: tokio::task::JoinHandle<()>,
    closed: watch::Sender<Option<String>>,
    cleanup: RefCell<Option<Box<dyn FnOnce()>>>,
}
#[derive(Clone, Default)]
pub struct Scope(Rc<ScopeState>);
#[derive(Default)]
struct ScopeState {
    closed: Cell<bool>,
    observations: RefCell<Vec<Weak<Observation>>>,
}
impl Scope {
    pub fn spawn(
        &self,
        work: impl std::future::Future<Output = capnp::Result<()>> + 'static,
        cleanup: impl FnOnce() + 'static,
    ) -> capnp::Result<subscription::Client> {
        let mut observations = self.0.observations.borrow_mut();
        observations.retain(|entry| {
            entry
                .upgrade()
                .is_some_and(|o| o.cleanup.borrow().is_some())
        });
        if self.0.closed.get() || observations.len() >= 8 {
            cleanup();
            return Err(capnp::Error::overloaded(
                "Too many active observations or connection closed".into(),
            ));
        }
        let (closed, _) = watch::channel(None);
        let ended = closed.clone();
        let task = tokio::task::spawn_local(async move {
            let result = work.await;
            ended.send_replace(Some(
                result.err().map(|e| e.to_string()).unwrap_or_default(),
            ));
        });
        let observation = Rc::new(Observation {
            task,
            closed,
            cleanup: RefCell::new(Some(Box::new(cleanup))),
        });
        observations.push(Rc::downgrade(&observation));
        Ok(capnp_rpc::new_client_from_rc(observation))
    }

    pub fn close(&self) {
        self.0.closed.set(true);
        for observation in self
            .0
            .observations
            .take()
            .into_iter()
            .filter_map(|o| o.upgrade())
        {
            observation.stop();
        }
    }
}
impl Observation {
    fn stop(&self) {
        self.task.abort();
        if let Some(cleanup) = self.cleanup.borrow_mut().take() {
            cleanup();
        }
        self.closed.send_if_modified(|closed| {
            if closed.is_some() {
                false
            } else {
                *closed = Some(String::new());
                true
            }
        });
    }
}
impl Drop for Observation {
    fn drop(&mut self) {
        self.stop();
    }
}
impl subscription::Server for Observation {
    async fn cancel(
        self: Rc<Self>,
        _: subscription::CancelParams,
        _: subscription::CancelResults,
    ) -> capnp::Result<()> {
        self.stop();
        Ok(())
    }
    async fn when_closed(
        self: Rc<Self>,
        _: subscription::WhenClosedParams,
        _: subscription::WhenClosedResults,
    ) -> capnp::Result<()> {
        let mut closed = self.closed.subscribe();
        drop(self);
        let reason = closed
            .wait_for(|v| v.is_some())
            .await
            .map_err(|_| capnp::Error::disconnected("Observation ended".into()))?
            .clone()
            .unwrap();
        if reason.is_empty() {
            Ok(())
        } else {
            Err(capnp::Error::failed(reason))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, time::Duration};

    #[tokio::test]
    async fn connection_close_cancels_retained_observations_and_bounds_admission() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let scope = Scope::default();
                let mut clients = Vec::new();
                for _ in 0..8 {
                    clients.push(scope.spawn(std::future::pending(), || {}).unwrap());
                }
                assert!(scope.spawn(std::future::pending(), || {}).is_err());
                clients.pop();
                let cleaned = Rc::new(Cell::new(false));
                let cleanup = cleaned.clone();
                let client = scope
                    .spawn(std::future::pending(), move || cleanup.set(true))
                    .unwrap();
                let terminal = client.when_closed_request().send().promise;
                scope.close();
                assert!(cleaned.get());
                tokio::time::timeout(Duration::from_secs(1), terminal)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(scope.spawn(std::future::pending(), || {}).is_err());
            })
            .await;
    }

    #[tokio::test]
    async fn pending_when_closed_does_not_keep_observation_alive() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let cleaned = Rc::new(Cell::new(0));
                let cleanup = cleaned.clone();
                let scope = Scope::default();
                let client = scope
                    .spawn(std::future::pending(), move || {
                        cleanup.set(cleanup.get() + 1);
                    })
                    .unwrap();
                let terminal = client.when_closed_request().send().promise;
                let terminal = tokio::task::spawn_local(terminal);
                tokio::task::yield_now().await;
                drop(client);
                tokio::time::timeout(Duration::from_secs(1), terminal)
                    .await
                    .expect("release must finish a pending whenClosed")
                    .unwrap()
                    .unwrap();
                assert_eq!(cleaned.get(), 1);
            })
            .await;
    }
}

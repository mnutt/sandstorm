use crate::bridge::{Bridge, Error};
use serde_json::Value;
use tokio::sync::watch;

// The bridge observes Mongo between bounded long-poll renewals. This is a
// lifetime wait, not an ordinary ten-second UI operation, and owns no lease.
pub async fn wait(
    bridge: &Bridge,
    action: &str,
    input: Value,
    mut ended: watch::Receiver<bool>,
) -> Result<(), Error> {
    loop {
        let value = tokio::select! {
            biased;
            _ = ended.wait_for(|closed| *closed) => return Err((axum::http::StatusCode::GONE, "Grain session closed".into())),
            result = bridge.call(action, input.clone()) => result?,
        };
        match value["loaded"].as_bool() {
            Some(true) => return Ok(()),
            Some(false) => {}
            None => {
                return Err((
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "Invalid grain readiness response".into(),
                ))
            }
        }
    }
}

use crate::{session::Session, shell_capnp as api, workflow::failure};
use serde::Deserialize;
use serde_json::json;
use std::rc::Rc;

pub struct Notice {
    session: Session,
    key: String,
}
impl Notice {
    pub fn new(session: Session, key: String) -> Self {
        Self { session, key }
    }
}
#[derive(Deserialize)]
struct Person {
    name: String,
    #[serde(rename = "pictureUrl")]
    picture_url: String,
}
#[derive(Deserialize)]
#[serde(tag = "kind")]
enum Details {
    #[serde(rename = "stats")]
    Statistics {
        enabled: Option<bool>,
        sample: String,
    },
    #[serde(rename = "referrals")]
    Referrals {
        enabled: bool,
        pending: Vec<Person>,
        completed: Vec<Person>,
    },
    #[serde(rename = "identity")]
    Identity,
}
fn decode(value: serde_json::Value) -> capnp::Result<Details> {
    serde_json::from_value(value)
        .map_err(|_| capnp::Error::failed("Invalid notification details".into()))
}
fn statistics(enabled: Option<bool>, sample: &str, mut out: api::statistics_details::Builder<'_>) {
    out.set_preference(match enabled {
        None => api::ReportingPreference::Unset,
        Some(false) => api::ReportingPreference::Disabled,
        Some(true) => api::ReportingPreference::Enabled,
    });
    out.set_sample(sample);
}
fn people(rows: &[Person], mut out: capnp::struct_list::Builder<'_, api::referral_person::Owned>) {
    for (i, row) in rows.iter().enumerate() {
        let mut item = out.reborrow().get(i as u32);
        item.set_name(&row.name);
        item.set_picture_url(&row.picture_url);
    }
}
fn write(details: Details, mut out: api::notification_details::Builder<'_>) {
    match details {
        Details::Statistics { enabled, sample } => {
            statistics(enabled, &sample, out.init_statistics())
        }
        Details::Identity => out.set_identity(()),
        Details::Referrals {
            enabled,
            pending,
            completed,
        } => {
            let mut out = out.init_referrals();
            out.set_enabled(enabled);
            people(&pending, out.reborrow().init_pending(pending.len() as u32));
            people(&completed, out.init_completed(completed.len() as u32));
        }
    }
}
impl api::notification_handle::Server for Notice {
    async fn dismiss(
        self: Rc<Self>,
        _: api::notification_handle::DismissParams,
        mut results: api::notification_handle::DismissResults,
    ) -> capnp::Result<()> {
        match self.session.call("dismiss", json!({"id":self.key})).await {
            Ok(_) => {
                results.get().init_result().init_value();
                Ok(())
            }
            Err(error) => failure(error, results.get().init_result().init_failure()),
        }
    }
    async fn mark_read(
        self: Rc<Self>,
        _: api::notification_handle::MarkReadParams,
        mut results: api::notification_handle::MarkReadResults,
    ) -> capnp::Result<()> {
        // Always supply the selector, including an invalid empty one. Omission
        // is reserved for Shell.markAllRead and has account-wide authority.
        match self.session.call("read", json!({"key":self.key})).await {
            Ok(_) => {
                results.get().init_result().init_value();
                Ok(())
            }
            Err(error) => failure(error, results.get().init_result().init_failure()),
        }
    }
    async fn read(
        self: Rc<Self>,
        _: api::notification_handle::ReadParams,
        mut results: api::notification_handle::ReadResults,
    ) -> capnp::Result<()> {
        match self
            .session
            .call(
                "notification",
                json!({"key":self.key,"operation":"details"}),
            )
            .await
        {
            Ok(value) => {
                write(decode(value)?, results.get().init_result().init_value());
                Ok(())
            }
            Err(error) => failure(error, results.get().init_result().init_failure()),
        }
    }
    async fn set_statistics_reporting(
        self: Rc<Self>,
        params: api::notification_handle::SetStatisticsReportingParams,
        mut results: api::notification_handle::SetStatisticsReportingResults,
    ) -> capnp::Result<()> {
        let enabled = params.get()?.get_enabled();
        match self
            .session
            .call(
                "notification",
                json!({"key":self.key,"operation":"setStats","enabled":enabled}),
            )
            .await
        {
            Ok(value) => {
                let Details::Statistics { enabled, sample } = decode(value)? else {
                    return Err(capnp::Error::failed("Invalid statistics result".into()));
                };
                statistics(enabled, &sample, results.get().init_result().init_value());
                Ok(())
            }
            Err(error) => failure(error, results.get().init_result().init_failure()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reporting_preferences_keep_unset_distinct_from_disabled() {
        for (value, expected) in [
            (None, api::ReportingPreference::Unset),
            (Some(false), api::ReportingPreference::Disabled),
            (Some(true), api::ReportingPreference::Enabled),
        ] {
            let mut message = capnp::message::Builder::new_default();
            write(
                decode(json!({"kind":"stats","enabled":value,"sample":"{}"})).unwrap(),
                message.init_root(),
            );
            let state = message
                .get_root_as_reader::<api::notification_details::Reader>()
                .unwrap();
            let api::notification_details::Statistics(stats) = state.which().unwrap() else {
                panic!("wrong notice type")
            };
            assert_eq!(stats.unwrap().get_preference().unwrap(), expected);
        }
    }
    #[test]
    fn malformed_projections_are_not_silently_treated_as_identity_notices() {
        assert!(decode(json!({"kind":"unexpected"})).is_err());
        assert!(decode(
            json!({"kind":"referrals","enabled":true,"pending":[{"name":"Bob"}],"completed":[]})
        )
        .is_err());
        assert!(decode(json!({"kind":"stats","enabled":"false","sample":"{}"})).is_err());
    }
}

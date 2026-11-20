use crate::shell_capnp as api;
use serde::Deserialize;

#[derive(Deserialize)]
struct Profile {
    name: String,
    handle: String,
    pronoun: String,
    #[serde(default, rename = "pictureUrl")]
    picture_url: String,
    version: String,
}
fn pronoun(value: &str) -> capnp::Result<api::ProfilePronoun> {
    Ok(match value {
        "neutral" => api::ProfilePronoun::Neutral,
        "male" => api::ProfilePronoun::Male,
        "female" => api::ProfilePronoun::Female,
        "robot" => api::ProfilePronoun::Robot,
        _ => return Err(capnp::Error::failed("Invalid profile pronoun".into())),
    })
}
pub fn pronoun_name(value: api::ProfilePronoun) -> &'static str {
    match value {
        api::ProfilePronoun::Neutral => "neutral",
        api::ProfilePronoun::Male => "male",
        api::ProfilePronoun::Female => "female",
        api::ProfilePronoun::Robot => "robot",
    }
}
pub fn write(
    value: serde_json::Value,
    mut out: api::account_profile::Builder<'_>,
) -> capnp::Result<()> {
    let profile: Profile = serde_json::from_value(value)
        .map_err(|_| capnp::Error::failed("Invalid profile response".into()))?;
    out.set_name(profile.name);
    out.set_handle(profile.handle);
    out.set_pronoun(pronoun(&profile.pronoun)?);
    out.set_picture_url(profile.picture_url);
    out.set_version(profile.version);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pronouns_match_the_existing_meteor_options() {
        for value in ["neutral", "male", "female", "robot"] {
            assert_eq!(pronoun_name(pronoun(value).unwrap()), value);
        }
        assert!(pronoun("unknown").is_err());
        let mut message = capnp::message::Builder::new_default();
        message.init_root::<api::profile_edit::Builder>();
        let profile = message
            .get_root_as_reader::<api::profile_edit::Reader>()
            .unwrap();
        assert_eq!(profile.get_pronoun().unwrap(), api::ProfilePronoun::Neutral);
    }
}

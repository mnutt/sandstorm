use crate::{grain::Lease, shell_capnp as api, workflow::failure};
use serde_json::{json, Value};
use std::rc::Rc;

pub struct Sharing(pub Rc<Lease>);
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn invalid() -> capnp::Error {
    capnp::Error::failed("Invalid sharing projection".into())
}
fn write_role(role: &str, mut out: api::share_role::Builder<'_>) -> capnp::Result<()> {
    match role {
        "all" => out.set_all(()),
        "none" => out.set_none(()),
        _ => out.set_role_id(role.parse().map_err(|_| invalid())?),
    }
    Ok(())
}
fn read_role(role: api::share_role::Reader<'_>) -> capnp::Result<String> {
    Ok(match role.which()? {
        api::share_role::All(()) => "all".into(),
        api::share_role::None(()) => "none".into(),
        api::share_role::RoleId(id) => id.to_string(),
    })
}
fn write_state(value: &Value, mut out: api::sharing_state::Builder<'_>) -> capnp::Result<()> {
    out.set_owner(value["owner"].as_bool().unwrap_or(false));
    out.set_private(value["private"].as_bool().unwrap_or(false));
    write_role(
        text(value, "defaultRole"),
        out.reborrow().init_default_role(),
    )?;
    let roles = value["roles"].as_array().ok_or_else(invalid)?;
    let mut list = out.reborrow().init_roles(roles.len() as u32);
    for (i, role) in roles.iter().enumerate() {
        let mut item = list.reborrow().get(i as u32);
        item.set_id(text(role, "key").parse().map_err(|_| invalid())?);
        item.set_title(text(role, "title"));
        item.set_description(text(role, "description"));
    }
    let grants = value["grants"].as_array().ok_or_else(invalid)?;
    let mut list = out.init_grants(grants.len() as u32);
    for (i, grant) in grants.iter().enumerate() {
        let mut item = list.reborrow().get(i as u32);
        item.set_id(text(grant, "id"));
        item.set_label(text(grant, "label"));
        if text(grant, "role") == "custom" {
            item.set_custom(());
        } else {
            write_role(text(grant, "role"), item.reborrow().init_role())?;
        }
        item.set_kind(match text(grant, "kind") {
            "link" => api::ShareGrantKind::Link,
            "person" => api::ShareGrantKind::Person,
            "grain" => api::ShareGrantKind::Grain,
            _ => return Err(invalid()),
        });
        item.set_recipient(text(grant, "recipient"));
        item.set_recipient_picture_url(text(grant, "recipientPictureUrl"));
        item.set_editable(grant["editable"].as_bool().unwrap_or(false));
        item.set_inherited(grant["inherited"].as_bool().unwrap_or(false));
        item.set_created(text(grant, "created"));
    }
    Ok(())
}
impl api::sharing::Server for Sharing {
    async fn read(
        self: Rc<Self>,
        _: api::sharing::ReadParams,
        mut results: api::sharing::ReadResults,
    ) -> capnp::Result<()> {
        match self.0.bridge_call("getSharing", json!({})).await {
            Ok(value) => write_state(&value, results.get().init_result().init_value()),
            Err(error) => failure(error, results.get().init_result().init_failure()),
        }
    }
    async fn create(
        self: Rc<Self>,
        params: api::sharing::CreateParams,
        mut results: api::sharing::CreateResults,
    ) -> capnp::Result<()> {
        let input = params.get()?;
        let data =
            json!({"label":input.get_label()?.to_str()?,"role":read_role(input.get_role()?)?});
        match self.0.bridge_call("createShare", data).await {
            Ok(value) => {
                let token = value["token"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(invalid)?;
                results.get().init_result().init_value().set_token(token);
                Ok(())
            }
            Err(error) => failure(error, results.get().init_result().init_failure()),
        }
    }
    async fn edit(
        self: Rc<Self>,
        params: api::sharing::EditParams,
        mut results: api::sharing::EditResults,
    ) -> capnp::Result<()> {
        let input = params.get()?;
        let mut changes = json!({"label":input.get_label()?.to_str()?});
        if let api::share_role_change::Set(role) = input.get_role()?.which()? {
            changes["role"] = json!(read_role(role?)?);
        }
        match self
            .0
            .bridge_call(
                "updateShare",
                json!({"id":input.get_id()?.to_str()?,"changes":changes}),
            )
            .await
        {
            Ok(_) => {
                results.get().init_result().init_value();
                Ok(())
            }
            Err(error) => failure(error, results.get().init_result().init_failure()),
        }
    }
    async fn revoke(
        self: Rc<Self>,
        params: api::sharing::RevokeParams,
        mut results: api::sharing::RevokeResults,
    ) -> capnp::Result<()> {
        let id = params.get()?.get_id()?.to_str()?;
        match self
            .0
            .bridge_call("updateShare", json!({"id":id,"changes":{"revoked":true}}))
            .await
        {
            Ok(_) => {
                results.get().init_result().init_value();
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
    fn default_role_does_not_request_all_access() {
        let mut message = capnp::message::Builder::new_default();
        message.init_root::<api::share_role::Builder>();
        assert_eq!(
            read_role(message.get_root_as_reader().unwrap()).unwrap(),
            "none"
        );
        for role in ["none", "all", "0", "100", "4294967295"] {
            write_role(role, message.get_root().unwrap()).unwrap();
            assert_eq!(
                read_role(message.get_root_as_reader().unwrap()).unwrap(),
                role
            );
        }
        assert!(write_role("custom", message.get_root().unwrap()).is_err());
    }

    #[test]
    fn custom_permissions_are_projected_without_becoming_a_selectable_role() {
        let mut message = capnp::message::Builder::new_default();
        write_state(&json!({
            "roles":[{"key":"100","title":"Reviewer","description":"Review content"}],
            "defaultRole":"100","owner":true,"private":true,
            "grants":[{"id":"grant","label":"Team","role":"custom","kind":"person",
                "recipient":"Bob","recipientPictureUrl":"/picture","editable":false,"inherited":true}]
        }), message.init_root()).unwrap();
        let state = message
            .get_root_as_reader::<api::sharing_state::Reader>()
            .unwrap();
        assert_eq!(read_role(state.get_default_role().unwrap()).unwrap(), "100");
        assert_eq!(state.get_roles().unwrap().get(0).get_id(), 100);
        let grant = state.get_grants().unwrap().get(0);
        assert!(matches!(
            grant.which().unwrap(),
            api::share_grant::Custom(())
        ));
        assert_eq!(grant.get_kind().unwrap(), api::ShareGrantKind::Person);
        assert!(!grant.get_editable());
        assert!(grant.get_inherited());
        assert_eq!(
            grant.get_recipient_picture_url().unwrap().to_str().unwrap(),
            "/picture"
        );
    }
}

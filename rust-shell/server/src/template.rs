use crate::shell_capnp::template_options;
use serde_json::{json, Map, Value};

// Preserve optional metadata presence; the canonical token issuer validates
// resource headers, paths, DAV classes, and its existing discovery size bound.
pub fn options(input: template_options::Reader<'_>) -> capnp::Result<Value> {
    use crate::shell_capnp::template_role;
    let role = input.get_role()?;
    let mut assignment = match role.which()? {
        template_role::None(()) => json!({"none": null}),
        template_role::AllAccess(()) => json!({"allAccess": null}),
        template_role::RoleId(id) => json!({"roleId": id}),
    };
    if role.has_add_permissions() {
        assignment["addPermissions"] =
            json!(role.get_add_permissions()?.iter().collect::<Vec<_>>());
    }
    if role.has_remove_permissions() {
        assignment["removePermissions"] =
            json!(role.get_remove_permissions()?.iter().collect::<Vec<_>>());
    }
    let mut value = json!({
        "petname": input.get_petname()?.to_str()?,
        "roleAssignment": assignment,
        "forSharing": input.get_for_sharing(),
    });
    if input.has_unauthenticated() {
        let discovery = input.get_unauthenticated()?;
        let mut data = Map::new();
        if discovery.has_options() {
            let options = discovery.get_options()?;
            let mut dav = Map::new();
            if options.has_dav() {
                let classes = options
                    .get_dav()?
                    .iter()
                    .map(|item| Ok(item?.to_str()?.to_owned()))
                    .collect::<capnp::Result<Vec<_>>>()?;
                dav.insert("dav".into(), json!(classes));
            }
            data.insert("options".into(), Value::Object(dav));
        }
        if discovery.has_resources() {
            let mut resources = Map::new();
            for item in discovery.get_resources()?.iter() {
                let mut resource =
                    json!({"type": item.get_type()?.to_str()?, "body": item.get_body()?.to_str()?});
                if item.has_language() {
                    resource["language"] = json!(item.get_language()?.to_str()?);
                }
                if item.has_encoding() {
                    resource["encoding"] = json!(item.get_encoding()?.to_str()?);
                }
                let path = item.get_path()?.to_str()?;
                if resources.insert(path.into(), resource).is_some() {
                    return Err(capnp::Error::failed(
                        "Duplicate discovery resource path".into(),
                    ));
                }
            }
            data.insert("resources".into(), Value::Object(resources));
        }
        value["unauthenticated"] = Value::Object(data);
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_role_masks_and_discovery_metadata() -> capnp::Result<()> {
        let mut message = capnp::message::Builder::new_default();
        let mut input = message.init_root::<template_options::Builder<'_>>();
        input.set_petname("desktop client");
        let mut role = input.reborrow().init_role();
        role.set_role_id(2);
        role.reborrow().init_add_permissions(2).set(1, true);
        role.init_remove_permissions(1).set(0, true);
        let mut discovery = input.reborrow().init_unauthenticated();
        discovery
            .reborrow()
            .init_options()
            .init_dav(1)
            .set(0, "mkcol-extended");
        let mut resource = discovery.init_resources(1).get(0);
        resource.set_path("/status.php");
        resource.set_type("text/json");
        resource.set_language("en");
        resource.set_body("{\"installed\":true}");
        assert_eq!(
            options(input.into_reader())?,
            json!({
                "petname":"desktop client", "forSharing":false,
                "roleAssignment":{"roleId":2,"addPermissions":[false,true],"removePermissions":[true]},
                "unauthenticated":{"options":{"dav":["mkcol-extended"]},"resources":{
                    "/status.php":{"type":"text/json","language":"en","body":"{\"installed\":true}"}
                }}
            })
        );
        Ok(())
    }

    #[test]
    fn preserves_absent_and_empty_discovery_fields() -> capnp::Result<()> {
        let mut message = capnp::message::Builder::new_default();
        let mut input = message.init_root::<template_options::Builder<'_>>();
        assert!(options(input.reborrow().into_reader())?
            .get("unauthenticated")
            .is_none());
        input.reborrow().init_unauthenticated().init_options();
        assert_eq!(
            options(input.reborrow().into_reader())?["unauthenticated"],
            json!({"options":{}})
        );
        input.reborrow().get_unauthenticated()?.init_resources(0);
        assert_eq!(
            options(input.into_reader())?["unauthenticated"],
            json!({"options":{},"resources":{}})
        );
        Ok(())
    }
}

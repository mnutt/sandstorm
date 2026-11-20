use crate::{bridge::Session, grain::Scope, shell_capnp as api};
use std::rc::Rc;

pub struct Action {
    pub session: Session,
    pub key: String,
}
impl api::app_action_handle::Server for Action {
    async fn create(
        self: Rc<Self>,
        params: api::app_action_handle::CreateParams,
        mut results: api::app_action_handle::CreateResults,
    ) -> capnp::Result<()> {
        let session = &self.session;
        let input = params.get()?;
        let action = &self.key;
        let title = input.get_title()?.to_str()?;
        let value = match session
            .call(
                "createGrain",
                serde_json::json!({"actionId":action,"title":title}),
            )
            .await
        {
            Ok(value) => value,
            Err(error) => {
                return crate::workflow::failure(error, results.get().init_result().init_failure())
            }
        };
        let grain_id = value["grainId"]
            .as_str()
            .ok_or_else(|| capnp::Error::failed("Missing created grain ID".into()))?;
        results
            .get()
            .init_result()
            .init_value()
            .set_grain_id(grain_id);
        Ok(())
    }
}

pub struct ViewReference {
    pub scope: Rc<Scope>,
    pub grain_id: String,
}
impl api::view_reference::Server for ViewReference {
    async fn open(
        self: Rc<Self>,
        _: api::view_reference::OpenParams,
        mut results: api::view_reference::OpenResults,
    ) -> capnp::Result<()> {
        let (view, session) = match self.scope.open(self.grain_id.clone()).await {
            Ok(opened) => opened,
            Err(error) => {
                return crate::workflow::failure(error, results.get().init_result().init_failure())
            }
        };
        let mut out = results.get().init_result().init_value();
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
}

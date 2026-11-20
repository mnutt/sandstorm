use crate::{
    bridge::{Bridge, Session},
    AppState,
};
use axum::{
    extract::{Form, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;

const SESSION: &str = "__Host-sandstorm-rust-session";
const FLOW: &str = "__Host-sandstorm-rust-flow";

#[derive(Clone)]
pub struct Auth {
    pub bridge: Option<Bridge>,
    pub main_url: String,
    pub main_origin: String,
}

fn secret() -> Result<String, StatusCode> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let mut values = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|v| v.trim().split_once('='))
        .filter(|(key, _)| *key == name)
        .map(|(_, value)| value);
    let value = values.next()?;
    if values.next().is_some() || !valid(value) {
        return None;
    }
    Some(value.to_owned())
}

fn set_cookie(response: &mut Response, name: &str, value: &str, age: u32) {
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{name}={value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age={age}"
        ))
        .unwrap(),
    );
}

pub fn error((status, message): crate::bridge::Error) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

pub fn session(auth: &Auth, headers: &HeaderMap) -> Option<Session> {
    Some(Session {
        bridge: auth.bridge.clone()?,
        token: cookie(headers, SESSION)?,
    })
}

pub async fn status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if state.auth.bridge.is_none() {
        return Json(json!({ "fixture": true, "account": null })).into_response();
    }
    let Some(session) = session(&state.auth, &headers) else {
        return error((StatusCode::UNAUTHORIZED, "Sign in with Sandstorm.".into()));
    };
    match session.call("session", json!({})).await {
        Ok(mut value) => {
            value["fixture"] = json!(false);
            Json(value).into_response()
        }
        Err(err) => error(err),
    }
}

pub async fn options(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(bridge) = &state.auth.bridge else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let flow = match cookie(&headers, FLOW).map(Ok).unwrap_or_else(secret) {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    match bridge
        .call(
            "nativeAuth",
            json!({"operation":"options","data":{},"flow":flow}),
        )
        .await
    {
        Ok(value) => {
            let mut response = Json(value).into_response();
            set_cookie(&mut response, FLOW, &flow, 600);
            response
        }
        Err(err) => error(err),
    }
}

#[derive(Deserialize)]
pub struct NativeLogin {
    operation: String,
    data: serde_json::Value,
}

pub async fn native_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<NativeLogin>,
) -> Response {
    if headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(state.origin.as_str()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(flow) = cookie(&headers, FLOW) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let Some(bridge) = &state.auth.bridge else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if ![
        "sendEmail",
        "email",
        "dev",
        "ldap",
        "samlStart",
        "samlFinish",
        "samlCancel",
        "oauthStart",
        "oauthFinish",
        "oauthCancel",
    ]
    .contains(&input.operation.as_str())
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match bridge.call("nativeAuth",json!({"operation":input.operation,"data":input.data,"flow":flow,"previous":cookie(&headers,SESSION)})).await {
        Ok(value) => {
            if let Some(token) = value["token"].as_str().filter(|value| valid(value)) {
                let mut response = Json(json!({"signedIn":true})).into_response();
                set_cookie(&mut response,SESSION,token,12*60*60);
                set_cookie(&mut response,FLOW,"",0);
                response
            } else { Json(value).into_response() }
        }, Err(err) => error(err),
    }
}

pub async fn start(State(state): State<AppState>) -> Response {
    if state.auth.bridge.is_none() {
        return Redirect::to("/").into_response();
    }
    let nonce = match secret() {
        Ok(value) => value,
        Err(status) => return status.into_response(),
    };
    let mut response = Redirect::to(&format!(
        "{}/rust-shell-login?state={nonce}",
        state.auth.main_url.trim_end_matches('/')
    ))
    .into_response();
    set_cookie(&mut response, FLOW, &nonce, 120);
    response
}

#[derive(Deserialize)]
pub struct Login {
    code: String,
    state: String,
}

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<Login>,
) -> Response {
    if headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
        != Some(state.auth.main_origin.as_str())
        || !valid(&form.code)
        || !valid(&form.state)
        || cookie(&headers, FLOW).as_deref() != Some(form.state.as_str())
    {
        return error((
            StatusCode::FORBIDDEN,
            "Invalid sign-in handoff. Start again from the Rust shell.".into(),
        ));
    }
    let Some(bridge) = &state.auth.bridge else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match bridge.call("exchange", json!({ "code": form.code, "state": form.state, "previous": cookie(&headers, SESSION) })).await {
        Ok(value) => {
            let Some(token) = value["token"].as_str().filter(|s| valid(s)) else { return StatusCode::BAD_GATEWAY.into_response(); };
            let mut response = Redirect::to("/").into_response();
            set_cookie(&mut response, SESSION, token, 12 * 60 * 60);
            set_cookie(&mut response, FLOW, "", 0);
            response
        },
        Err(err) => error(err),
    }
}

pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(state.origin.as_str()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if let Some(session) = session(&state.auth, &headers) {
        if let Err(err) = session.call("logout", json!({})).await {
            return error(err);
        }
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    set_cookie(&mut response, SESSION, "", 0);
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookies_reject_ambiguous_or_malformed_credentials() {
        let token = "a".repeat(64);
        let mut headers = HeaderMap::new();
        headers.append(
            header::COOKIE,
            format!("{SESSION}={token}").parse().unwrap(),
        );
        assert_eq!(cookie(&headers, SESSION), Some(token.clone()));
        headers.append(
            header::COOKIE,
            format!("{SESSION}={token}").parse().unwrap(),
        );
        assert_eq!(cookie(&headers, SESSION), None);
        for value in [
            format!("{token}; {SESSION}={token}"),
            "a".repeat(63),
            "A".repeat(64),
            "g".repeat(64),
        ] {
            headers.clear();
            headers.insert(
                header::COOKIE,
                format!("{SESSION}={value}").parse().unwrap(),
            );
            assert_eq!(cookie(&headers, SESSION), None);
        }
    }
}

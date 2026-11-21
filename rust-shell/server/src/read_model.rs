use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct AppAction {
    #[serde(default, rename = "grainCount")]
    pub grain_count: u32,
    #[serde(default, rename = "shortDescription")]
    pub short_description: String,
    pub key: String,
    pub title: String,
    #[serde(rename = "appTitle")]
    pub app_title: String,
    #[serde(default, rename = "appId")]
    pub app_id: String,
    #[serde(default, rename = "iconSrc")]
    pub icon_src: String,
    #[serde(default, rename = "lastUsed")]
    pub last_used: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct AppList {
    pub actions: Vec<AppAction>,
    pub limited: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Entry {
    #[serde(default, rename = "senderPictureUrl")]
    pub sender_picture_url: String,
    #[serde(default, rename = "nativeAction")]
    pub native_action: String,
    #[serde(default, rename = "nativePath")]
    pub native_path: String,
    pub key: String,
    pub title: String,
    pub body: String,
    pub href: String,
    pub unread: bool,
    pub ongoing: bool,
    pub timestamp: String,
    #[serde(default, rename = "senderName")]
    pub sender_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Grain {
    #[serde(default, rename = "appId")]
    pub app_id: String,
    pub key: String,
    pub title: String,
    #[serde(default, rename = "ownerTitle")]
    pub owner_title: String,
    #[serde(default, rename = "iconSrc")]
    pub icon_src: String,
    pub href: String,
    pub owned: bool,
    #[serde(rename = "lastUsed")]
    pub last_used: String,
    #[serde(default, rename = "appTitle")]
    pub app_title: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Snapshot {
    #[serde(default, rename = "appsVersion")]
    pub apps_version: String,
    #[serde(default, rename = "accountPictureUrl")]
    pub account_picture_url: String,
    #[serde(default, rename = "profileVersion")]
    pub profile_version: String,
    #[serde(default, rename = "grainPage")]
    pub grain_page: u32,
    #[serde(default, rename = "notificationPage")]
    pub notification_page: u32,
    #[serde(default, rename = "hasUnread")]
    pub has_unread: bool,
    #[serde(default)]
    pub grains: Vec<Grain>,
    #[serde(default, rename = "grainsLimited")]
    pub grains_limited: bool,
    pub version: String,
    pub entries: Vec<Entry>,
    pub total: u32,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GrainSort {
    #[default]
    Recent,
    Title,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Ownership {
    #[default]
    All,
    Owned,
    Shared,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrainQuery {
    pub search: String,
    pub app_id: String,
    pub sort: GrainSort,
    pub ownership: Ownership,
    pub trash: bool,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct Pages {
    pub grains: u32,
    pub notifications: u32,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub name: String,
    pub key: String,
    pub picture_url: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SessionInfo {
    pub account: AccountInfo,
    pub expires: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub name: String,
    pub handle: String,
    pub pronoun: String,
    #[serde(default)]
    pub picture_url: String,
    pub version: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProfileEdit {
    pub name: String,
    pub handle: String,
    pub pronoun: String,
}

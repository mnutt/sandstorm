use super::presentation::*;
use super::sessions::Account;
use super::*;
use crate::read_model::Entry;
use mongodb::bson::Bson;

impl Repository {
    pub(super) async fn snapshot(
        &self,
        account: &Account,
        pages: Pages,
        query: Option<&GrainQuery>,
    ) -> Result<Snapshot, Error> {
        let grain_page = pages.grains;
        let notification_page = pages.notifications;
        let rows = self
            .aggregate(
                "notifications",
                vec![
                    doc! {"$match":{"userId":&account.account_id}},
                    doc! {"$sort":{"timestamp":-1,"_id":1}},
                    doc! {"$skip":i64::from(notification_page)*100},
                    doc! {"$limit":100},
                ],
            )
            .await?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(self.notification(&account.account_id, &row).await?);
        }
        let notification_filter = doc! {"userId":&account.account_id};
        let total = self
            .db
            .collection::<Document>("notifications")
            .count_documents(notification_filter)
            .await
            .map_err(|_| unavailable())?;
        let unread = self
            .find(
                "notifications",
                doc! {"userId":&account.account_id,"isUnread":true},
            )
            .await?
            .is_some();
        let (grains, grains_limited) = self.grains(&account.account_id, grain_page, query).await?;
        // Hash the account's material app projection, never a global DB revision.
        // Other users' writes must not reveal their activity in our app version.
        let apps = self.apps(&account.account_id, None, "").await?;
        let mut result = Snapshot {
            account_picture_url: account.picture.clone(),
            profile_version: self.profile_projection(&account.user).version,
            apps_version: hash(&serde_json::to_string(&apps).map_err(|_| unavailable())?),
            entries,
            total: total.try_into().unwrap_or(u32::MAX),
            has_unread: unread,
            notification_page,
            grain_page,
            grains,
            grains_limited,
            version: String::new(),
        };
        result.version = hash(&serde_json::to_string(&result).map_err(|_| unavailable())?);
        Ok(result)
    }

    async fn notification(&self, account: &str, row: &Document) -> Result<Entry, Error> {
        let mut title = "Notification".to_owned();
        let mut body = string(row, "text.defaultText");
        let mut path = "/".to_owned();
        let mut sender = String::new();
        let mut picture = String::new();
        let mut native = String::new();
        let mut action = "";
        let sender_id = string(row, "initiatingAccount");
        if !sender_id.is_empty() {
            if let Some(user) = self.find("users", doc! {"_id":sender_id}).await? {
                sender = string(&user, "profile.name");
                picture = self.picture(&user);
            }
        } else if truth(at(row, "initiatorAnonymous")) {
            sender = "Anonymous user".into();
        }
        let grain_id = string(row, "grainId");
        if !grain_id.is_empty() {
            let owned = self
                .find("grains", doc! {"_id":&grain_id,"userId":account})
                .await?;
            let mut name = owned
                .as_ref()
                .map(|g| string(g, "title"))
                .unwrap_or_default();
            if owned.is_none() {
                let token = self
                    .db
                    .collection::<Document>("apiTokens")
                    .find_one(doc! {"grainId":&grain_id,"owner.user.accountId":account,
                    "owner.user.denormalizedGrainMetadata":{"$exists":true},"revoked":{"$ne":true}})
                    .sort(doc! {"created":1,"_id":1})
                    .await
                    .map_err(|_| unavailable())?;
                if let Some(owner) = token
                    .as_ref()
                    .and_then(|t| at(t, "owner.user"))
                    .and_then(Bson::as_document)
                {
                    name = shared_title(owner);
                }
            }
            title = if name.is_empty() {
                "Grain activity".into()
            } else {
                name
            };
            path = format!("/grain/{}", encode(&grain_id));
            let app_path = string(row, "path");
            if !app_path.is_empty() {
                path.push('/');
                path.push_str(app_path.trim_start_matches('/'));
            }
            if truth(at(row, "ongoing")) && body.is_empty() {
                body = "This grain has an ongoing activity.".into();
            }
            if let Some(count) = millis(at(row, "count")).filter(|n| *n > 1) {
                body.push_str(&format!(" ({count} events)"));
            }
            if crate::backup::valid_id(&grain_id)
                && !app_path.chars().any(|c| c == '\\' || c.is_control())
            {
                let base = format!("/grain/{grain_id}");
                if let Ok(url) = self.main_url.join(&path) {
                    if url.path() == base || url.path().starts_with(&(base + "/")) {
                        native = url.path().to_owned();
                        if let Some(q) = url.query() {
                            native.push('?');
                            native.push_str(q);
                        }
                        if let Some(f) = url.fragment() {
                            native.push('#');
                            native.push_str(f);
                        }
                    }
                }
            }
        } else if let Some(updates) = at(row, "appUpdates").and_then(Bson::as_document) {
            title = "App updates available".into();
            body = updates
                .values()
                .filter_map(Bson::as_document)
                .map(|a| {
                    let name = string(a, "name");
                    if !name.is_empty() {
                        name
                    } else {
                        let name = string(a, "appTitle.defaultText");
                        if name.is_empty() {
                            "App update".into()
                        } else {
                            name
                        }
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            path = "/apps".into();
            native = "/install".into();
        } else if at(row, "admin").is_some() {
            title = "Administration".into();
            let stats = string(row, "admin.type") == "reportStats";
            body = if stats {
                "Choose whether to share anonymous usage statistics."
            } else {
                "An administrative action needs your attention."
            }
            .into();
            path = string(row, "admin.action");
            if path.is_empty() {
                path = "/admin".into();
            }
            if stats {
                action = "stats";
            }
        } else if truth(at(row, "referral")) {
            title = "Referral update".into();
            body = "View your referral activity and status.".into();
            path = "/referrals".into();
            action = "referrals";
        } else if truth(at(row, "identityChanges")) {
            title = "Account identities have changed".into();
            body = "Sandstorm updated how credentials link to your account.".into();
            action = "identity";
        } else if truth(at(row, "mailingListBonus")) {
            title = "Mailing list invitation".into();
            body = "View the invitation in the main shell.".into();
        }
        let href = self
            .main_url
            .join(&path)
            .ok()
            .filter(|u| u.origin() == self.main_url.origin() && u.as_str().len() <= 1024)
            .map(|u| u.to_string())
            .unwrap_or_else(|| self.main_url.origin().ascii_serialization());
        Ok(Entry {
            key: string(row, "_id"),
            sender_picture_url: picture,
            sender_name: clipped(&sender, 160, ""),
            native_path: native,
            native_action: action.into(),
            title: clipped(&title, 160, ""),
            body: clipped(&body, 512, ""),
            href,
            unread: truth(at(row, "isUnread")),
            ongoing: truth(at(row, "ongoing")),
            timestamp: date(at(row, "timestamp")),
        })
    }
}

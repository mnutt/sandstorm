use super::presentation::{at, clipped, millis, string};
use super::*;

pub(super) struct Account {
    pub account_id: String,
    pub name: String,
    pub picture: String,
    pub expires: i64,
    pub user: Document,
}
impl Repository {
    pub(super) async fn authorize(&self, token: &str) -> Result<Account, Error> {
        if token.len() != 64
            || !token
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(denied());
        }
        let key = hash(token);
        let linked = self
            .find("rustShellLinkedSessions", doc! {"_id":&key})
            .await?
            .ok_or_else(denied)?;
        let now = mongodb::bson::DateTime::now().timestamp_millis();
        let expires = millis(at(&linked, "expires")).ok_or_else(denied)?;
        if expires <= now {
            return Err(denied());
        }
        let account_id = string(&linked, "accountId");
        let login_hash = string(&linked, "loginHash");
        let user = self.find("users",doc!{"_id":&account_id,"suspended":{"$exists":false},
            "services.resume.loginTokens.hashedToken":&login_hash,"loginCredentials":{"$exists":true}}).await?.ok_or_else(denied)?;
        self.account_from_documents(&linked, user)
    }

    pub(super) fn account_from_documents(
        &self,
        linked: &Document,
        user: Document,
    ) -> Result<Account, Error> {
        let now = mongodb::bson::DateTime::now().timestamp_millis();
        let account_id = string(linked, "accountId");
        let login_hash = string(linked, "loginHash");
        let expires = millis(at(linked, "expires")).ok_or_else(denied)?;
        if at(&user, "loginCredentials")
            .and_then(|v| v.as_array())
            .is_none()
        {
            return Err(denied());
        }
        let login = at(&user, "services.resume.loginTokens")
            .and_then(|v| v.as_array())
            .and_then(|tokens| {
                tokens
                    .iter()
                    .filter_map(|v| v.as_document())
                    .find(|t| string(t, "hashedToken") == login_hash)
            })
            .ok_or_else(denied)?;
        // Sandstorm does not override Meteor's 90-day login lifetime. The linked
        // session's own (shorter) expiry remains authoritative too.
        let login_expires = millis(at(login, "when"))
            .ok_or_else(denied)?
            .saturating_add(90 * 24 * 60 * 60 * 1000);
        let expires = expires
            .min(login_expires)
            .min(millis(at(&user, "expires")).unwrap_or(i64::MAX));
        if expires <= now {
            return Err(denied());
        }
        Ok(Account {
            account_id,
            name: clipped(&string(&user, "profile.name"), 160, "Sandstorm account"),
            picture: self.picture(&user),
            expires,
            user,
        })
    }

    pub async fn revoke(&self, token: &str) -> Result<(), Error> {
        self.db
            .collection::<Document>("rustShellLinkedSessions")
            .delete_one(doc! {"_id":hash(token)})
            .await
            .map_err(|_| unavailable())?;
        Ok(())
    }
}

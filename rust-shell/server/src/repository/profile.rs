use super::presentation::{at, string};
use super::{hash, unavailable, Error, Repository};
use crate::read_model::{Profile, ProfileEdit};
use base64::{engine::general_purpose::STANDARD, Engine};
use mongodb::{
    bson::{doc, spec::BinarySubtype, Binary, Bson, Document},
    options::ReturnDocument,
};
use sha2::{Digest, Sha256};

pub struct Picture {
    pub content: Vec<u8>,
    pub mime_type: &'static str,
    pub gzip: bool,
}

fn image_type(content: &[u8]) -> Result<&'static str, Error> {
    if content.len() > 65536 {
        return Err(Error::Invalid(
            "Picture too large; please use an image under 64 KiB.",
        ));
    }
    if content.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok("image/png")
    } else if content.starts_with(b"\xff\xd8\xff") {
        Ok("image/jpeg")
    } else {
        Err(Error::Invalid("Image must be PNG or JPEG."))
    }
}

impl Repository {
    pub(super) fn profile_projection(&self, user: &Document) -> Profile {
        let canonical_picture = self.canonical_picture(user);
        let version = hash(
            &serde_json::json!([
                at(user, "profile.name").and_then(Bson::as_str),
                at(user, "profile.handle").and_then(Bson::as_str),
                at(user, "profile.pronoun").and_then(Bson::as_str),
                canonical_picture,
            ])
            .to_string(),
        );
        let pronoun = string(user, "profile.pronoun");
        Profile {
            name: string(user, "profile.name"),
            handle: string(user, "profile.handle"),
            pronoun: if pronoun.is_empty() {
                "neutral".into()
            } else {
                pronoun
            },
            picture_url: self.picture(user),
            version,
        }
    }

    pub async fn profile(&self, token: &str) -> Result<Profile, Error> {
        let account = self.authorize(token).await?;
        let profile = self.profile_projection(&account.user);
        self.authorize(token).await?;
        Ok(profile)
    }

    pub async fn update_profile(&self, token: &str, edit: ProfileEdit) -> Result<Profile, Error> {
        let mut handle = edit.handle.bytes();
        let valid_handle = handle
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b == b'_')
            && handle.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
        if edit.name.trim().is_empty()
            || !valid_handle
            || !matches!(
                edit.pronoun.as_str(),
                "male" | "female" | "neutral" | "robot"
            )
        {
            return Err(Error::Invalid(
                "Enter a name, a lowercase handle, and a valid pronoun option.",
            ));
        }
        let (mut transaction, account) = self.begin_write(token).await?;
        let updated = self.db.collection::<Document>("users").find_one_and_update(doc!{"_id":&account.account_id},doc!{"$set":{
            "profile.name":edit.name,"profile.handle":edit.handle,"profile.pronoun":edit.pronoun,"hasCompletedSignup":true,
        }}).return_document(ReturnDocument::After).session(&mut transaction).await.map_err(|_| unavailable())?.ok_or_else(unavailable)?;
        let profile = self.profile_projection(&updated);
        self.commit_write(&mut transaction, account.expires).await?;
        Ok(profile)
    }

    pub async fn update_picture(&self, token: &str, content: Vec<u8>) -> Result<(), Error> {
        let mime_type = image_type(&content)?;
        // Match addStaticAsset's hash (undefined encoding is literally "undefined").
        let mut digest = Sha256::new();
        digest.update(format!("{mime_type}\nundefined\n"));
        digest.update(&content);
        let hash = STANDARD.encode(digest.finalize());
        let (mut transaction, account) = self.begin_write(token).await?;
        let assets = self.db.collection::<Document>("staticAssets");
        let existing = assets
            .find_one_and_update(
                doc! {"hash":&hash,"refcount":{"$gte":1}},
                doc! {"$inc":{"refcount":1}},
            )
            .session(&mut transaction)
            .await
            .map_err(|_| unavailable())?;
        let id = match existing {
            Some(asset) => string(&asset, "_id"),
            None => {
                let mut random = [0u8; 16];
                getrandom::fill(&mut random).map_err(|_| unavailable())?;
                let id: String = random.iter().map(|b| format!("{b:02x}")).collect();
                assets
                    .insert_one(
                        doc! {"_id":&id,"hash":hash,"refcount":1,"mimeType":mime_type,
                        "content":Binary{subtype:BinarySubtype::Generic,bytes:content}},
                    )
                    .session(&mut transaction)
                    .await
                    .map_err(|_| unavailable())?;
                id
            }
        };
        self.db
            .collection::<Document>("users")
            .update_one(
                doc! {"_id":&account.account_id},
                doc! {"$set":{"profile.picture":&id}},
            )
            .session(&mut transaction)
            .await
            .map_err(|_| unavailable())?;
        let old = string(&account.user, "profile.picture");
        if !old.is_empty() {
            assets
                .update_one(doc! {"_id":&old}, doc! {"$inc":{"refcount":-1}})
                .session(&mut transaction)
                .await
                .map_err(|_| unavailable())?;
            assets
                .delete_one(doc! {"_id":old,"refcount":{"$lte":0}})
                .session(&mut transaction)
                .await
                .map_err(|_| unavailable())?;
        }
        self.commit_write(&mut transaction, account.expires).await
    }

    /// Public immutable images, just like the existing static host. Never serve
    /// arbitrary MIME types or user-selected headers on the authenticated origin.
    pub async fn picture_asset(&self, id: &str) -> Result<Option<Picture>, Error> {
        let Some(asset) = self
            .find("staticAssets", doc! {"_id":id,"refcount":{"$gt":0}})
            .await?
        else {
            return Ok(None);
        };
        let mime = string(&asset, "mimeType");
        let mime_type = match mime.split(';').next().map(str::trim) {
            Some("image/png") => "image/png",
            Some("image/jpeg") => "image/jpeg",
            _ => return Ok(None),
        };
        let gzip = match string(&asset, "encoding").as_str() {
            "" => false,
            "gzip" => true,
            _ => return Ok(None),
        };
        let Some(Bson::Binary(content)) = asset.get("content") else {
            return Ok(None);
        };
        Ok(Some(Picture {
            content: content.bytes.clone(),
            mime_type,
            gzip,
        }))
    }
}

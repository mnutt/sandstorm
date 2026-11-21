//! Native writes share one authorization/transaction boundary. Touching the
//! linked session serializes against logout; updating the user serializes against
//! upstream token revocation and suspension. No mutation is automatically replayed.
use super::presentation::string;
use super::sessions::Account;
use super::{denied, hash, unavailable, Error, Repository};
use mongodb::{
    bson::{doc, DateTime, Document},
    options::{ReadConcern, ReturnDocument},
    ClientSession,
};

impl Repository {
    pub(super) async fn begin_write(&self, token: &str) -> Result<(ClientSession, Account), Error> {
        let mut transaction = self
            .db
            .client()
            .start_session()
            .await
            .map_err(|_| unavailable())?;
        transaction
            .start_transaction()
            .read_concern(ReadConcern::snapshot())
            .await
            .map_err(|_| unavailable())?;
        let authorization = async {
            let linked = self
                .db
                .collection::<Document>("rustShellLinkedSessions")
                .find_one_and_update(
                    doc! {"_id":hash(token),"expires":{"$gt":DateTime::now().timestamp_millis()}},
                    doc! {"$currentDate":{"lastNativeWrite":true}},
                )
                .return_document(ReturnDocument::After)
                .session(&mut transaction)
                .await
                .map_err(|_| unavailable())?
                .ok_or_else(denied)?;
            let user = self
                .db
                .collection::<Document>("users")
                .find_one(doc! {
                    "_id":string(&linked,"accountId"),"suspended":{"$exists":false},
                    "services.resume.loginTokens.hashedToken":string(&linked,"loginHash"),
                })
                .session(&mut transaction)
                .await
                .map_err(|_| unavailable())?
                .ok_or_else(denied)?;
            self.account_from_documents(&linked, user)
        }
        .await;
        match authorization {
            Ok(account) => Ok((transaction, account)),
            Err(error) => {
                // Release the link lock before responding to a rejected write.
                let _ = transaction.abort_transaction().await;
                Err(error)
            }
        }
    }

    pub(super) async fn commit_write(
        &self,
        transaction: &mut ClientSession,
        expires: i64,
    ) -> Result<(), Error> {
        if expires <= DateTime::now().timestamp_millis() {
            let _ = transaction.abort_transaction().await;
            return Err(denied());
        }
        transaction
            .commit_transaction()
            .await
            .map_err(|_| unavailable())
    }
}

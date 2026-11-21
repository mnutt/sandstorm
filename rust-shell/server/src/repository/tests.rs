//! Exercises the adapter against a disposable replica set. Never accepts a URI
//! for an existing database: the test owns both the process and all its data.
use super::*;
use mongodb::bson::DateTime;
use std::{
    net::TcpListener,
    path::PathBuf,
    process::{Child, Command, Stdio},
};

struct Mongo {
    process: Child,
    directory: PathBuf,
}
impl Drop for Mongo {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[tokio::test]
#[ignore = "requires bundled mongod7; run make -C rust-shell test-mongo"]
async fn native_reads_and_session_revocation_without_meteor() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let directory = std::env::temp_dir().join(format!("rust-shell-mongo-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    drop(listener);
    let start = || {
        Command::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../build/dev/bundle/bin/mongod7"
        ))
        .args([
            "--bind_ip",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--replSet",
            "test",
        ])
        .arg("--dbpath")
        .arg(&directory)
        .arg("--logpath")
        .arg(directory.join("mongo.log"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
    };
    let mut mongo = Mongo {
        process: start(),
        directory: directory.clone(),
    };
    let direct = Client::with_uri_str(format!(
        "mongodb://127.0.0.1:{port}/?directConnection=true&serverSelectionTimeoutMS=1000"
    ))
    .await
    .unwrap();
    let admin = direct.database("admin");
    tokio::time::timeout(Duration::from_secs(20), async {
        while admin.run_command(doc! {"ping":1}).await.is_err() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    admin.run_command(doc!{"replSetInitiate":{"_id":"test","members":[{"_id":0,"host":format!("127.0.0.1:{port}")}]}}).await.unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let hello = admin.run_command(doc! {"hello":1}).await.unwrap();
            if hello.get_bool("isWritablePrimary").unwrap_or(false) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    let repo = Repository::connect(
        &format!("mongodb://127.0.0.1:{port}/meteor?replicaSet=test"),
        "https://example.test",
        "*.example.test",
    )
    .await
    .unwrap();
    let mut ready = repo.changes.subscribe();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !*ready.borrow_and_update() {
            ready.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    let collection = |name| repo.db.collection::<Document>(name);
    let now = DateTime::now();
    let cookie = "a".repeat(64);
    collection("users").insert_one(doc!{"_id":"alice","profile":{"name":"Alice","handle":"alice","pronoun":"female"},
        "loginCredentials":[],"services":{"resume":{"loginTokens":[{"hashedToken":"login","when":now}]}}}).await.unwrap();
    collection("rustShellLinkedSessions").insert_one(doc!{"_id":hash(&cookie),"accountId":"alice","loginHash":"login","expires":now.timestamp_millis()+3_600_000}).await.unwrap();
    collection("packages").insert_one(doc!{"_id":"pkg","appId":"app","manifest":{"appTitle":{"defaultText":"Test app"},
        "metadata":{"shortDescription":{"defaultText":"Description"},"icons":{"appGrid":{"svg":"<svg/>"}}}}}).await.unwrap();
    collection("userActions").insert_many([
        doc!{"_id":"action","userId":"alice","appId":"app","packageId":"pkg","title":{"defaultText":"New Test"},"appTitle":{"defaultText":"Test app"}},
        doc!{"_id":"private-action","userId":"bob","appId":"app"},
    ]).await.unwrap();
    collection("grains").insert_many([
        doc!{"_id":"owned","userId":"alice","appId":"app","packageId":"pkg","title":"Owned [literal]","lastUsed":now},
        doc!{"_id":"shared","userId":"bob","appId":"app","title":"Owner title","lastUsed":now},
        doc!{"_id":"private","userId":"bob","appId":"app","title":"Private","lastUsed":now},
        doc!{"_id":"trash","userId":"alice","appId":"app","title":"Trash","trashed":now},
    ]).await.unwrap();
    let metadata =
        doc! {"appId":"app","appTitle":{"defaultText":"Test app"},"icon":{"svg":"<svg/>"}};
    collection("apiTokens").insert_many([
        doc!{"_id":"share1","grainId":"shared","created":now,"owner":{"user":{"accountId":"alice","title":"Personal title","upstreamTitle":"New owner title","renamed":true,"denormalizedGrainMetadata":&metadata}}},
        doc!{"_id":"share2","grainId":"shared","created":now,"owner":{"user":{"accountId":"alice","title":"Duplicate","denormalizedGrainMetadata":&metadata}}},
        doc!{"_id":"self","grainId":"owned","created":now,"owner":{"user":{"accountId":"alice","title":"Self-share","denormalizedGrainMetadata":&metadata}}},
    ]).await.unwrap();
    collection("notifications").insert_many([
        doc!{"_id":"notice","userId":"alice","grainId":"owned","timestamp":now,"isUnread":true,"path":"../private"},
        doc!{"_id":"other-notice","userId":"bob","timestamp":now,"isUnread":true},
    ]).await.unwrap();
    // No Meteor process or bridge socket exists in this test.
    let session = crate::session::Session {
        repository: Some(repo.clone()),
        token: cookie.clone(),
        bridge: crate::bridge::Bridge::new(mongo.directory.join("absent.sock")).unwrap(),
    };
    assert_eq!(session.info().await.unwrap().account.name, "Alice");
    let initial = session.snapshot().await.unwrap();
    assert_eq!(initial.grains.len(), 2);
    let shared = initial.grains.iter().find(|g| g.key == "shared").unwrap();
    assert_eq!(shared.title, "Personal title");
    assert_eq!(shared.owner_title, "New owner title");
    assert_eq!(initial.total, 1);
    assert!(initial.has_unread);
    assert_eq!(initial.entries[0].native_path, "");
    assert_eq!(
        initial.profile_version,
        hash(r#"["Alice","alice","female",""]"#)
    );
    let apps = session.apps(0, "").await.unwrap();
    assert_eq!(apps.actions.len(), 1);
    assert_eq!(apps.actions[0].grain_count, 2);
    assert_eq!(apps.actions[0].short_description, "Description");
    let query = GrainQuery {
        search: "[literal]".into(),
        ..Default::default()
    };
    let searched = repo
        .watch(&cookie, None, Pages::default(), Some(&query))
        .await
        .unwrap();
    assert_eq!(searched.grains.len(), 1);
    assert_eq!(searched.grains[0].key, "owned");
    let trash = GrainQuery {
        trash: true,
        ..Default::default()
    };
    assert_eq!(
        repo.watch(&cookie, None, Pages::default(), Some(&trash))
            .await
            .unwrap()
            .grains[0]
            .key,
        "trash"
    );
    let pending = session.watch(&initial.version, Pages::default());
    let change = async {
        collection("grains")
            .update_one(
                doc! {"_id":"owned"},
                doc! {"$set":{"title":"Changed externally"}},
            )
            .await
            .unwrap();
    };
    let (changed, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(pending, change)
    })
    .await
    .unwrap();
    let changed = changed.unwrap();
    assert!(changed
        .grains
        .iter()
        .any(|g| g.title == "Changed externally"));
    // Another account's activity must not leak via the app version.
    collection("grains")
        .update_one(
            doc! {"_id":"private"},
            doc! {"$set":{"title":"Private change"}},
        )
        .await
        .unwrap();
    assert_eq!(
        session.snapshot().await.unwrap().apps_version,
        changed.apps_version
    );
    collection("grains")
        .update_one(doc! {"_id":"trash"}, doc! {"$unset":{"trashed":""}})
        .await
        .unwrap();
    let updated = session
        .watch(&changed.version, Pages::default())
        .await
        .unwrap();
    assert_ne!(updated.apps_version, changed.apps_version);
    assert_eq!(session.apps(0, "").await.unwrap().actions[0].grain_count, 3);
    // Pending capabilities are invalidated by upstream token revocation.
    let pending = repo.watch(&cookie, Some(&updated.version), Pages::default(), None);
    let revoke = async {
        collection("users")
            .update_one(
                doc! {"_id":"alice"},
                doc! {"$set":{"services.resume.loginTokens":[]}},
            )
            .await
            .unwrap();
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(pending, revoke)
    })
    .await
    .unwrap();
    assert_eq!(result.unwrap_err(), Error::Unauthorized);
    collection("users").update_one(doc!{"_id":"alice"},doc!{"$set":{"services.resume.loginTokens":[{"hashedToken":"login","when":now}],"suspended":false}}).await.unwrap();
    assert_eq!(
        repo.session(&cookie).await.unwrap_err(),
        Error::Unauthorized
    ); // existence, not truthiness
    collection("users")
        .update_one(
            doc! {"_id":"alice"},
            doc! {"$unset":{"suspended":""},"$set":{"expires":DateTime::from_millis(1)}},
        )
        .await
        .unwrap();
    assert_eq!(
        repo.session(&cookie).await.unwrap_err(),
        Error::Unauthorized
    );
    collection("users")
        .update_one(doc! {"_id":"alice"}, doc! {"$unset":{"expires":""}})
        .await
        .unwrap();
    collection("rustShellLinkedSessions")
        .update_one(doc! {"_id":hash(&cookie)}, doc! {"$set":{"expires":1}})
        .await
        .unwrap();
    assert_eq!(
        repo.session(&cookie).await.unwrap_err(),
        Error::Unauthorized
    );
    collection("rustShellLinkedSessions")
        .update_one(
            doc! {"_id":hash(&cookie)},
            doc! {"$set":{"expires":now.timestamp_millis()+3_600_000}},
        )
        .await
        .unwrap();
    // Expiry must invalidate an idle watch without another database write.
    collection("rustShellLinkedSessions")
        .update_one(
            doc! {"_id":hash(&cookie)},
            doc! {"$set":{"expires":DateTime::now().timestamp_millis()+1500}},
        )
        .await
        .unwrap();
    let snapshot = session.snapshot().await.unwrap();
    assert_eq!(
        tokio::time::timeout(
            Duration::from_secs(5),
            repo.watch(&cookie, Some(&snapshot.version), Pages::default(), None)
        )
        .await
        .unwrap()
        .unwrap_err(),
        Error::Unauthorized
    );
    collection("rustShellLinkedSessions")
        .update_one(
            doc! {"_id":hash(&cookie)},
            doc! {"$set":{"expires":now.timestamp_millis()+3_600_000}},
        )
        .await
        .unwrap();
    // An outage is not a logout. The same durable link works after recovery.
    mongo.process.kill().unwrap();
    mongo.process.wait().unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(20), repo.session(&cookie))
            .await
            .unwrap()
            .unwrap_err(),
        Error::Unavailable
    );
    mongo.process = start();
    tokio::time::timeout(Duration::from_secs(30), async {
        while session.snapshot().await.is_err() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(session.info().await.unwrap().account.name, "Alice");
    exercise_profiles(&repo, &session).await;
    assert!(session.logout().await.is_ok());
    assert_eq!(
        repo.session(&cookie).await.unwrap_err(),
        Error::Unauthorized
    );
}

#[test]
fn dates_match_javascript_and_hashes_match_existing_tokens() {
    use super::presentation::date;
    assert_eq!(
        date(Some(&DateTime::from_millis(0).into())),
        "1970-01-01T00:00:00.000Z"
    );
    assert_eq!(
        date(Some(&DateTime::from_millis(120).into())),
        "1970-01-01T00:00:00.120Z"
    );
    assert_eq!(
        date(Some(&DateTime::from_millis(-1).into())),
        "1969-12-31T23:59:59.999Z"
    );
    assert_eq!(date(Some(&0.into())), "");
    assert_eq!(
        hash("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

async fn exercise_profiles(repo: &Repository, session: &crate::session::Session) {
    use crate::read_model::ProfileEdit;
    use base64::{engine::general_purpose::STANDARD, Engine};
    let edit = || ProfileEdit {
        name: "Native Alice".into(),
        handle: "native_alice".into(),
        pronoun: "robot".into(),
    };
    let before = session.profile().await.unwrap();
    for invalid in [
        ProfileEdit {
            name: " ".into(),
            ..edit()
        },
        ProfileEdit {
            handle: "Upper Case".into(),
            ..edit()
        },
        ProfileEdit {
            pronoun: "invalid".into(),
            ..edit()
        },
    ] {
        assert!(matches!(
            repo.update_profile(&session.token, invalid).await,
            Err(Error::Invalid(_))
        ));
    }
    let users = repo.db.collection::<Document>("users");
    users
        .update_one(
            doc! {"_id":"alice"},
            doc! {"$set":{"profile.extra":"keep","unverifiedEmail":"keep@example.test"}},
        )
        .await
        .unwrap();
    let updated = session.update_profile(edit()).await.unwrap();
    assert_eq!(updated.name, "Native Alice");
    assert_ne!(updated.version, before.version);
    assert_eq!(
        session.snapshot().await.unwrap().profile_version,
        updated.version
    );
    let alice = users.find_one(doc! {"_id":"alice"}).await.unwrap().unwrap();
    assert!(alice.get_bool("hasCompletedSignup").unwrap());
    assert_eq!(super::presentation::string(&alice, "profile.extra"), "keep");
    assert_eq!(
        super::presentation::string(&alice, "unverifiedEmail"),
        "keep@example.test"
    );
    let png=STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=").unwrap();
    assert!(matches!(
        repo.update_picture(&session.token, vec![0; 65537]).await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        repo.update_picture(&session.token, b"<svg/>".to_vec())
            .await,
        Err(Error::Invalid(_))
    ));
    repo.update_picture(&session.token, png.clone())
        .await
        .unwrap();
    let profile = session.profile().await.unwrap();
    let id = profile
        .picture_url
        .strip_prefix("/profile-picture/")
        .unwrap();
    let assets = repo.db.collection::<Document>("staticAssets");
    let picture = repo.picture_asset(id).await.unwrap().unwrap();
    assert_eq!(picture.content, png);
    assert_eq!(picture.mime_type, "image/png");
    assert!(!picture.gzip);
    repo.update_picture(&session.token, png.clone())
        .await
        .unwrap();
    assert_eq!(
        assets
            .find_one(doc! {"_id":id})
            .await
            .unwrap()
            .unwrap()
            .get_i32("refcount")
            .unwrap(),
        1
    );
    assert_eq!(session.profile().await.unwrap().version, profile.version);
    // The legacy shell hashes the static-host URL, even though native display
    // uses our same-origin endpoint. Both shells must agree on profile versions.
    assert_eq!(
        profile.version,
        hash(&format!(
            r#"["Native Alice","native_alice","robot","https://static.example.test/{id}"]"#
        ))
    );
    let bob_token = "b".repeat(64);
    users.insert_one(doc!{"_id":"profile-bob","profile":{"name":"Bob"},"loginCredentials":[],"services":{"resume":{"loginTokens":[{"hashedToken":"bob-login","when":DateTime::now()}]}}}).await.unwrap();
    repo.db.collection::<Document>("rustShellLinkedSessions").insert_one(doc!{"_id":hash(&bob_token),"accountId":"profile-bob","loginHash":"bob-login","expires":DateTime::now().timestamp_millis()+3600000}).await.unwrap();
    repo.update_picture(&bob_token, png).await.unwrap();
    assert_eq!(
        assets
            .find_one(doc! {"_id":id})
            .await
            .unwrap()
            .unwrap()
            .get_i32("refcount")
            .unwrap(),
        2
    );
    assert_eq!(repo.profile(&bob_token).await.unwrap().name, "Bob");
    let jpeg = b"\xff\xd8\xfftest".to_vec();
    repo.update_picture(&session.token, jpeg.clone())
        .await
        .unwrap();
    assert_eq!(
        assets
            .find_one(doc! {"_id":id})
            .await
            .unwrap()
            .unwrap()
            .get_i32("refcount")
            .unwrap(),
        1
    );
    repo.update_picture(&bob_token, jpeg).await.unwrap();
    assert!(assets.find_one(doc! {"_id":id}).await.unwrap().is_none());
    assets.insert_one(doc!{"_id":"script","mimeType":"text/html","refcount":1,"content":mongodb::bson::Binary{subtype:mongodb::bson::spec::BinarySubtype::Generic,bytes:b"<script/>".to_vec()}}).await.unwrap();
    assert!(repo.picture_asset("script").await.unwrap().is_none());
    // A revoke after the transaction's authorization read must conflict with its
    // user write. It cannot commit a stale-authority profile mutation.
    let (mut transaction, _) = repo.begin_write(&session.token).await.unwrap();
    users
        .update_one(
            doc! {"_id":"alice"},
            doc! {"$set":{"services.resume.loginTokens":[]}},
        )
        .await
        .unwrap();
    assert!(users
        .update_one(
            doc! {"_id":"alice"},
            doc! {"$set":{"profile.name":"Unauthorized"}}
        )
        .session(&mut transaction)
        .await
        .is_err());
    let _ = transaction.abort_transaction().await;
    assert_eq!(
        super::presentation::string(
            &users.find_one(doc! {"_id":"alice"}).await.unwrap().unwrap(),
            "profile.name"
        ),
        "Native Alice"
    );
    assert!(matches!(
        repo.update_profile(&session.token, edit()).await,
        Err(Error::Unauthorized)
    ));
    assert!(matches!(
        repo.update_picture(&session.token, b"\xff\xd8\xff".to_vec())
            .await,
        Err(Error::Unauthorized)
    ));
    // Restore the fixture for the caller's durable logout check.
    users.update_one(doc!{"_id":"alice"},doc!{"$set":{"services.resume.loginTokens":[{"hashedToken":"login","when":DateTime::now()}]}}).await.unwrap();
    repo.revoke(&bob_token).await.unwrap();
}

use super::presentation::*;
use super::*;
use crate::read_model::{AppAction, Grain, GrainSort, Ownership};
use mongodb::bson::Bson;
use std::collections::HashMap;

impl Repository {
    pub(super) async fn grains(
        &self,
        account: &str,
        page: u32,
        query: Option<&GrainQuery>,
    ) -> Result<(Vec<Grain>, bool), Error> {
        let trash = query.is_some_and(|q| q.trash);
        let shared = vec![
            doc! {"$match":{"owner.user.accountId":account,"grainId":{"$type":"string"},"owner.user.denormalizedGrainMetadata":{"$exists":true},"revoked":{"$ne":true},"trashed":{"$exists":trash},"suspended":{"$exists":false}}},
            doc! {"$sort":{"created":1,"_id":1}},
            doc! {"$group":{"_id":"$grainId","owner":{"$first":"$owner.user"},"lastUsed":{"$max":{"$ifNull":["$lastUsed","$created"]}}}},
            doc! {"$lookup":{"from":"grains","localField":"_id","foreignField":"_id","as":"grain"}},
            doc! {"$match":{"grain.userId":{"$ne":account}}},
            doc! {"$project":{"owner":1,"lastUsed":1,"owned":{"$literal":false},"appId":"$owner.denormalizedGrainMetadata.appId",
            "title":{"$cond":[{"$and":[{"$ifNull":["$owner.upstreamTitle",false]},{"$not":["$owner.renamed"]}]},"$owner.upstreamTitle","$owner.title"]},
            "appTitle":"$owner.denormalizedGrainMetadata.appTitle.defaultText"}},
        ];
        let mut pipeline = vec![
            doc! {"$match":{"userId":account,"trashed":{"$exists":trash},"suspended":{"$exists":false}}},
            doc! {"$project":{"title":1,"packageId":1,"appId":1,"lastUsed":{"$ifNull":["$lastUsed","$created"]},"owned":{"$literal":true}}},
            doc! {"$lookup":{"from":"packages","localField":"packageId","foreignField":"_id","as":"package"}},
            doc! {"$set":{"appTitle":{"$arrayElemAt":["$package.manifest.appTitle.defaultText",0]}}},
            doc! {"$unionWith":{"coll":"apiTokens","pipeline":shared}},
        ];
        let mut matching = doc! {};
        if let Some(query) = query {
            match query.ownership {
                Ownership::Owned => {
                    matching.insert("owned", true);
                }
                Ownership::Shared => {
                    matching.insert("owned", false);
                }
                Ownership::All => {}
            }
            if !query.app_id.is_empty() {
                matching.insert("appId", &query.app_id);
            }
            let search = query.search.trim();
            if !search.is_empty() {
                let escaped = regex_literal(search);
                matching.insert(
                    "$or",
                    vec![
                        doc! {"title":{"$regex":&escaped,"$options":"i"}},
                        doc! {"appTitle":{"$regex":&escaped,"$options":"i"}},
                    ],
                );
            }
        }
        pipeline.push(doc! {"$match":matching});
        pipeline.push(
            if query.is_some_and(|q| matches!(q.sort, GrainSort::Title)) {
                doc! {"$sort":{"title":1,"_id":1}}
            } else {
                doc! {"$sort":{"lastUsed":-1,"_id":1}}
            },
        );
        pipeline.push(doc! {"$skip":i64::from(page)*100});
        pipeline.push(doc! {"$limit":101});
        let rows = self.aggregate("grains", pipeline).await?;
        let grains = rows
            .iter()
            .take(100)
            .map(|row| {
                let owned = truth(at(row, "owned"));
                let package = at(row, "package")
                    .and_then(Bson::as_array)
                    .and_then(|a| a.first())
                    .and_then(Bson::as_document);
                let metadata =
                    at(row, "owner.denormalizedGrainMetadata").and_then(Bson::as_document);
                let key = string(row, "_id");
                let title = clipped(&string(row, "title"), 160, "Untitled grain");
                let owner_title = if owned {
                    title.clone()
                } else {
                    let upstream = string(row, "owner.upstreamTitle");
                    if upstream.is_empty() {
                        string(row, "owner.title")
                    } else {
                        upstream
                    }
                };
                let icon = if owned {
                    self.package_icon(package, false)
                } else {
                    metadata
                        .map(|m| {
                            self.icon(
                                &string(m, "appId"),
                                at(m, "icon").and_then(Bson::as_document),
                                false,
                            )
                        })
                        .unwrap_or_default()
                };
                Grain {
                    key: key.clone(),
                    title,
                    owner_title: clipped(&owner_title, 160, "Untitled grain"),
                    owned,
                    app_id: string(row, "appId"),
                    app_title: clipped(&string(row, "appTitle"), 160, ""),
                    last_used: date(at(row, "lastUsed")),
                    icon_src: icon,
                    href: self
                        .main_url
                        .join(&format!("/grain/{}", encode(&key)))
                        .expect("encoded grain path")
                        .to_string(),
                }
            })
            .collect();
        Ok((grains, rows.len() > 100))
    }

    pub(super) async fn apps(
        &self,
        account: &str,
        page: Option<u32>,
        app_id: &str,
    ) -> Result<AppList, Error> {
        let mut query = doc! {"userId":account};
        if !app_id.is_empty() {
            query.insert("appId", app_id);
        }
        let mut pipeline = vec![doc! {"$match":query}, doc! {"$sort":{"appId":1,"_id":1}}];
        if let Some(page) = page {
            pipeline.extend([doc! {"$skip":i64::from(page)*100}, doc! {"$limit":101}]);
        }
        let rows = self.aggregate("userActions", pipeline).await?;
        let limited = page.is_some() && rows.len() > 100;
        let actions = &rows[..if page.is_some() {
            rows.len().min(100)
        } else {
            rows.len()
        }];
        let app_ids: Vec<_> = actions
            .iter()
            .map(|a| string(a, "appId"))
            .filter(|s| !s.is_empty())
            .collect();
        let package_ids: Vec<_> = actions
            .iter()
            .map(|a| string(a, "packageId"))
            .filter(|s| !s.is_empty())
            .collect();
        let packages = self
            .aggregate(
                "packages",
                vec![doc! {"$match":{"_id":{"$in":package_ids}}}],
            )
            .await?;
        let packages: HashMap<_, _> = packages
            .into_iter()
            .map(|p| (string(&p, "_id"), p))
            .collect();
        let mut usage=self.aggregate("grains",vec![doc!{"$match":{"userId":account,"appId":{"$in":&app_ids},"trashed":{"$exists":false},"suspended":{"$exists":false}}},
doc!{"$group":{"_id":"$appId","lastUsed":{"$max":"$lastUsed"},"grainCount":{"$sum":1}}}]).await?;
        usage.extend(self.aggregate("apiTokens",vec![doc!{"$match":{"owner.user.accountId":account,"owner.user.denormalizedGrainMetadata.appId":{"$in":&app_ids},"revoked":{"$ne":true},"trashed":{"$exists":false},"suspended":{"$exists":false}}},
doc!{"$lookup":{"from":"grains","localField":"grainId","foreignField":"_id","as":"grain"}},
doc!{"$unwind":"$grain"},
doc!{"$match":{"grain.userId":{"$ne":account},"grain.trashed":{"$exists":false},"grain.suspended":{"$exists":false}}},
doc!{"$group":{"_id":"$grainId","appId":{"$first":"$grain.appId"},"lastUsed":{"$max":"$lastUsed"}}},
doc!{"$group":{"_id":"$appId","lastUsed":{"$max":"$lastUsed"},"grainCount":{"$sum":1}}}]).await?);
        let mut counts: HashMap<String, i64> = HashMap::new();
        let mut recent: HashMap<String, String> = HashMap::new();
        for row in usage {
            let app = string(&row, "_id");
            *counts.entry(app.clone()).or_default() += millis(at(&row, "grainCount")).unwrap_or(0);
            let used = date(at(&row, "lastUsed"));
            let last = recent.entry(app).or_default();
            if used > *last {
                *last = used;
            }
        }
        let values = actions
            .iter()
            .map(|row| {
                let app = string(row, "appId");
                let key = string(row, "_id");
                let package = packages.get(&string(row, "packageId"));
                AppAction {
                    app_id: if app.is_empty() {
                        key.clone()
                    } else {
                        app.clone()
                    },
                    key,
                    title: clipped(&string(row, "title.defaultText"), 160, "New grain"),
                    app_title: clipped(&string(row, "appTitle.defaultText"), 160, "Installed app"),
                    icon_src: self.package_icon(package, true),
                    short_description: package
                        .map(|p| {
                            clipped(
                                &string(p, "manifest.metadata.shortDescription.defaultText"),
                                160,
                                "",
                            )
                        })
                        .unwrap_or_default(),
                    grain_count: counts
                        .get(&app)
                        .copied()
                        .unwrap_or(0)
                        .try_into()
                        .unwrap_or(u32::MAX),
                    last_used: recent.get(&app).cloned().unwrap_or_default(),
                }
            })
            .collect();
        Ok(AppList {
            actions: values,
            limited,
        })
    }
}

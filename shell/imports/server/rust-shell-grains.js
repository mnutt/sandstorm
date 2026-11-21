import { iconSrcForPackage, iconSrcForDenormalizedGrainMetadata } from "/imports/sandstorm-identicons/helpers";
import { SandstormDb } from "/imports/sandstorm-db/db";
import { computeTitleFromTokenOwnerUser } from "/imports/shared/grain-title";

// Match the account's displayed title, including owner renames and personal overrides.
export async function rustGrainTitles(db, accountId, grainId) {
  const grain = await db.collections.grains.findOneAsync({ _id: grainId, userId: accountId }, { fields: { title: 1, packageId: 1 } });
  const staticPrefix = new URL(process.env.ROOT_URL).protocol + "//" + db.makeWildcardHost("static");
  if (grain) {
    const pkg = grain.packageId && await db.collections.packages.findOneAsync(grain.packageId);
    return { title: grain.title, ownerTitle: grain.title,
      iconSrc: pkg ? iconSrcForPackage(pkg, "grain", staticPrefix) : "" };
  }
  const token = await db.collections.apiTokens.findOneAsync({ grainId,
    objectId: { $exists: false }, "owner.user.accountId": accountId },
    { sort: { created: 1, _id: 1 }, fields: { "owner.user": 1 } });
  const fullTitle = token ? computeTitleFromTokenOwnerUser(token.owner.user) : { title: "shared grain" };
  const metadata = token?.owner.user.denormalizedGrainMetadata;
  return { title: fullTitle.title, ownerTitle: fullTitle.renamedFrom ?? fullTitle.title,
    iconSrc: metadata ? iconSrcForDenormalizedGrainMetadata(metadata, "grain", staticPrefix) : "" };
}

const LIMIT = 50;
const text = (value) => Buffer.from(String(value || "Untitled grain")).subarray(0, 160).toString();
const date = (value) => value instanceof Date && Number.isFinite(+value) ? value.toISOString() : "";

// A bounded menu projection, not a grant of access. The existing shell checks
// the sharing chain when the user follows a grain link.
export async function grainMenu(db, accountId, mainUrl, page = 0, query) {
  if (query) return queryGrains(db,accountId,mainUrl,page,query);
  const owned = await db.collections.grains.find({ userId: accountId,
    trashed: { $exists: false }, suspended: { $exists: false } }, {
    sort: { lastUsed: -1, _id: 1 }, skip: page * LIMIT, limit: LIMIT + 1,
    fields: { title: 1, appId: 1, packageId: 1, lastUsed: 1, created: 1 },
  }).fetchAsync();
  const shared = await db.collections.apiTokens.rawCollection().aggregate([
    { $match: { "owner.user.accountId": accountId, grainId: { $type: "string" },
      "owner.user.denormalizedGrainMetadata": { $exists: true },
      revoked: { $ne: true }, trashed: { $exists: false }, suspended: { $exists: false } } },
    { $sort: { created: 1, _id: 1 } },
    { $group: { _id: "$grainId", owner: { $first: "$owner.user" },
      lastUsed: { $max: { $ifNull: ["$lastUsed", "$created"] } } } },
    // Exclude self-shares before paging, including owned grains in the trash.
    { $lookup: { from: "grains", localField: "_id", foreignField: "_id", as: "grain" } },
    { $match: { "grain.userId": { $ne: accountId } } },
    { $project: { grain: 0 } },
    { $sort: { lastUsed: -1, _id: 1 } },
    { $skip: page * LIMIT },
    { $limit: LIMIT + 1 },
  ]).toArray();
  const packageIds = [...new Set(owned.slice(0, LIMIT).map((grain) => grain.packageId).filter(Boolean))];
  const packages = new Map((await db.collections.packages.find({ _id: { $in: packageIds } },
      { fields: { appId: 1, "manifest.appTitle": 1, "manifest.actions": 1, "manifest.metadata.icons": 1 } }).fetchAsync())
      .map((pkg) => [pkg._id, pkg]));
  const appName = (row, isOwned) => {
    if (!isOwned) return row.owner.denormalizedGrainMetadata?.appTitle?.defaultText || "";
    const pkg = packages.get(row.packageId);
    if (!pkg) return "";
    if (pkg.manifest?.appTitle?.defaultText) return pkg.manifest.appTitle.defaultText;
    return pkg.manifest?.actions?.[0]?.title ? SandstormDb.appNameFromPackage(pkg) : "";
  };
  const staticPrefix = new URL(mainUrl).protocol + "//" + db.makeWildcardHost("static");
  const icon = (row, owned) => {
    const pkg = owned && packages.get(row.packageId);
    const metadata = !owned && row.owner.denormalizedGrainMetadata;
    return pkg ? iconSrcForPackage(pkg, "grain", staticPrefix) : metadata
      ? iconSrcForDenormalizedGrainMetadata(metadata, "grain", staticPrefix) : "";
  };
  const entry = (row, isOwned) => ({ key: row._id,
    appId: isOwned ? row.appId || "" : row.owner.denormalizedGrainMetadata?.appId || "",
    title: text(isOwned ? row.title : computeTitleFromTokenOwnerUser(row.owner).title),
    ownerTitle: text(isOwned ? row.title : row.owner.upstreamTitle || row.owner.title),
    appTitle: Buffer.from(String(appName(row, isOwned))).subarray(0, 160).toString(),
    iconSrc: icon(row, isOwned),
    owned: isOwned, lastUsed: date(row.lastUsed || row.created),
    href: new URL("/grain/" + encodeURIComponent(row._id), mainUrl).href,
  });
  return {
    grains: [...owned.slice(0, LIMIT).map((row) => entry(row, true)),
      ...shared.slice(0, LIMIT).map((row) => entry(row, false))]
      .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed) || a.key.localeCompare(b.key)),
    grainsLimited: owned.length > LIMIT || shared.length > LIMIT,
  };
}

// Filter and sort the combined owned/shared set before paging. Mongo performs
// the query; the browser never has to load the entire account to search it.
async function queryGrains(db,accountId,mainUrl,page,query) {
  const shared = [
    {$match:{'owner.user.accountId':accountId,grainId:{$type:'string'},'owner.user.denormalizedGrainMetadata':{$exists:true},
      revoked:{$ne:true},trashed:{$exists:!!query.trash},suspended:{$exists:false}}},
    {$sort:{created:1,_id:1}},
    {$group:{_id:'$grainId',owner:{$first:'$owner.user'},lastUsed:{$max:{$ifNull:['$lastUsed','$created']}}}},
    {$lookup:{from:'grains',localField:'_id',foreignField:'_id',as:'grain'}},
    {$match:{'grain.userId':{$ne:accountId}}},
    {$project:{owner:1,lastUsed:1,owned:{$literal:false},appId:'$owner.denormalizedGrainMetadata.appId',
      title:{$cond:[{$and:[{$ifNull:['$owner.upstreamTitle',false]},{$not:['$owner.renamed']}]},'$owner.upstreamTitle','$owner.title']},
      appTitle:'$owner.denormalizedGrainMetadata.appTitle.defaultText'}},
  ];
  const pipeline=[
    {$match:{userId:accountId,trashed:{$exists:!!query.trash},suspended:{$exists:false}}},
    {$project:{title:1,packageId:1,appId:1,lastUsed:{$ifNull:['$lastUsed','$created']},owned:{$literal:true}}},
    {$lookup:{from:'packages',localField:'packageId',foreignField:'_id',as:'package'}},
    {$set:{appTitle:{$arrayElemAt:['$package.manifest.appTitle.defaultText',0]}}},
    {$unionWith:{coll:'apiTokens',pipeline:shared}},
  ];
  const match={};
  if(query.ownership!=='all')match.owned=query.ownership==='owned';
  if(query.appId)match.appId=query.appId;
  if(query.search.trim()) {
    const escaped=query.search.trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    match.$or=[{title:{$regex:escaped,$options:'i'}},{appTitle:{$regex:escaped,$options:'i'}}];
  }
  pipeline.push({$match:match},{$sort:query.sort==='title'?{title:1,_id:1}:{lastUsed:-1,_id:1}},{$skip:page*100},{$limit:101});
  const rows=await db.collections.grains.rawCollection().aggregate(pipeline).toArray();
  const staticPrefix=new URL(mainUrl).protocol+'//'+db.makeWildcardHost('static');
  return {grainsLimited:rows.length>100,grains:rows.slice(0,100).map(row=>{
    const pkg=row.package?.[0];const metadata=row.owner?.denormalizedGrainMetadata;
    return {key:row._id,title:text(row.title),ownerTitle:text(row.owned?row.title:row.owner.upstreamTitle||row.owner.title),
      appId:row.appId||'',appTitle:Buffer.from(String(row.appTitle || '')).subarray(0, 160).toString(),owned:row.owned,lastUsed:date(row.lastUsed),
      iconSrc:pkg?iconSrcForPackage(pkg,'grain',staticPrefix):metadata?iconSrcForDenormalizedGrainMetadata(metadata,'grain',staticPrefix):'',
      href:new URL('/grain/'+encodeURIComponent(row._id),mainUrl).href};
  })};
}

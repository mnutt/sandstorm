import { iconSrcForPackage } from "/imports/sandstorm-identicons/helpers";
import { Meteor } from "meteor/meteor";
import { globalDb } from "/imports/db-deprecated";
import { createGrainForUser } from "/imports/server/grain-server";

const text = value => Buffer.from(String(value || "")).subarray(0, 160).toString();
export async function rustAppActions(accountId) {
  const rows = await globalDb.collections.userActions.find({ userId: accountId },
    { sort: { appId: 1, _id: 1 }, limit: 101,
      fields: { title: 1, appTitle: 1, appId: 1, packageId: 1 } }).fetchAsync();
  const actions = rows.slice(0, 100);
  const appIds = [...new Set(actions.map(row => row.appId).filter(Boolean))];
  const packageIds = [...new Set(actions.map(row => row.packageId).filter(Boolean))];
  const [packages, owned, shared] = await Promise.all([
    globalDb.collections.packages.find({ _id: { $in: packageIds } },
      { fields: { appId: 1, "manifest.metadata.icons": 1, "manifest.metadata.shortDescription": 1 } }).fetchAsync(),
    globalDb.collections.grains.rawCollection().aggregate([
      { $match: { userId: accountId, appId: { $in: appIds }, trashed: { $exists: false }, suspended: { $exists: false } } },
      { $group: { _id: "$appId", lastUsed: { $max: "$lastUsed" }, grainCount: { $sum: 1 } } },
    ]).toArray(),
    globalDb.collections.apiTokens.rawCollection().aggregate([
      { $match: { "owner.user.accountId": accountId,
        "owner.user.denormalizedGrainMetadata.appId": { $in: appIds },
        revoked: { $ne: true }, trashed: { $exists: false }, suspended: { $exists: false } } },
      { $lookup: { from: "grains", localField: "grainId", foreignField: "_id", as: "grain" } },
      { $unwind: "$grain" },
      { $match: { "grain.userId": { $ne: accountId }, "grain.trashed": { $exists: false }, "grain.suspended": { $exists: false } } },
      { $group: { _id: "$grainId", appId: { $first: "$grain.appId" }, lastUsed: { $max: "$lastUsed" } } },
      { $group: { _id: "$appId", lastUsed: { $max: "$lastUsed" }, grainCount: { $sum: 1 } } },
    ]).toArray(),
  ]);
  const byPackage = new Map(packages.map(pkg => [pkg._id, pkg]));
  const recent = new Map();
  const counts = new Map();
  for (const row of [...owned, ...shared]) {
    counts.set(row._id, (counts.get(row._id) || 0) + row.grainCount);
    if (row.lastUsed instanceof Date && Number.isFinite(+row.lastUsed)) {
      const date = row.lastUsed.toISOString();
      if (date > (recent.get(row._id) || "")) recent.set(row._id, date);
    }
  }
  const staticPrefix = new URL(process.env.ROOT_URL).protocol + "//" + globalDb.makeWildcardHost("static");
  return { actions: actions.map(row => ({ key: row._id, appId: row.appId || row._id,
    title: text(row.title?.defaultText || "New grain"), appTitle: text(row.appTitle?.defaultText || "Installed app"),
    iconSrc: byPackage.has(row.packageId) ? iconSrcForPackage(byPackage.get(row.packageId), "appGrid", staticPrefix) : "",
    shortDescription: text(byPackage.get(row.packageId)?.manifest?.metadata?.shortDescription?.defaultText),
    grainCount: counts.get(row.appId) || 0,
    lastUsed: recent.get(row.appId) || "" })), limited: rows.length > 100 };
}
export async function createRustGrain(accountId, actionId, title, beforeCreate) {
  const action = await globalDb.collections.userActions.findOneAsync({ _id: actionId, userId: accountId });
  if (!action) throw new Meteor.Error(404, "This app action is no longer installed for your account.");
  return createGrainForUser(accountId, action.packageId, action.command, title, beforeCreate);
}

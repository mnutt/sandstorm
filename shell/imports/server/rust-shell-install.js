import { Meteor } from "meteor/meteor";
import { globalDb as db } from "/imports/db-deprecated";
import { iconSrcForPackage } from "/imports/sandstorm-identicons/helpers";
import { ensureInstalledForUser, newUploadTokenForUser, appInstallPermissions } from "/imports/server/install-server";

const text = (value, limit = 256) => String(value || "").slice(0, limit);
const fail = message => { throw new Meteor.Error(400, message); };
const httpUrl = value => {
  let url;
  try { url = new URL(value); } catch { fail("Invalid package URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || value.length > 2048) fail("Invalid package URL.");
  return url.href;
};

// Only account identity supplied by the authenticated bridge is used for writes.
// Package parsing, signature verification and downloads remain with the installer.
export async function rustInstall(accountId, operation, input, beforeWrite) {
  const permissions = await appInstallPermissions(db, await Meteor.users.findOneAsync(accountId));
  if (operation === "catalog") {
    const market = await db.collections.settings.findOneAsync("appMarketUrl");
    const index = await db.collections.settings.findOneAsync("appIndexUrl");
    const installed = await db.collections.userActions.find({userId:accountId}, {limit:101,fields:{appId:1,appVersion:1}}).fetchAsync();
    const versions = new Map();
    for (const row of installed) versions.set(row.appId, Math.max(versions.get(row.appId) ?? -1, row.appVersion));
    const rows = await db.collections.appIndex.find({_id:{$in:[...versions.keys()]}}, {limit:100}).fetchAsync();
    return {permissions, marketUrl:httpUrl(market?.value || "https://apps.sandstorm.io"), updates:rows.filter(row => row.versionNumber > versions.get(row._id)).map(row => ({
      packageId:row.packageId, title:text(row.name), version:text(row.version),
      url:httpUrl((index?.value || "https://app-index.sandstorm.io") + "/packages/" + row.packageId),
    }))};
  }
  if (operation === "upload") {
    const token = await newUploadTokenForUser(db, accountId, beforeWrite);
    return {uploadUrl:new URL("/upload/" + token, process.env.ROOT_URL).href};
  }
  const id = input.packageId;
  if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) fail("Invalid package ID.");
  if (operation === "download" || operation === "retry") {
    const url = input.url ? httpUrl(input.url) : null;
    await ensureInstalledForUser(db, accountId, id, url, operation === "retry", beforeWrite);
  }
  let pkg = await db.collections.packages.findOneAsync(id);
  if (operation === "confirm" || operation === "upgrade") {
    const user = await Meteor.users.findOneAsync(accountId);
    if (!user?.loginCredentials || !await db.isAccountSignedUpOrDemoAsync(user)) throw new Meteor.Error(403,"Your account needs an invitation before you can install apps. Ask the server administrator to grant you access.");
    if (pkg?.status !== "ready") fail("The package is not ready to install.");
    const actions = await db.collections.userActions.find({userId:accountId,appId:pkg.appId}).fetchAsync();
    if (actions.some(action => action.appVersion > pkg.manifest.appVersion)) fail("A newer app version is already installed.");
    if (operation === "confirm") {
      await beforeWrite();
      await db.addUserActions(accountId, id);
    } else {
      if (!actions.some(action => action.packageId === id)) fail("Install this version before upgrading grains.");
      await db.upgradeGrains(pkg.appId, pkg.manifest.appVersion, id, globalThis.globalBackend, accountId, beforeWrite);
    }
    pkg = await db.collections.packages.findOneAsync(id);
  }
  if (!pkg) return {permissions,packageId:id,status:"missing"};
  const manifest = pkg.manifest;
  const actions = pkg.appId ? await db.collections.userActions.find({userId:accountId,appId:pkg.appId}, {fields:{packageId:1,appVersion:1}}).fetchAsync() : [];
  const olderGrains = manifest ? await db.collections.grains.find({userId:accountId,appId:pkg.appId,appVersion:{$lte:manifest.appVersion},packageId:{$ne:id}}).countAsync() : 0;
  const staticPrefix = new URL(process.env.ROOT_URL).protocol + "//" + db.makeWildcardHost("static");
  return {permissions,packageId:id,status:pkg.status,progress:Number(pkg.progress) || 0,error:text(pkg.error,1024),
    appId:pkg.appId || "",title:text(manifest?.appTitle?.defaultText),description:text(manifest?.metadata?.shortDescription?.defaultText),
    version:text(manifest?.appMarketingVersion?.defaultText), fingerprint:text(pkg.authorPgpKeyFingerprint),
    iconSrc:manifest ? iconSrcForPackage(pkg,"appGrid",staticPrefix) : "",
    installed:actions.some(row => row.packageId === id), newerInstalled:actions.some(row => row.appVersion > manifest?.appVersion), olderGrains};
}

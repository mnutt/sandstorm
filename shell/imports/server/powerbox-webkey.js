import { Meteor } from "meteor/meteor";
import { Match, check } from "meteor/check";
import Capnp from "/imports/server/capnp";

const SystemPersistent = Capnp.importSystem("sandstorm/supervisor.capnp").SystemPersistent;

// Exchange a user-supplied local webkey for a temporary token owned by the
// requesting session. Never fetch the supplied URL or accept a caller-chosen
// receiving grain. Both shells use the same restore/save authority checks.
export async function redeemPowerboxWebkey(db, accountId, sessionId, webkeyUrl, beforeSave = async () => {}) {
  check(sessionId, String);
  check(webkeyUrl, String);
  if (!accountId) throw new Meteor.Error(403, "Not logged in.");
  if (webkeyUrl.length > 16384) throw new Meteor.Error(400, "Capability link is too long.");
  const session = await db.collections.sessions.findOneAsync({_id:sessionId,userId:accountId});
  if (!session || session.denied) throw new Meteor.Error(403, "Invalid requesting session.");
  let url;
  try { url = new URL(webkeyUrl.trim()); } catch { throw new Meteor.Error(400, "Paste a complete API capability link, including its #token."); }
  if (!["https:","http:"].includes(url.protocol) || url.username || url.password) {
    throw new Meteor.Error(400, "Use an HTTP or HTTPS capability link without embedded credentials.");
  }
  const hostId = db.matchWildcardHost(url.host);
  if (!hostId || !db.isApiHostId(hostId)) {
    throw new Meteor.Error(400, "Use an API capability link from this Sandstorm server. External links and grain sharing links are not supported here.");
  }
  const token = url.hash.slice(1);
  if (!token) throw new Meteor.Error(400, "The capability link must include its #token.");
  if (db.isTokenSpecificHostId(hostId) && hostId !== db.apiHostIdForToken(token)) {
    throw new Meteor.Error(400, "The capability token does not match the link's hostname.");
  }
  await beforeSave();
  const {cap} = await globalThis.restoreInternal(db, token,
    Match.Optional({webkey:Match.Optional(Match.Any)}), []);
  let persistent;
  try {
    persistent = cap.castAs(SystemPersistent);
    await beforeSave();
    const result = await persistent.save({clientPowerboxRequest:{grainId:session.grainId,sessionId}});
    return result.sturdyRef.toString();
  } finally {
    if (persistent && persistent !== cap) persistent.close();
    cap.close();
  }
}

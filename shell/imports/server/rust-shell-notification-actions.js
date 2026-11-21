import { rustUserPicture } from "/imports/server/rust-shell-users";
import { Meteor } from "meteor/meteor";
import { globalDb as db } from "/imports/db-deprecated";
import { checkAuthAsync } from "/imports/server/auth";
import { nativeNotificationAction } from "./rust-shell-notification-targets.mjs";

// The notification ID is only a lookup key. Ownership, notice type and current
// administrator authority are independently checked for every operation.
export async function rustNotificationAction(accountId, key, operation, enabled, beforeWrite) {
  const notice = await db.collections.notifications.findOneAsync({_id:key,userId:accountId});
  if (!notice) throw new Meteor.Error(404,"Notification no longer available.");
  const kind = nativeNotificationAction(notice);
  if (operation === "setStats" && kind !== "stats") throw new Meteor.Error(400,"This notification cannot change reporting preferences.");
  if (kind === "stats") {
    await checkAuthAsync(db,accountId,undefined);
    if (operation === "setStats") {
      if (typeof enabled !== "boolean") throw new Meteor.Error(400,"Choose whether to share statistics.");
      await beforeWrite();
      await checkAuthAsync(db,accountId,undefined);
      // These are the same setting and notice cleanup used by the admin UI.
      await db.collections.settings.upsertAsync({_id:"reportStats"},{$set:{value:enabled}});
      await db.collections.notifications.removeAsync({"admin.type":"reportStats"});
    }
    const preference = await db.collections.settings.findOneAsync("reportStats");
    const latest = await db.collections.activityStats.findOneAsync({}, {sort:{timestamp:-1},fields:{_id:0}});
    const serialized = latest ? JSON.stringify(latest,null,2) : "";
    await checkAuthAsync(db,accountId,undefined);
    return {kind,enabled:typeof preference?.value === "boolean" ? preference.value : null,
      sample:serialized};
  }
  if (kind === "referrals") {
    const user = await Meteor.users.findOneAsync(accountId,{fields:{referredAccountIds:1}});
    const ids = [...new Set(user?.referredAccountIds || [])];
    const [pending,completed] = await Promise.all([
      Meteor.users.find({referredBy:accountId,referredByComplete:{$exists:false},type:"account","profile.name":{$exists:true}},
        {fields:{profile:1},sort:{"profile.name":1,_id:1}}).fetchAsync(),
      Meteor.users.find({_id:{$in:ids}},{fields:{profile:1},sort:{"profile.name":1,_id:1}}).fetchAsync(),
    ]);
    const person = row => ({name:String(row.profile?.name || "Unnamed account"),pictureUrl:rustUserPicture(row)});
    return {kind,enabled:!!db.isReferralEnabled(),pending:pending.map(person),completed:completed.map(person)};
  }
  if (kind === "identity") return {kind};
  throw new Meteor.Error(400,"This notification has no native action.");
}

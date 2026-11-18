import { Meteor } from "meteor/meteor";
import { globalDb } from "/imports/db-deprecated";
import { createGrainForUser } from "/imports/server/grain-server";

const text = value => Buffer.from(String(value || "")).subarray(0, 160).toString();
export async function rustAppActions(accountId) {
  const rows = await globalDb.collections.userActions.find({ userId: accountId },
    { sort: { appId: 1, _id: 1 }, limit: 101, fields: { title: 1, appTitle: 1 } }).fetchAsync();
  return { actions: rows.slice(0, 100).map(row => ({ key: row._id,
    title: text(row.title?.defaultText || "New grain"), appTitle: text(row.appTitle?.defaultText || "Installed app") })),
    limited: rows.length > 100 };
}
export async function createRustGrain(accountId, actionId, title, beforeCreate) {
  const action = await globalDb.collections.userActions.findOneAsync({ _id: actionId, userId: accountId });
  if (!action) throw new Meteor.Error(404, "This app action is no longer installed for your account.");
  return createGrainForUser(accountId, action.packageId, action.command, title, beforeCreate);
}

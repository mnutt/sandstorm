import { rustUserPicture } from "/imports/server/rust-shell-users";
import { Meteor } from "meteor/meteor";
import { check, Match } from "meteor/check";
import { SandstormPermissions, updateApiTokenForAccount } from "/imports/sandstorm-permissions/permissions";
import { rustGrainPowerboxContext } from "/imports/server/gateway-router";

const text = (value, fallback = "") => (typeof value === "string" ? value : typeof value?.defaultText === "string" ? value.defaultText : fallback).slice(0, 160);
const sharingLink = row => row.forSharing && (!row.owner || Object.prototype.hasOwnProperty.call(row.owner, "webkey"));
const visible = row => !row.objectId && (sharingLink(row) || row.owner?.user || row.owner?.grain);
const editable = (row, accountId) => row.accountId === accountId && !row.parentToken &&
  !row.objectId && (sharingLink(row) || !!row.owner?.user);

async function context(db, handle) {
  const { grainId } = await rustGrainPowerboxContext(db, handle.accountId, handle.sessionId);
  if (grainId !== handle.grainId) throw new Meteor.Error(403, "Wrong grain session.");
  return db.collections.grains.findOneAsync(grainId);
}
function roleAssignment(grain, role) {
  if (role === "all") return { allAccess: null };
  if (role === "none") return { none: null };
  const roles = grain.cachedViewInfo?.roles || [];
  if (typeof role !== "string" || !/^(0|[1-9][0-9]{0,2})$/.test(role) || Number(role) >= Math.min(roles.length, 64)) {
    throw new Meteor.Error(400, "Unknown permission role.");
  }
  return { roleId: Number(role) };
}
function roleKey(row) {
  const assignment = row.roleAssignment || { none: null };
  if (assignment.addPermissions || assignment.removePermissions) return "custom";
  if (Object.prototype.hasOwnProperty.call(assignment, "none")) return "none";
  if (Object.prototype.hasOwnProperty.call(assignment, "allAccess")) return "all";
  if (Number.isInteger(assignment.roleId)) return assignment.roleId >= 0 && assignment.roleId < 64 ? String(assignment.roleId) : "custom";
  return "custom";
}

export async function rustSharingState(db, handle) {
  const grain = await context(db, handle);
  const roles = (grain.cachedViewInfo?.roles || []).slice(0, 64).map((role, index) => ({
    key: String(index), title: text(role.title, "Role " + (index + 1)), description: text(role.description),
  }));
  const defaultRole = (grain.cachedViewInfo?.roles || []).findIndex(role => role.default);
  // Match legacy graph visibility. Project explicitly; never return token secrets,
  // requirements, identity metadata, or unrelated application capabilities.
  const downstream = await SandstormPermissions.downstreamTokens(db, { grain: { _id: handle.grainId, accountId: handle.accountId } });
  const own = await db.collections.apiTokens.find({ grainId: handle.grainId, accountId: handle.accountId,
    revoked: { $ne: true }, suspended: { $ne: true }, forSharing: true, "owner.webkey": null,
  }, { limit: 101, sort: { created: -1 } }).fetchAsync();
  const rows = [...new Map([...own, ...downstream].filter(visible).map(row => [row._id, row])).values()];
  const grants = await Promise.all(rows.slice(0, 100).map(async row => {
    const recipient = row.owner?.user?.accountId;
    const user = recipient && await db.collections.users.findOneAsync(recipient, { fields: { profile: 1 } });
    return { id: row._id, recipientPictureUrl: rustUserPicture(user), label: text(row.petname, "Unlabeled link"), role: roleKey(row),
      kind: sharingLink(row) ? "link" : recipient ? "person" : "grain",
      recipient: recipient ? text(user?.profile?.name, "Unknown user") : row.owner?.grain ? "Connected grain" : "Anyone with the link",
      editable: editable(row, handle.accountId), inherited: !!row.parentToken,
      created: row.created instanceof Date ? row.created.toISOString() : "",
    };
  }));
  return { roles, defaultRole: defaultRole >= 0 && defaultRole < 64 ? String(defaultRole) : "none",
    grants, limited: rows.length > 100, owner: grain.userId === handle.accountId,
    private: !!grain.private };
}

export async function createRustShare(db, handle, input, beforeWrite) {
  check(input.label, String);
  if (input.label.length > 160) throw new Meteor.Error(400, "Link label is too long.");
  const grain = await context(db, handle);
  const role = roleAssignment(grain, input.role);
  await beforeWrite();
  return SandstormPermissions.createNewApiToken(db, { accountId: handle.accountId },
    handle.grainId, input.label.trim(), role, { webkey: { forSharing: true } });
}

export async function updateRustShare(db, handle, input, beforeWrite) {
  check(input.id, String);
  check(input.changes, { label: Match.Optional(String), role: Match.Optional(String), revoked: Match.Optional(Boolean) });
  if (input.id.length > 128 || input.changes.label?.length > 160 || input.changes.revoked === false) throw new Meteor.Error(400, "Invalid sharing update.");
  const grain = await context(db, handle);
  const row = await db.collections.apiTokens.findOneAsync({ _id: input.id, grainId: handle.grainId });
  if (!row || !editable(row, handle.accountId) || row.revoked || row.suspended) throw new Meteor.Error(403, "This grant cannot be changed by this account.");
  const fields = {};
  if (input.changes.label !== undefined) fields.petname = input.changes.label.trim();
  if (input.changes.role !== undefined) fields.roleAssignment = roleAssignment(grain, input.changes.role);
  if (input.changes.revoked) fields.revoked = true;
  await updateApiTokenForAccount(db, handle.accountId, input.id, fields, beforeWrite);
  return {};
}

import { updateProfileForUser } from "/imports/server/accounts/accounts-ui-methods";
import { Meteor } from "meteor/meteor";
import { Mongo } from "meteor/mongo";
import { Accounts } from "meteor/accounts-base";
import { check } from "meteor/check";
import Http from "node:http";
import Fs from "node:fs/promises";
import { computeTitleFromTokenOwnerUser } from "/imports/shared/grain-title";
import { inspectRustSharedGrain, createRustSharedGrainSession, keepRustSharedGrainSession, closeRustSharedGrainSession, createRustTemplateToken, rustGrainPowerboxContext, createRustGrainSession, keepRustGrainSession, closeRustGrainSession } from "/imports/server/gateway-router";
import { grainMenu, rustGrainTitles } from "/imports/server/rust-shell-grains";
import { rustAppActions, createRustGrain } from "/imports/server/rust-shell-apps";
import { renameGrainForUser } from "/imports/server/grain-server";
import { globalDb } from "/imports/db-deprecated";
import { dismissNotificationForUser, readNotificationsForUser } from "/imports/server/core";
import { createRustShellBridge, bridgeHandler } from "./rust-shell-bridge-core.mjs";

import { mongoSessionStore } from "./rust-shell-session-store.mjs";

// Server-only collection: no publication and no client write methods.
const linkedSessions = new Mongo.Collection("rustShellLinkedSessions");
export const rustShellSessionStore = mongoSessionStore(linkedSessions);
const text = (value, bytes) => Buffer.from(String(value || "")).subarray(0, bytes).toString();

export async function authorizeRustShellAccount(accountId, loginHash) {
  const user = await Meteor.users.findOneAsync({
    _id: accountId, suspended: { $exists: false },
    "services.resume.loginTokens.hashedToken": loginHash,
  });
  if (!user || !user.loginCredentials) return null;
  const token = user.services.resume.loginTokens.find((item) => item.hashedToken === loginHash);
  if (!token?.when) return null;
  const expires = Math.min(+Accounts._tokenExpiration(token.when), user.expires ? +user.expires : Infinity);
  return { name: text(user.profile?.name || "Sandstorm account", 160), expires };
}

async function accountProfile(accountId) {
  const user = await Meteor.users.findOneAsync(accountId, { fields: { profile: 1 } });
  if (!user) throw new Meteor.Error(403, "Account unavailable");
  return { name: user.profile?.name || "", handle: user.profile?.handle || "",
    pronoun: user.profile?.pronoun || "neutral",
    mainHref: new URL("/account", process.env.ROOT_URL).href };
}

export const rustShellBridge = createRustShellBridge({
  getProfile: accountProfile,
  updateProfile: updateProfileForUser,
  listApps: rustAppActions,
  createGrain: createRustGrain,
  sessionStore: rustShellSessionStore,
  shared: {
    inspect: webkey => inspectRustSharedGrain(globalDb,webkey),
    async open(webkey, accountId) {
      const origin = Meteor.settings.public.rustShellOrigin;
      if (!origin) throw new Meteor.Error(503,"Rust shell is not enabled.");
      const session = await createRustSharedGrainSession(globalDb,webkey,accountId,origin);
      const frameOrigin = new URL(process.env.ROOT_URL).protocol + "//" + globalDb.makeWildcardHost("ui-" + session.hostId);
      return {handle:{sessionId:session._id,hashedToken:session.hashedToken,accountId:accountId || undefined},
        view:{grainId:session.grainId, iconSrc:session.iconSrc, title:text(session.sharersTitle,256), ownerTitle:text(session.sharersTitle,256),
          origin:frameOrigin,url:frameOrigin+"/_sandstorm-init?sessionid="+session._id+"&path=%2F",
          mainHref:new URL("/shared/"+encodeURIComponent(webkey),process.env.ROOT_URL).href}};
    },
    keep: handle => keepRustSharedGrainSession(globalDb,handle),
    close: handle => closeRustSharedGrainSession(globalDb, handle),
  },
  grains: {
    async open(accountId, grainId) {
      const parentOrigin = Meteor.settings.public.rustShellOrigin;
      if (!parentOrigin) throw new Meteor.Error(503, "Rust grain sessions are not enabled.");
      const titles = await rustGrainTitles(globalDb, accountId, grainId);
      const title = text(titles.title, 256);
      const ownerTitle = text(titles.ownerTitle, 256);
      const session = await createRustGrainSession(globalDb, accountId, grainId, parentOrigin);
      const origin = new URL(process.env.ROOT_URL).protocol + "//" + globalDb.makeWildcardHost("ui-" + session.hostId);
      return { handle: { sessionId: session._id, accountId, grainId },
        view: { grainId, origin, title, ownerTitle, iconSrc: titles.iconSrc, mainHref: new URL("/grain/" + encodeURIComponent(grainId), process.env.ROOT_URL).href, url: origin + "/_sandstorm-init?sessionid=" + session._id + "&path=%2F" } };
    },
    keep: (handle) => keepRustGrainSession(globalDb, handle),
    close: (handle) => closeRustGrainSession(globalDb, handle),
    template: (handle, options) => createRustTemplateToken(globalDb, handle, options),
    async rename(handle, title, beforeWrite) {
      await renameGrainForUser(handle.accountId, handle.grainId, title, beforeWrite);
      const titles = await rustGrainTitles(globalDb, handle.accountId, handle.grainId);
      return { title: text(titles.title, 256), ownerTitle: text(titles.ownerTitle, 256) };
    },
    revokeTemplate: result => globalDb.removeApiTokens({ _id: result.id }),
  },
  authorize: authorizeRustShellAccount,
  async snapshot(accountId) {
    const query = { userId: accountId };
    const rows = await globalDb.collections.notifications.find(query,
        { sort: { timestamp: -1, _id: 1 }, limit: 100 }).fetchAsync();
    const entries = await Promise.all(rows.map(async (row) => {
      let title = "Notification";
      let body = row.text?.defaultText || "";
      let path = "/";
      let senderName = "";
      // Match notificationGrains: only a sender referenced by this account's
      // own notification may contribute profile information.
      if (row.initiatingAccount) {
        const sender = await Meteor.users.findOneAsync({ _id: row.initiatingAccount },
            { fields: { "profile.name": 1 } });
        senderName = sender?.profile?.name || "";
      } else if (row.initiatorAnonymous) {
        senderName = "Anonymous user";
      }
      if (row.grainId) {
        const grain = await globalDb.collections.grains.findOneAsync({ _id: row.grainId, userId: accountId });
        let sharedTitle;
        if (!grain) {
          const token = await globalDb.collections.apiTokens.findOneAsync({
            grainId: row.grainId,
            "owner.user.accountId": accountId,
            "owner.user.denormalizedGrainMetadata": { $exists: true },
            revoked: { $ne: true },
          }, { sort: { created: 1, _id: 1 }, fields: { "owner.user": 1 } });
          if (token) sharedTitle = computeTitleFromTokenOwnerUser(token.owner.user).title;
        }
        title = grain?.title || sharedTitle || "Grain activity";
        path = "/grain/" + encodeURIComponent(row.grainId);
        if (row.path) path += "/" + row.path.replace(/^\/+/, "");
        if (row.ongoing && !body) body = "This grain has an ongoing activity.";
        if (row.count > 1) body += " (" + row.count + " events)";
      } else if (row.appUpdates) {
        title = "App updates available";
        body = Object.values(row.appUpdates).map((app) => app.name || app.appTitle?.defaultText || "App update").join(", ");
        path = "/apps";
      } else if (row.admin) {
        title = "Administration";
        body = row.admin.type === "reportStats" ? "Choose whether to share anonymous usage statistics." : "An administrative action needs your attention.";
        path = row.admin.action || "/admin";
      } else if (row.referral) {
        title = "Referral update"; body = "View your referral activity in the main shell."; path = "/referrals";
      } else if (row.identityChanges) {
        title = "Account identities have changed"; body = "Sandstorm updated how credentials link to your account.";
      } else if (row.mailingListBonus) {
        title = "Mailing list invitation"; body = "View the invitation in the main shell.";
      }
      const main = new URL(process.env.ROOT_URL);
      const target = new URL(path, main);
      const href = target.origin === main.origin && Buffer.byteLength(target.href) <= 1024 ? target.href : main.origin;
      return { key: row._id, senderName: text(senderName, 160), title: text(title, 160), body: text(body, 512), href,
        unread: !!row.isUnread, ongoing: !!row.ongoing, timestamp: row.timestamp?.toISOString() || "" };
    }));
    return { entries, total: await globalDb.collections.notifications.find(query).countAsync(),
      ...await grainMenu(globalDb, accountId, process.env.ROOT_URL) };
  },
  async observe(accountId, changed) {
    const handles = [];
    const stop = async () => { await Promise.all(handles.map((handle) => handle.stop())); };
    try {
      const callbacks = { added: changed, changed, removed: changed };
      handles.push(await globalDb.collections.notifications.find({ userId: accountId })
          .observeChangesAsync(callbacks));
      handles.push(await globalDb.collections.grains.find({ userId: accountId }, { fields: { title: 1, packageId: 1, lastUsed: 1, created: 1, trashed: 1, suspended: 1 } })
          .observeChangesAsync(callbacks));
      handles.push(await globalDb.collections.apiTokens.find({ "owner.user.accountId": accountId },
          { fields: { grainId: 1, "owner.user": 1, created: 1, lastUsed: 1, revoked: 1, trashed: 1, suspended: 1 } })
          .observeChangesAsync(callbacks));
      const owned = await globalDb.collections.grains.find({ userId: accountId,
        trashed: { $exists: false }, suspended: { $exists: false } }, {
        sort: { lastUsed: -1, _id: 1 }, limit: 50, fields: { packageId: 1 },
      }).fetchAsync();
      const packageIds = [...new Set(owned.map((grain) => grain.packageId).filter(Boolean))];
      if (packageIds.length) {
        handles.push(await globalDb.collections.packages.find({ _id: { $in: packageIds } },
            { fields: { "manifest.appTitle": 1, "manifest.actions": 1, "manifest.metadata.icons": 1 } }).observeChangesAsync(callbacks));
      }
      // Notification observation is already active. A new referenced sender
      // changes the snapshot, causing the next watch to attach its profile observer.
      const notifications = await globalDb.collections.notifications.find({ userId: accountId },
          { sort: { timestamp: -1, _id: 1 }, limit: 100, fields: { initiatingAccount: 1 } }).fetchAsync();
      const senders = [...new Set(notifications.map((row) => row.initiatingAccount).filter(Boolean))];
      if (senders.length) {
        handles.push(await Meteor.users.find({ _id: { $in: senders } }, { fields: { "profile.name": 1 } })
            .observeChangesAsync(callbacks));
      }
      // Invalidate promptly on source-login revocation, suspension, or account deletion.
      handles.push(await Meteor.users.find({ _id: accountId },
          { fields: { "services.resume.loginTokens": 1, suspended: 1, expires: 1 } })
          .observeChangesAsync(callbacks));
      return stop;
    } catch (error) { await stop(); throw error; }
  },
  dismiss: (userId, id) => dismissNotificationForUser(globalDb, userId, id),
  markRead: (userId) => readNotificationsForUser(globalDb, userId),
});

Meteor.methods({
  async rustShellSharingContext(sessionId, mode, shareData) {
    check(sessionId, String);
    if (sessionId.length > 128 || !["share", "access"].includes(mode) ||
        !shareData || typeof shareData !== "object" || Array.isArray(shareData) ||
        Object.keys(shareData).some(key => !["pathname", "hash"].includes(key)) ||
        Object.values(shareData).some(value => typeof value !== "string" || value.length > 2048 || /[\x00-\x1f\x7f\\]/.test(value)) ||
        (shareData.pathname && (shareData.pathname.startsWith("//") || /(^|\/)(\.|%2e){2}(\/|$)/i.test(shareData.pathname)))) {
      throw new Meteor.Error(400, "Invalid sharing request.");
    }
    if (!Meteor.settings.public.rustShellOrigin) throw new Meteor.Error(503, "The Rust shell is not enabled.");
    return rustGrainPowerboxContext(globalDb, this.userId, sessionId);
  },
  async rustShellPowerboxContext(sessionId, request) {
    check(sessionId, String);
    if (sessionId.length > 128 || !request || typeof request !== "object" || Array.isArray(request) ||
        !["string", "number"].includes(typeof request.rpcId) ||
        (request.query !== undefined && (!Array.isArray(request.query) || request.query.length > 32 ||
          request.query.some(q => typeof q !== "string" || q.length > 8192))) ||
        (request.saveLabel !== undefined && (!request.saveLabel ||
          typeof request.saveLabel.defaultText !== "string")) || JSON.stringify(request).length > 65536) {
      throw new Meteor.Error(400, "Invalid Powerbox request.");
    }
    if (!Meteor.settings.public.rustShellOrigin) throw new Meteor.Error(503, "The Rust shell is not enabled.");
    return rustGrainPowerboxContext(globalDb, this.userId, sessionId);
  },
  async createRustShellGrant(state) {
    check(state, String);
    if (!process.env.RUST_SHELL_BRIDGE_SOCKET || !Meteor.settings.public.rustShellOrigin) {
      throw new Meteor.Error(503, "The Rust shell is not enabled.");
    }
    const hash = Accounts._getLoginToken(this.connection.id);
    try { return await rustShellBridge.issue(this.userId, hash, state); }
    catch (error) { throw new Meteor.Error(error.status || 500, error.message); }
  },
});

Meteor.startup(async () => {
  const socket = process.env.RUST_SHELL_BRIDGE_SOCKET;
  if (!socket) return;
  // Linked logins survive; process-owned UI leases do not. Reconnect never
  // silently reopens a grain or replays a Powerbox operation.
  await linkedSessions.rawCollection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await rustShellBridge.pruneSessions();
  await globalDb.collections.sessions.removeAsync({ rustShellSession: true });
  Meteor.setInterval(() => (async () => {
    await rustShellBridge.pruneSessions();
    await rustShellBridge.sweepGrains();
    await globalDb.collections.sessions.removeAsync({ rustShellSession: true,
      rustShellLeaseExpires: { $lt: Date.now() } });
  })().catch((error) => {
    console.error("Rust grain session cleanup failed:", error.code || error.error || "unknown");
  }), 5000);
  // The process supervisor removes stale sockets before launching Meteor.
  const server = Http.createServer(Meteor.bindEnvironment(bridgeHandler(rustShellBridge)));
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 64;
  server.on("error", (error) => { console.error("Rust shell bridge listener failed:", error.code); });
  server.listen(socket, () => {
    Fs.chmod(socket, 0o600).catch((error) => {
      console.error("Rust shell bridge socket permissions failed:", error.code);
      server.close();
    });
  });
});

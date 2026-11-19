import { redeemPowerboxWebkey } from "/imports/server/powerbox-webkey";
import Crypto from "crypto";
import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";
import { globalFrontendRefRegistry } from "/imports/server/frontend-ref";
import { queryPowerboxOptions, newPowerboxFrontendRef, fulfillPowerboxUiView } from "/imports/sandstorm-ui-powerbox/powerbox-server";
import { rustGrainPowerboxContext, createRustGrainSession, keepRustGrainSession, closeRustGrainSession } from "/imports/server/gateway-router";
import { rustGrainTitles } from "/imports/server/rust-shell-grains";

const text = value => (typeof value === "string" ? value : value?.defaultText || "").slice(0, 160);
const fail = message => { throw new Meteor.Error(400, message); };
const simpleTitles = {
  ipInterfacePowerboxCard: "Accept incoming network connections",
  ipNetworkPowerboxCard: "Connect to the network",
  emailVerifierPowerboxCard: "Verify email addresses",
};

// Private per-request state. The client chooses only keys from this server-held
// candidate set, never a provider session ID or an arbitrary frontendRef object.
export function rustPowerbox(db) {
  async function validate(handle) {
    return rustGrainPowerboxContext(db, handle.accountId, handle.sessionId);
  }
  async function removeResult(result) {
    if (result?.token) await db.removeApiTokens({_id: Crypto.createHash("sha256").update(result.token).digest("base64")});
  }
  async function providerResult(request) {
    if (!request.provider) return;
    const row = await db.collections.sessions.findOneAsync({_id:request.provider.sessionId, userId:request.parent.accountId});
    return row?.powerboxView?.fulfill;
  }
  return {
    async open(parent, input, beforeWrite) {
      check(input.query, [String]);
      if (input.query.length > 32 || input.query.some(q => q.length > 8192) || JSON.stringify(input.query).length > 60000) fail("Powerbox query too large.");
      await validate(parent);
      const options = await queryPowerboxOptions(db, globalFrontendRefRegistry, parent.accountId, input.query);
      const request = {parent, query:input.query, options:new Map(), provider:null, result:null, delivered:false};
      const candidates = [];
      let legacy = false;
      let bytes = 0;
      let limited = options.length > 64;
      for (const option of options.slice(0, 128)) {
        if (candidates.length >= 64) break;
        let candidate;
        if (option.grainId) {
          try {
            const titles = await rustGrainTitles(db, parent.accountId, option.grainId);
            const grain = await db.collections.grains.findOneAsync(option.grainId);
            if (!grain || grain.trashed || grain.suspended) continue;
            const roles = (grain.cachedViewInfo?.roles || []).slice(0, 32).map((role, index) => ({key:String(index),title:text(role.title)}));
            candidate = {title:text(titles.title),iconSrc:titles.iconSrc,uiView:!!option.uiView,hostedObject:!!option.hostedObject,roles};
          } catch { continue; }
        } else if (option.cardTemplate === "httpArbitraryPowerboxCard") {
          candidate = {title:"Connect to a URL",urlInput:true};
        } else if (option.frontendRef && !option.configureTemplate) {
          const title = simpleTitles[option.cardTemplate] || option.frontendRef.verifiedEmail?.address || option.frontendRef.http?.url;
          if (!title) { legacy = true; continue; }
          candidate = {title:text(title),detail: option.frontendRef.emailVerifier?.services?.join(", ") || ""};
        } else { legacy = true; continue; }
        const key = String(candidates.length);
        bytes += Buffer.byteLength(JSON.stringify(candidate)) + 32;
        if (bytes > 160000) { limited = true; break; }
        request.options.set(key, option);
        candidates.push({...candidate,key});
      }
      await beforeWrite();
      return {handle:request,view:{status:"choices",candidates,legacy,limited}};
    },
    async select(request, input, beforeWrite) {
      if (request.provider || request.result) fail("This request already has a selection.");
      if (input.mode === "webkey") {
        await validate(request.parent);
        const token = await redeemPowerboxWebkey(db, request.parent.accountId, request.parent.sessionId, input.url, beforeWrite);
        request.result = {token};
        return {status:"complete",token};
      }
      const option = request.options.get(input.key);
      if (!option) fail("Unknown Powerbox option.");
      await validate(request.parent);
      await beforeWrite();
      if (option.grainId) {
        // Revalidate the provider separately from the requesting grain.
        const origin = Meteor.settings.public.rustShellOrigin;
        if (!origin) fail("Rust shell origin is unavailable.");
        const provider = await createRustGrainSession(db, request.parent.accountId, option.grainId, origin,
          input.mode === "hosted" && option.hostedObject ? {descriptors:request.query,requestingSession:request.parent.sessionId} : undefined);
        request.provider = {sessionId:provider._id, accountId:request.parent.accountId, grainId:option.grainId};
        await beforeWrite();
        if (input.mode === "hosted" && option.hostedObject) {
          const frameOrigin = new URL(process.env.ROOT_URL).protocol + "//" + db.makeWildcardHost("ui-" + provider.hostId);
          return {status:"provider",title:text(await db.userGrainTitle(option.grainId, request.parent.accountId)),
            origin:frameOrigin,url:frameOrigin+"/_sandstorm-init?sessionid="+provider._id+"&path=%2F"};
        }
        if (input.mode !== "view" || !option.uiView) fail("This grain cannot fulfill that request type.");
        const grain = await db.collections.grains.findOneAsync(option.grainId);
        let role;
        if (input.role === "all") role = {allAccess:null};
        else if (typeof input.role === "string" && /^(0|[1-9][0-9]?)$/.test(input.role) && Number(input.role) < Math.min(32, grain.cachedViewInfo?.roles?.length || 0)) role = {roleId:Number(input.role)};
        else fail("Choose a valid permission role.");
        await keepRustGrainSession(db, request.provider);
        await beforeWrite();
        const result = await fulfillPowerboxUiView(db, request.parent.accountId, request.parent.sessionId,
          option.grainId, "selected via Powerbox", role, request.parent.grainId);
        request.result = {token:result.sturdyRef,descriptor:result.descriptor};
      } else {
        let ref = option.frontendRef;
        if (option.cardTemplate === "httpArbitraryPowerboxCard") {
          if (typeof input.url !== "string" || input.url.length > 2048) fail("Invalid URL.");
          const url = new URL(input.url);
          if (!["http:","https:"].includes(url.protocol) || url.username || url.password) fail("Use an HTTP or HTTPS URL without embedded credentials.");
          ref = {http:{url:url.href,auth:{none:null}}};
        }
        await beforeWrite();
        const result = await newPowerboxFrontendRef(db, globalFrontendRefRegistry, request.parent.accountId, request.parent.sessionId, structuredClone(ref));
        request.result = {token:result.sturdyRef,descriptor:result.descriptor};
      }
      return {status:"complete",...request.result};
    },
    async poll(request) {
      await validate(request.parent);
      if (!request.provider) fail("No provider is open.");
      await keepRustGrainSession(db, request.provider);
      request.result = await providerResult(request);
      return request.result ? {status:"complete",...request.result} : {status:"waiting"};
    },
    async close(request) {
      // Undelivered provider results must not survive cancellation. The requesting
      // session owns delivered tokens, which the existing gateway redeems/cleans up.
      if (request.provider) await db.collections.sessions.updateAsync({_id:request.provider.sessionId}, {$set:{rustPowerboxClosing:true}});
      const result = request.result || await providerResult(request);
      if (request.provider) await closeRustGrainSession(db, request.provider);
      if (!request.delivered) await removeResult(result);
    },
  };
}

import { OAuth } from "meteor/oauth";
import { oauthProvider, oauthEnabled, startOAuth, finishOAuth, cancelOAuth } from "/imports/server/rust-shell-oauth";
import { rustAccount } from "/imports/server/rust-shell-account";
import { Accounts } from "meteor/accounts-base";
import { redeemPowerboxWebkey } from "/imports/server/powerbox-webkey";
import Crypto from "crypto";
import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";
import { globalFrontendRefRegistry } from "/imports/server/frontend-ref";
import { queryPowerboxOptions, newPowerboxFrontendRef, fulfillPowerboxUiView } from "/imports/sandstorm-ui-powerbox/powerbox-server";
import { rustGrainPowerboxContext, createRustGrainSession, keepRustGrainSession, closeRustGrainSession } from "/imports/server/gateway-router";
import { rustGrainTitles } from "/imports/server/rust-shell-grains";

const text = value => (typeof value === "string" ? value : value?.defaultText || "");
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
  const api = {
    async open(parent, input, beforeWrite) {
      check(input.query, [String]);
      await validate(parent);
      const options = await queryPowerboxOptions(db, globalFrontendRefRegistry, parent.accountId, input.query);
      const request = {parent, query:input.query, options:new Map(), provider:null, result:null, delivered:false,oauthBinding:'powerbox:'+parent.sessionId+':'+Crypto.randomBytes(32).toString('hex')};
      const candidates = [];
      let legacy = false;
      for (const option of options) {
        let candidate;
        if (option.grainId) {
          try {
            const titles = await rustGrainTitles(db, parent.accountId, option.grainId);
            const grain = await db.collections.grains.findOneAsync(option.grainId);
            if (!grain || grain.trashed || grain.suspended) continue;
            const roles = (grain.cachedViewInfo?.roles || []).map((role, index) => ({key:String(index),title:text(role.title)}));
            candidate = {title:text(titles.title),iconSrc:titles.iconSrc,uiView:!!option.uiView,hostedObject:!!option.hostedObject,roles};
          } catch { continue; }
        } else if (option.cardTemplate === 'httpOAuthPowerboxCard' && ['github','google'].includes(option.oauthServiceInfo.service) && oauthEnabled(option.oauthServiceInfo.service)) {
          candidate = {title:'Connect to '+oauthProvider(option.oauthServiceInfo.service).label,oauthProvider:option.oauthServiceInfo.service,detail:text(option.oauthScopes.map(scope=>scope.name).join(', '))};
        } else if (option.cardTemplate === "addNewVerifiedEmailPowerboxCard" && Accounts.loginServices.email.isEnabled()) {
          candidate = {title:"Verify a new email address",emailInput:true};
        } else if (option.cardTemplate === "httpArbitraryPowerboxCard") {
          candidate = {title:"Connect to a URL",urlInput:true};
        } else if (option.frontendRef && !option.configureTemplate) {
          const title = simpleTitles[option.cardTemplate] || option.frontendRef.verifiedEmail?.address || option.frontendRef.http?.url;
          if (!title) { legacy = true; continue; }
          candidate = {title:text(title),detail: option.frontendRef.emailVerifier?.services?.join(", ") || ""};
        } else { legacy = true; continue; }
        const key = String(candidates.length);
        request.options.set(key, option);
        candidates.push({...candidate,key});
      }
      await beforeWrite();
      return {handle:request,view:{status:"choices",candidates,legacy,limited:false}};
    },
    async select(request, input, beforeWrite) {
      if (input.mode === 'nested') return {status:'nested',view:await api.nested(request,input,beforeWrite)};
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
      let oauthCredential;
      try {
        if (option.cardTemplate === 'httpOAuthPowerboxCard') {
          const provider = option.oauthServiceInfo.service;
          if (!['github','google'].includes(provider)) fail('Unsupported OAuth provider.');
          if (input.mode === 'oauthStart') {
            if (request.oauth) fail('Authorization is already in progress.');
            const binding = request.oauthBinding;
            const oauth = await startOAuth(provider,binding,option.oauthScopes.map(scope=>scope.name),{offline:true});
            if (request.closed) { await cancelOAuth(provider,binding,oauth.request); fail('Connection request ended.'); }
            request.oauth = {...oauth,provider,binding,key:input.key};
            return {status:'oauth',...oauth};
          }
          if (input.mode !== 'oauthFinish' || request.oauth?.key !== input.key) fail('Start authorization for this option first.');
          oauthCredential = await finishOAuth(provider,request.oauth.binding,request.oauth.request);
          if (!oauthCredential) return {status:'waiting'};
        }
        if (option.cardTemplate === "addNewVerifiedEmailPowerboxCard") {
          if (input.mode === "sendEmail") {
            if (request.email || typeof input.email !== "string" || !input.email.includes("@")) fail("Invalid verification request.");
            request.email = {key:input.key,address:input.email};
            await rustAccount(request.parent.accountId,"sendEmail",{email:input.email,allowLogin:false},beforeWrite);
            return {status:"email",address:input.email};
          }
          if (input.mode !== "verifyEmail" || request.email?.key !== input.key || typeof input.code !== "string" || !input.code) fail("Send a verification code first.");
          await rustAccount(request.parent.accountId,"verifyEmail",{email:request.email.address,code:input.code,allowLogin:false},beforeWrite);
        }
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
          let ref = oauthCredential ? {http:{url:option.httpUrl,auth:{oauth:oauthCredential}}} : option.frontendRef;
          if (option.cardTemplate === "addNewVerifiedEmailPowerboxCard") {
            ref = {verifiedEmail:{...option.frontendRef.verifiedEmail,address:request.email.address}};
          }
          if (option.cardTemplate === "httpArbitraryPowerboxCard") {
            if (typeof input.url !== "string") fail("Invalid URL.");
            const url = new URL(input.url);
            if (!["http:","https:"].includes(url.protocol) || url.username || url.password) fail("Use an HTTP or HTTPS URL without embedded credentials.");
            ref = {http:{url:url.href,auth:{none:null}}};
          }
          await beforeWrite();
          const result = await newPowerboxFrontendRef(db, globalFrontendRefRegistry, request.parent.accountId, request.parent.sessionId, structuredClone(ref));
          request.result = {token:result.sturdyRef,descriptor:result.descriptor};
        }
        return {status:"complete",...request.result};
      } finally {
        // The driver consumes this credential. Clean it up if validation or the
        // receiving session fails before the exchange reaches the driver.
        if (oauthCredential) await OAuth.retrieveCredential(oauthCredential.credentialToken,oauthCredential.credentialSecret);
      }
    },
    async nested(request,input,beforeWrite) {
      if (!request.provider || request.closed || typeof input.nestedRequest !== 'string' || !/^[a-f0-9]{64}$/.test(input.nestedRequest) ||
          !['begin','select','poll','cancel'].includes(input.nestedOperation)) fail('Invalid provider request.');
      if (input.nestedOperation === 'cancel') {
        if (request.nested?.id === input.nestedRequest) {
          const child = request.nested; request.nested = null;
          if (child.handle) await api.close(child.handle);
        }
        return {};
      }
      if (!input.nestedInput || typeof input.nestedInput !== 'object' || Array.isArray(input.nestedInput)) fail('Invalid provider input.');
      let child = request.nested;
      if (input.nestedOperation === 'begin') {
        if (child) fail('A provider connection request is already open.');
        child = {id:input.nestedRequest,handle:null}; request.nested = child;
      }
      if (!child || child.id !== input.nestedRequest) fail('Provider request ended.');
      const checkLive = async () => {
        await beforeWrite();
        if (request.closed || request.nested !== child) fail('Provider request ended.');
        await keepRustGrainSession(db,request.provider);
      };
      try {
        await checkLive();
        let result;
        if (input.nestedOperation === 'begin') {
          const opened = await api.open(request.provider,input.nestedInput,checkLive);
          child.handle=opened.handle; result=opened.view;
        } else {
          if (!child.handle || child.handle.delivered) fail('Provider request ended.');
          result=await api[input.nestedOperation](child.handle,input.nestedInput,checkLive);
        }
        await checkLive();
        if (result.status === 'complete') child.handle.delivered=true;
        return result;
      } catch (error) {
        if (request.nested === child) request.nested=null;
        if (child.handle) await api.close(child.handle);
        throw error;
      }
    },
    async poll(request) {
      await validate(request.parent);
      if (!request.provider) fail("No provider is open.");
      await keepRustGrainSession(db, request.provider);
      request.result = await providerResult(request);
      return request.result ? {status:"complete",...request.result} : {status:"waiting"};
    },
    async close(request) {
      request.closed=true;
      const child=request.nested; request.nested=null;
      if (child?.handle) await api.close(child.handle);
      if (request.oauth) await cancelOAuth(request.oauth.provider,request.oauth.binding,request.oauth.request);
      // Undelivered provider results must not survive cancellation. The requesting
      // session owns delivered tokens, which the existing gateway redeems/cleans up.
      if (request.provider) await db.collections.sessions.updateAsync({_id:request.provider.sessionId}, {$set:{rustPowerboxClosing:true}});
      const result = request.result || await providerResult(request);
      if (request.provider) await closeRustGrainSession(db, request.provider);
      if (!request.delivered) await removeResult(result);
    },
  };
  return api;
}

import { oauthEnabled, oauthProvider, startOAuth, finishOAuth, cancelOAuth } from "/imports/server/rust-shell-oauth";
import { startNativeSaml, finishNativeSaml, cancelNativeSaml, samlEnabled } from "/imports/server/accounts/saml/saml-server";
import { loginWithOAuth, loginWithSaml } from "/imports/server/rust-shell-auth";
import { Meteor } from "meteor/meteor";
import { Accounts } from "meteor/accounts-base";
import { SandstormDb } from "/imports/sandstorm-db/db";
import { globalDb } from "/imports/db-deprecated";
import { setPrimaryEmailForUser } from "/imports/server/accounts/accounts-ui-methods";
import { createAndEmailTokenForUser, linkEmailCredentialForAccount } from "/imports/server/accounts/email-token/token-server";
import { rustUserPicture } from "/imports/server/rust-shell-users";

const fail = message => { throw new Meteor.Error(400, message); };

export async function rustAccount(accountId, operation, input, beforeWrite) {
  const account = await Meteor.users.findOneAsync(accountId);
  if (!account?.loginCredentials) throw new Meteor.Error(403, "Account unavailable.");
  const ids = SandstormDb.getUserCredentialIds(account);
  let authorization;
  if (operation.startsWith('oauth')) oauthProvider(input.provider);
  const binding = 'link:'+accountId;
  if (operation === 'samlStart') {
    await beforeWrite(); authorization = await startNativeSaml(binding);
  } else if (operation === 'samlCancel') {
    cancelNativeSaml(binding,input.request);
  } else if (operation === 'samlFinish') {
    const credential = finishNativeSaml(binding,input.request);
    if (!credential) authorization = {pending:true,request:input.request};
    else await loginWithSaml(credential,async (id,check) => {
      await beforeWrite();
      check();
      await Accounts.linkCredentialToAccount(globalDb,globalThis.globalBackend,id,accountId,true);
    });
  } else if (operation === 'oauthStart') {
    await beforeWrite(); authorization = await startOAuth(input.provider,binding);
  } else if (operation === 'oauthCancel') {
    await cancelOAuth(input.provider,binding,input.request);
  } else if (operation === 'oauthFinish') {
    const credential = await finishOAuth(input.provider,binding,input.request);
    if (!credential) authorization = {pending:true,request:input.request};
    else await loginWithOAuth(input.provider,credential,async (id,check) => {
      await beforeWrite();
      check();
      await Accounts.linkCredentialToAccount(globalDb,globalThis.globalBackend,id,accountId,true);
    });
  } else if (operation === "primary") {
    await setPrimaryEmailForUser(accountId, input.email, beforeWrite);
  } else if (operation === "sendEmail") {
    if (!Accounts.loginServices.email.isEnabled()) fail("Email login is disabled.");
    await beforeWrite();
    await createAndEmailTokenForUser(globalDb, input.email, {
      rootUrl: process.env.ROOT_URL, resumePath: "/account", linking: {allowLogin: input.allowLogin},
    }, accountId);
  } else if (operation === "verifyEmail") {
    if (!Accounts.loginServices.email.isEnabled()) fail("Email login is disabled.");
    await linkEmailCredentialForAccount(globalDb, globalThis.globalBackend, accountId,
      input.email, input.code, input.allowLogin, beforeWrite);
  } else if (["unlink", "allowLogin"].includes(operation)) {
    if (!ids.includes(input.id)) throw new Meteor.Error(403, "Credential does not belong to this account.");
    const login = account.loginCredentials.some(item => item.id === input.id);
    const removingLogin = login && (operation === "unlink" || !input.allowLogin);
    if (removingLogin && account.loginCredentials.length < 2) fail("Keep at least one login method.");
    if (operation === "allowLogin" && input.allowLogin) {
      const other = await Meteor.users.findOneAsync({_id: {$ne: accountId}, $or: [
        {"loginCredentials.id": input.id}, {"nonloginCredentials.id": input.id},
      ]});
      if (other) fail("A credential shared with another account cannot be used to log in.");
    }
    await beforeWrite();
    // Match the arrays we authorized, so concurrent legacy edits cannot remove the last login.
    const selector = {_id: accountId, loginCredentials: account.loginCredentials,
      nonloginCredentials: account.nonloginCredentials || []};
    let modifier;
    if (operation === "unlink") {
      modifier = {$pull: {loginCredentials: {id: input.id}, nonloginCredentials: {id: input.id}}};
    } else if (login !== input.allowLogin) {
      modifier = {$pull: {[login ? "loginCredentials" : "nonloginCredentials"]: {id: input.id}},
        $push: {[login ? "nonloginCredentials" : "loginCredentials"]: {id: input.id}}};
    }
    if (modifier && !await Meteor.users.updateAsync(selector, modifier)) fail("Login methods changed. Reload and try again.");
  }
  const current = await Meteor.users.findOneAsync(accountId);
  const credentials = await Meteor.users.find({_id: {$in: SandstormDb.getUserCredentialIds(current)}}).fetchAsync();
  return {
    authorization, githubEnabled:oauthEnabled('github'), googleEnabled:oauthEnabled('google'), oidcEnabled:oauthEnabled('oidc'), samlEnabled:samlEnabled(),
    emailEnabled: !!Accounts.loginServices.email.isEnabled(),
    emails: await SandstormDb.getUserEmailsAsync(current),
    credentials: credentials.map(credential => ({id: credential._id,
      service: SandstormDb.getServiceName(credential), name: String(SandstormDb.getLoginId(credential)),
      pictureUrl: rustUserPicture(credential), login: current.loginCredentials.some(item => item.id === credential._id)})),
  };
}

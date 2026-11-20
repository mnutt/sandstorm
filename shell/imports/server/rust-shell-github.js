import { Meteor } from "meteor/meteor";
import { Accounts } from "meteor/accounts-base";
import { OAuth } from "meteor/oauth";
import { ServiceConfiguration } from "meteor/service-configuration";
import Crypto from "node:crypto";

const requests = new Map();
const lifetime = 300000;
const fail = message => { throw new Meteor.Error(400,message); };
export const githubEnabled = () => !!Accounts.loginServices.github?.isEnabled();
async function discard(key, request) {
  requests.delete(key);
  if (request.secret || request.error) await OAuth.retrieveCredential(key,request.secret || null);
}

export async function startGithub(binding, scopes = ['user:email']) {
  if (!Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string' || !/^[a-zA-Z0-9_:.-]+$/.test(scope))) fail('Invalid GitHub scopes.');
  if (!githubEnabled()) throw new Meteor.Error(403,'GitHub sign-in is disabled.');
  const config = await ServiceConfiguration.configurations.findOneAsync({service:'github'});
  if (!config?.clientId) throw new Meteor.Error(503,'GitHub is not configured.');
  const origin = Meteor.settings.public.rustShellOrigin;
  if (!origin || new URL(origin).protocol !== 'https:') throw new Meteor.Error(503,'Rust shell is unavailable.');
  for (const [key,request] of requests) if (request.expires <= Date.now() || request.binding === binding) await discard(key,request);
  // No await between admission and insertion: concurrent starts cannot exceed the bound.
  const key = Crypto.randomBytes(32).toString('hex');
  requests.set(key,{binding,expires:Date.now()+lifetime,origin});
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({client_id:config.clientId,redirect_uri:OAuth._redirectUri('github',config),
    scope:scopes.join(' '),state:OAuth._generateState('popup',key)}).toString();
  return {request:key,url:url.href};
}
export async function finishGithub(binding,key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) fail('Invalid authorization request.');
  const request = requests.get(key);
  if (!request || request.binding !== binding) throw new Meteor.Error(403,'Authorization does not belong to this session.');
  if (request.expires <= Date.now() || !githubEnabled()) { await discard(key,request); fail('Authorization expired.'); }
  if (request.error) { await discard(key,request); fail('GitHub authorization was not completed.'); }
  if (!request.secret) return null;
  requests.delete(key); // Transfer exactly once to the existing login/capability exchange.
  return {credentialToken:key,credentialSecret:request.secret};
}
export async function cancelGithub(binding,key) {
  const request = requests.get(key);
  if (request?.binding === binding) await discard(key,request);
}

// Keep the registered GitHub callback URL. Intercept only our server-issued,
// expiring state tokens; every other Meteor OAuth flow uses the original response.
const originalEnd = OAuth._endOfLoginResponse;
OAuth._endOfLoginResponse = async (res,details) => {
  let key;
  try { key = OAuth._credentialTokenFromQuery(details.query); } catch { return originalEnd(res,details); }
  const request = requests.get(key);
  if (!request) return originalEnd(res,details);
  if (request.expires <= Date.now()) {
    request.secret = details.credentials?.secret;
    await discard(key,request);
  } else if (!request.secret && !request.error) {
    request.secret = details.credentials?.secret;
    request.error = !!details.error || !request.secret;
  }
  res.writeHead(303,{'Location':request.origin+'/oauth-complete','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
  res.end();
};

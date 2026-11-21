import { Meteor } from "meteor/meteor";
import { Accounts } from "meteor/accounts-base";
import { OAuth } from "meteor/oauth";
import { ServiceConfiguration } from "meteor/service-configuration";
import Crypto from "node:crypto";
import { resolveOidcSigninUrl } from "/imports/oidc/oidc-server";

const requests = new Map();
const lifetime = 300000;
const fail = message => { throw new Meteor.Error(400,message); };
const providers = {
  oidc: {label:'OpenID Connect',scopes:[]},
  github: {label:'GitHub',url:'https://github.com/login/oauth/authorize',scopes:['user:email']},
  google: {label:'Google',url:'https://accounts.google.com/o/oauth2/auth',scopes:['email','profile']},
};
export function oauthProvider(provider) {
  if (!Object.hasOwn(providers,provider)) fail('Unsupported OAuth provider.');
  return providers[provider];
}
export const oauthEnabled = provider => {
  oauthProvider(provider);
  return !!Accounts.loginServices[provider]?.isEnabled();
};
async function discard(key, request) {
  requests.delete(key);
  if (request.secret || request.error) await OAuth.retrieveCredential(key,request.secret || null);
}

export async function startOAuth(provider, binding, scopes = oauthProvider(provider).scopes, {offline = false} = {}) {
  const definition = oauthProvider(provider);
  if (!Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string' || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))) fail('Invalid OAuth scopes.');
  if (!oauthEnabled(provider)) throw new Meteor.Error(403,definition.label+' sign-in is disabled.');
  const config = await ServiceConfiguration.configurations.findOneAsync({service:provider});
  if (!config?.clientId) throw new Meteor.Error(503,definition.label+' is not configured.');
  const origin = Meteor.settings.public.rustShellOrigin;
  if (!origin || new URL(origin).protocol !== 'https:') throw new Meteor.Error(503,'Rust shell is unavailable.');
  for (const [key,request] of requests) if (request.expires <= Date.now() || request.binding === binding) await discard(key,request);
  const key = Crypto.randomBytes(32).toString('hex');
  const state = OAuth._generateState('popup',key);
  if (provider === 'oidc') {
    const url = new URL(await resolveOidcSigninUrl(state));
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.hash) fail('Invalid OIDC authorization endpoint.');
    requests.set(key,{provider,binding,expires:Date.now()+lifetime,origin});
    return {request:key,url:url.href};
  }
  requests.set(key,{provider,binding,expires:Date.now()+lifetime,origin});
  const url = new URL(definition.url);
  const parameters = provider === 'google' ? {...config.loginUrlParameters} : {};
  if (provider === 'google') {
    parameters.response_type = 'code';
    scopes = [...new Set(['email',...scopes])];
    if (offline) Object.assign(parameters,{access_type:'offline',prompt:'consent'});
  }
  Object.assign(parameters,{client_id:config.clientId,redirect_uri:OAuth._redirectUri(provider,config),
    scope:scopes.join(' '),state});
  url.search = new URLSearchParams(parameters).toString();
  return {request:key,url:url.href};
}
export async function finishOAuth(provider,binding,key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) fail('Invalid authorization request.');
  const request = requests.get(key);
  if (!request || request.binding !== binding || request.provider !== provider) throw new Meteor.Error(403,'Authorization does not belong to this session.');
  if (request.expires <= Date.now() || !oauthEnabled(provider)) { await discard(key,request); fail('Authorization expired.'); }
  if (request.error) { await discard(key,request); fail(oauthProvider(provider).label+' authorization was not completed.'); }
  if (!request.secret) return null;
  requests.delete(key); // Transfer exactly once to the existing login/capability exchange.
  return {credentialToken:key,credentialSecret:request.secret};
}
export async function cancelOAuth(provider,binding,key) {
  const request = requests.get(key);
  if (request?.binding === binding && request.provider === provider) await discard(key,request);
}

// Keep the registered provider callback URLs. Intercept only our server-issued,
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

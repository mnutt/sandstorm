import Http from "node:http";
import Crypto from "node:crypto";
import { WebApp } from "meteor/webapp";
import { githubEnabled, startGithub, finishGithub, cancelGithub } from "/imports/server/rust-shell-github";
import { Meteor } from "meteor/meteor";
import { Accounts } from "meteor/accounts-base";
import { DDP } from "meteor/ddp-client";

// Use real Meteor login methods over a temporary DDP connection. This
// preserves login validators, organization policy, account creation and token
// ownership instead of duplicating authentication in the Rust shell.
// Installed Meteor accepts gateway-delivered sockets, so it has no TCP port of
// its own. Forward only secret-authenticated loopback upgrades to its existing
// DDP handler. No gateway DNS, certificate, or additional operator config needed.
const localKey = Crypto.randomBytes(32).toString('hex');
let localEndpoint;
function authEndpoint() {
  if (!localEndpoint) localEndpoint = new Promise((resolve,reject) => {
    const server = Http.createServer((_req,res) => {res.writeHead(404);res.end();});
    server.on('upgrade',(req,socket,head) => {
      if (req.headers.authorization !== 'Bearer '+localKey) {socket.destroy();return;}
      delete req.headers.authorization;
      WebApp.httpServer.emit('upgrade',req,socket,head);
    });
    server.once('error',error => {localEndpoint=undefined;server.close();reject(error);});
    server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port));
  });
  return localEndpoint;
}

const enabled = name => !!Accounts.loginServices[name]?.isEnabled();
const fail = message => { throw new Meteor.Error(400, message); };
export async function rustNativeAuth(operation, input, flow) {
  if (operation === "options") return {email:enabled("email"),dev:enabled("dev"),ldap:enabled("ldap"),github:githubEnabled()};
  const fields = {githubStart:[],githubFinish:['request'],githubCancel:['request'],sendEmail:["email"],email:["email","code"],dev:["name"],ldap:["username","password"]};
  if (!Object.hasOwn(fields,operation) || !input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key=>!fields[operation].includes(key)) || fields[operation].some(key=>typeof input[key] !== "string" || !input[key])) fail("Invalid sign-in request.");
  const binding = 'login:'+flow;
  if (operation === 'githubStart') return startGithub(binding);
  if (operation === 'githubCancel') { await cancelGithub(binding,input.request); return {}; }
  if (operation === 'githubFinish') {
    const oauth = await finishGithub(binding,input.request);
    if (!oauth) return {pending:true};
    return loginWithGithub(oauth);
  }
  const service = operation === "sendEmail" ? "email" : operation;
  if (!enabled(service)) throw new Meteor.Error(403,"That login method is disabled.");
  return loginThroughMeteor(operation,input);
}

export async function loginWithGithub(oauth, link) {
  return loginThroughMeteor('oauth',oauth,link);
}

async function loginThroughMeteor(operation,input,link) {
  const endpoint = await authEndpoint();
  let connected;
  const ready = new Promise(resolve => { connected = resolve; });
  const connection = DDP.connect(endpoint,{retry:false,onConnected:connected,headers:{Host:new URL(process.env.ROOT_URL).host,Authorization:'Bearer '+localKey}});
  let timer, credential, expired = false;
  const call = async (method, ...args) => {
    if (expired) throw new Meteor.Error(503,"Sign-in expired.");
    const result = await connection.applyAsync(method,args,{noRetry:true,returnServerResultPromise:true});
    if (expired) throw new Meteor.Error(503,"Sign-in expired.");
    return result;
  };
  try {
    return await Promise.race([
      (async () => {
        // noRetry methods must wait for the initial handshake: Meteor otherwise
        // treats the first connection reset as a dropped method invocation.
        await ready;
        if (operation === "sendEmail") {
          await call("createAndEmailTokenForUser",input.email,{rootUrl:process.env.ROOT_URL,resumePath:"/"});
          return {sent:true};
        }
        if (operation === 'oauth') {
          credential = await call('login',{oauth:input});
          const github = await Meteor.users.findOneAsync({_id:credential.id,'services.github':{$exists:true}},{fields:{_id:1}});
          if (!github) throw new Meteor.Error(403,'Expected a GitHub credential.');
          if (link) { await link(credential.id); return {linked:true}; }
        } else if (operation === "dev") {
          // These names are credential identifiers, not just display labels.
          // Match the legacy devLoginForm exactly to reopen existing accounts.
          const names = {Alice:"Alice Dev Admin",Bob:"Bob Dev User",Carol:"Carol Dev User",Dave:"Dave Dev User"};
          if (!Object.hasOwn(names,input.name)) fail("Choose a listed development account.");
          credential = await call("createDevAccount",names[input.name],input.name === "Alice");
        } else if (operation === "email") {
          credential = await call("login",{email:{email:input.email,token:input.code}});
        } else {
          credential = await call("login",{ldap:true,username:input.username,ldapPass:input.password});
        }
        const account = await Meteor.users.findOneAsync({"loginCredentials.id":credential.id},{fields:{_id:1}});
        const id = account?._id || await call("createAccountForCredential");
        const result = await call("loginWithCredential",id);
        return {accountId:result.id,loginHash:Accounts._hashLoginToken(result.token)};
      })(),
      new Promise((_,reject) => { timer=setTimeout(()=>{ expired=true; reject(new Meteor.Error(503,"Sign-in timed out. Check before trying again.")); },15000); }),
    ]);
  } finally {
    clearTimeout(timer); connection.close();
    // Only the resulting account token backs the Rust session. Do not leave an
    // unused credential resume token behind after this temporary DDP connection.
    if (credential?.token) await Meteor.users.updateAsync(credential.id,{$pull:{"services.resume.loginTokens":{hashedToken:Accounts._hashLoginToken(credential.token)}}});
  }
}

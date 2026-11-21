import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { once, EventEmitter } from 'node:events';
import { chromium, expect } from '@playwright/test';
import { start, stop, serveProbe, availablePort } from './harness.mjs';
import { httpsProxy } from './https-harness.mjs';
import { memorySessionStore } from '../../../shell/imports/server/rust-shell-session-store.mjs';
import { createRustShellBridge, bridgeHandler } from '../../../shell/imports/server/rust-shell-bridge-core.mjs';

// Uses the production bridge authority/HTTP implementation with an in-memory DB
// adapter. No test writes or login tokens touch the installed Meteor/Mongo server.
test('authenticated notifications: handoff, shared writes, account switching and revocation', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rust-shell-auth-'));
  const socket = join(directory, 'rust.sock');
  const bridgeSocket = join(directory, 'meteor.sock');
  let proxy, main, grainServer, bridgeServer, browser, rust, vite;
  let vitePort;
  const liveGrains = new Set();
  const grainStates=new Map(), grainSessions=new Map();
  let managementFailure=false;
  const responseReady = new Set(), responseEvents = new EventEmitter(), heldAssets = new Set();
  let stallAssets = false;
  const waitForResponse = async (handle, signal) => {
    if (!responseReady.has(handle)) await once(responseEvents, String(handle), {signal});
    return {loaded:true};
  };
  const releaseAssets = () => {stallAssets=false;for(const res of heldAssets)res.end('window.assetFinished=true;');heldAssets.clear();};
  let grainOrigin;
  let mainOrigin;
  let logoutMode = 'none';
  let serial = 0;
  let leaseClockOffset = 0;
  let renewals = 0;
  let templates = 0;
  const templateOptions = [];
  let uploadedPicture;
  const grainTitles = {};
  let creations = 0;
  let failCreation = false;
  let holdOpen = false;
  let releaseOpen;
  const fixtureAvatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const users = { alice: { pictureUrl:fixtureAvatar, name: 'Alice', hash: 'alice-login', expires: Date.now() + 3600000 },
    bob: { name: 'Bob', hash: 'bob-login', expires: Date.now() + 3600000 } };
  const rows = new Map();
  const observers = new Map();
  let observationStarts = 0;
  const changed = () => { for (const notify of observers.keys()) notify(); };
  const add = (key, user, title) => { rows.set(key, { user, key, title, body: 'Shared notification',
    unread: true, ongoing: false, href: '', senderPictureUrl:fixtureAvatar, senderName: '<script>window.senderInjected = true</script>', timestamp: new Date().toISOString() }); changed(); };
  add('alice-real-id', 'alice', 'Alice notification');
  add('bob-real-id', 'bob', 'Bob notification');
  let activeMainAccount = 'alice';
  let bridgeOffline = false;
  const sessionStore = memorySessionStore();
  const profiles = {alice:{name:'Alice',handle:'alice',pronoun:'neutral'},bob:{name:'Bob',handle:'bob',pronoun:'neutral'}};
  const profileVersion = id => JSON.stringify(profiles[id]);
  const sharingGrants = [];
  let reportingAllowed = true;
  let shareCreations = 0;
  let providerComplete = false;
  const nativeProviders = new Set();
  const installId = 'a'.repeat(32);
  const installPermissions = {canInstall:true,canUpload:true,installReason:'',uploadReason:''};
  const installState = {permissions:installPermissions,packageId:installId,status:'missing',appId:'test-app',title:'Install test app',description:'A verified package',version:'2.0',iconSrc:'',fingerprint:'test-key',progress:0,installed:false,newerInstalled:false,olderGrains:2};
  const installCalls = [];
  let denyInstall = true;
  const accountEmails = [{email:'alice@example.test',verified:true,primary:true},{email:'second@example.test',verified:true,primary:false}];
  const accountCredentials = [{id:'email-alice',service:'email',name:'alice@example.test',pictureUrl:fixtureAvatar,login:true}];
  const accountCalls = [];
  const oauthReady = {github:false,google:false,oidc:false,saml:false};
  const oauthUrl = provider => provider === 'saml' ? 'https://identity.example.test/saml?SAMLRequest=fixture' : provider === 'oidc' ? 'https://identity.example.test/authorize?state=fixture' : provider === 'google' ? 'https://accounts.google.com/o/oauth2/auth?state=fixture' : 'https://github.com/login/oauth/authorize?state=fixture';
  let paginated = false, laterTitle = 'Older notification';
  const bridgeOptions = {
    logoutDestination: async () => {
      if(logoutMode==='failure') throw new Error('private provider configuration detail');
      if(logoutMode==='unsafe') return 'javascript:alert(1)';
      if(logoutMode==='redirect') {
        await new Promise(resolve=>setTimeout(resolve,250));
        return 'https://idp.example/logout?SAMLRequest=fixture';
      }
      return null;
    },
    nativeAuth: async (operation,data) => {
      if(operation.startsWith('saml')) {operation=operation.replace('saml','oauth');data={...data,provider:'saml'};}
      if (operation === 'options') return {dev:true,email:false,ldap:false,github:true,google:true,oidc:true,saml:true};
      if (operation === 'oauthStart') {oauthReady[data.provider]=false;return {request:'a'.repeat(64),url:oauthUrl(data.provider)};}
      if (operation === 'oauthFinish') return oauthReady[data.provider] ? {accountId:'alice',loginHash:users.alice.hash} : {pending:true};
      if (operation === 'oauthCancel') return {};
      assert.equal(operation,'dev'); assert.equal(data.name,'Alice');
      return {accountId:'alice',loginHash:users.alice.hash};
    },
    accountSettings: async (id,operation,data,beforeWrite) => {
      await beforeWrite(); accountCalls.push(operation);
      if(operation.startsWith('saml')) {operation=operation.replace('saml','oauth');data={...data,provider:'saml'};}
      if (operation === 'primary') for (const email of accountEmails) email.primary=email.email===data.email;
      if (operation === 'verifyEmail') { assert.equal(data.code,'123456'); accountCredentials.push({id:'new-email',service:'email',name:data.email,pictureUrl:'',login:true}); }
      if (operation === 'unlink') accountCredentials.splice(accountCredentials.findIndex(item=>item.id===data.id),1);
      let oauth;
      if(operation === 'oauthStart'){oauthReady[data.provider]=false;oauth={request:'a'.repeat(64),url:oauthUrl(data.provider)};}
      if(operation === 'oauthFinish'){
        if(!oauthReady[data.provider]) oauth={request:data.request,pending:true};
        else if(!accountCredentials.some(c=>c.id==='oauth-'+data.provider)) accountCredentials.push({id:'oauth-'+data.provider,service:data.provider,name:data.provider+' fixture',pictureUrl:'',login:true});
      }
      return {emailEnabled:true,githubEnabled:true,googleEnabled:true,oidcEnabled:true,samlEnabled:true,authorization:oauth,emails:id==='alice'?accountEmails:[],credentials:id==='alice'?accountCredentials:[]};
    },
    install: async (id,operation,data,beforeWrite) => {
      assert.equal(id,'alice'); installCalls.push(operation);
      if (operation === 'catalog') return {permissions:installPermissions,marketUrl:'https://apps.example.test/',updates:[{packageId:installId,title:'Install test app',version:'2.0',url:'https://packages.example.test/test.spk'}]};
      if (operation === 'upload') return {uploadUrl:mainOrigin+'/upload/test-token'};
      assert.equal(data.packageId,installId);
      await beforeWrite();
      if (operation === 'download') { installState.status = 'download'; setTimeout(() => { installState.status = 'ready'; },200); }
      if (operation === 'confirm' && denyInstall) throw Object.assign(new Error('Your account needs an invitation before you can install apps. Ask the server administrator to grant you access.'),{status:403});
      if (operation === 'confirm') installState.installed = true;
      if (operation === 'upgrade') installState.olderGrains = 0;
      return {...installState};
    },
    uploadPicture: async (id,beforeWrite) => { await beforeWrite(); assert.equal(id,'alice'); return {uploadUrl:mainOrigin+'/picture-token'}; },
    getProfile: async id => ({...profiles[id],version:profileVersion(id)}),
    updateProfile: async (id, profile, beforeWrite) => { await beforeWrite(); if (profile.handle === 'reserved_handle') throw Object.assign(new Error('That handle cannot be used.'), {status:400}); profiles[id] = {...profiles[id],...profile}; users[id].name = profile.name; changed(); },
    sessionStore,
    listApps: async (id, _page, appId) => { if(appId==='denied-test') throw Object.assign(new Error('App list denied.'),{status:403}); return {actions:[{key:id+'-action',title:'New document',appTitle:'Test app',appId:'test-app',grainCount:3,shortDescription:'A simple editor for notes and documents',iconSrc:'',lastUsed:'2026-01-01T00:00:00.000Z'}],limited:false}; },
    createGrain: async (id, action, title, beforeCreate) => {
      if (action !== id+'-action') throw Object.assign(new Error('Action not available to this account.'), {status:403});
      if (title === 'Denied creation') throw Object.assign(new Error('You must be invited to create grains.'), {status:403});
      assert.equal(title,'Created in Rust');
      await beforeCreate(); ++creations;
      if (failCreation) throw new Error('Simulated lost creation result');
      return id+'-created';
    },
    now: () => Date.now() + leaseClockOffset,
    grains: {
      waitForResponse,
      powerbox: {
        open: async (_parent,input) => ({handle:{},view:{status:'choices',candidates:[{key:'disabled',title:'Disabled Google',oauthProvider:'google',disabledReason:'An administrator must enable Google.'},{key:'person',title:'Pat Example',identity:true,roles:[{key:'2',title:'Contributor'}]},{key:'url',title:'Connect to a URL',urlInput:true},{key:'google',title:'Connect to Google',oauthProvider:'google',detail:'Read your Drive files'},{key:'provider',title:'Test provider',hostedObject:true},{key:'view',title:'Whole grain',uiView:true,roles:[]}],limited:false,legacy:!input.query.includes('supported')}}),
        select: async (request, input) => {
          if (input.key === 'person') { assert.equal(input.mode,'identity'); assert.equal(input.role,'2'); return {status:'complete',token:'native-identity-token'}; }
          if (input.key === 'url') { assert.equal(input.mode,'url'); assert.equal(input.url,'https://example.com/#bearer-secret'); return {status:'complete',token:'native-url-token'}; }
          if (input.key === 'google') {
            if(input.mode === 'oauthStart') {oauthReady.google=false;return {status:'oauth',request:'a'.repeat(64),url:oauthUrl('google')};}
            assert.equal(input.mode,'oauthFinish');
            return oauthReady.google ? {status:'complete',token:'native-google-token'} : {status:'waiting'};
          }
          if (input.mode === 'nested') {
            if (input.nestedOperation === 'begin') return {status:'nested',view:{status:'choices',candidates:[{key:'child',title:'Nested grain',uiView:true,roles:[]}],limited:false,legacy:false}};
            if (input.nestedOperation === 'select') return {status:'nested',view:{status:'complete',token:'native-nested-token'}};
            return {status:'nested',view:{}};
          }
          if (input.mode === 'webkey' && input.url.includes('#denied')) throw Object.assign(new Error('You do not have access to this capability.'), {status:403});
          if (input.mode === 'webkey' && input.url.includes('#unavailable')) throw Object.assign(new Error('Internal backend detail'), {status:503});
          if (input.mode === 'webkey') { assert.equal(input.url,'https://api.example.test/#source-secret'); return {status:'complete',token:'derived-webkey-token'}; }
          if (input.key === 'view') return {status:'complete',token:'native-view-token',descriptor:'view-descriptor'};
          assert.equal(input.key,'provider'); providerComplete = false; nativeProviders.add(request);
          return {status:'provider',title:'Test provider',origin:grainOrigin,url:grainOrigin+'/powerbox-provider'};
        },
        poll: async () => providerComplete ? {status:'complete',token:'native-provider-token',descriptor:'provider-descriptor'} : {status:'waiting'},
        close: async request => { nativeProviders.delete(request); },
      },
      open: async (id, grainId) => {
        if (![`${id}-grain`, `${id}-hidden`, `${id}-created`, `${id}-extra`].includes(grainId)) throw Object.assign(new Error('Denied'), { status: 403 });
        if (holdOpen) await new Promise(resolve => { releaseOpen = resolve; });
        const handle = ++serial; liveGrains.add(handle); grainSessions.set(handle,grainId);
        return { handle, view: { grainId, iconSrc: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="24" height="24"%3E%3Crect width="24" height="24" fill="orange"/%3E%3C/svg%3E', title: grainId.endsWith('-hidden') ? 'Hidden grain' : grainId.endsWith('-extra') ? 'Zebra shared' : '', ownerTitle: grainTitles[id] || 'Owner title', mainHref: mainOrigin + '/grain/' + grainId, origin: grainOrigin, url: grainOrigin + '/_sandstorm-init?sessionid=' + handle } };
      },
      keep: async (handle) => { ++renewals; if (!liveGrains.has(handle)) throw new Error('Session revoked'); },
      close: async (handle) => { liveGrains.delete(handle); },
      rename: async (_handle, title, beforeWrite) => { await beforeWrite(); if (title === 'Denied rename') throw Object.assign(new Error('You cannot rename this grain.'), {status:403}); grainTitles.alice = title; changed(); return { title, ownerTitle: title }; },
      sharing: async () => ({roles:[{key:'0',title:'Viewer',description:'Read only'},{key:'1',title:'Editor',description:'Can edit'}],defaultRole:'0',private:true,owner:true,
        grants:[...sharingGrants,{id:'downstream',kind:'person',recipient:'Bob',recipientPictureUrl:fixtureAvatar,label:'Via project link',role:'0',editable:false,inherited:true,created:''}],limited:false}),
      createShare: async (_handle, input, beforeWrite) => {
        await beforeWrite();
        if (input.label === 'Denied test link') throw Object.assign(new Error('You cannot share this grain.'), {status:403});
        ++shareCreations;
        sharingGrants.push({id:'share-'+shareCreations,kind:'link',label:input.label,role:input.role,editable:true,inherited:false,created:'',recipient:'Anyone with the link'});
        return {id:'share-'+shareCreations,token:'native-share-'+shareCreations};
      },
      updateShare: async (_handle, input, beforeWrite) => {
        await beforeWrite();
        const index = sharingGrants.findIndex(row => row.id === input.id);
        assert.ok(index >= 0);
        if (input.changes.revoked) sharingGrants.splice(index,1);
        else Object.assign(sharingGrants[index],input.changes);
        return {};
      },
      template: async (_handle, options) => {
        templateOptions.push(options);
        return { id: ++templates, token: 'sensitive-template-token', host: new URL(grainOrigin).host };
      },
      revokeTemplate: async () => { --templates; },
    },
    manageGrain: async (account,id,operation,beforeWrite) => {
      const state=grainStates.get(id) || 'active';
      if(operation==='read') return {state};
      await beforeWrite();
      if(managementFailure && id==='alice-extra') throw Object.assign(new Error('You cannot change this grain.'),{status:403});
      assert.ok(id.startsWith(account+'-'));
      if(operation==='remove') assert.equal(state,'trashed');
      grainStates.set(id,operation==='trash'?'trashed':operation==='restore'?'active':'unavailable');
      if(operation!=='restore') for(const [handle,key] of grainSessions) if(key===id)liveGrains.delete(handle);
      changed();return {};
    },
    authorize: async (id, hash) => {
      if (bridgeOffline) throw Object.assign(new Error('Main shell starting'), { status: 503 });
      return users[id]?.hash === hash ? users[id] : null;
    },
    notification: async (id,key,operation,enabled,beforeWrite) => {
      const notice = rows.get(key);
      if (!notice || notice.user !== id) throw Object.assign(new Error('Notification no longer available.'), {status:404});
      const kind = notice.nativeAction;
      if (operation === 'setStats' && kind !== 'stats') throw Object.assign(new Error('This notification cannot change reporting preferences.'), {status:400});
      if (kind === 'stats' && !reportingAllowed) throw Object.assign(new Error('Administrator access is required.'), {status:403});
      if (operation === 'setStats') { await beforeWrite(); rows.delete(key); changed(); return {kind:'stats',enabled,sample:''}; }
      if (kind === 'stats') return {kind,enabled:null,sample:'{}'};
      if (kind === 'referrals') return {kind,enabled:true,pending:[{name:'Pending person',pictureUrl:fixtureAvatar}],completed:[{name:'Completed person',pictureUrl:fixtureAvatar}]};
      return {kind};
    },
    observe: async (_id, notify, pages, query) => { ++observationStarts; observers.set(notify, {pages, query}); return () => observers.delete(notify); },
    snapshot: async (id, pages = {}, query) => {
      if (query?.search === 'denied-test' || pages.notifications===99) throw Object.assign(new Error('List access denied.'),{status:403});
      if (paginated) return {entries:[{key:'paged-'+(pages.notifications || 0),title:pages.notifications ? laterTitle : 'First page',body:'',href:'',unread:false,ongoing:false,timestamp:''}],total:101,notificationPage:pages.notifications || 0,grainPage:pages.grains || 0,hasUnread:true};
      const entries = [...rows.values()].filter((row) => row.user === id).map(({ user, ...entry }) => entry);
      const snapshot = { hasUnread:entries.some(entry=>entry.unread), accountPictureUrl:profiles[id].pictureUrl || '', profileVersion:profileVersion(id), entries, total: entries.length, grains: [{ key: `${id}-grain`, title: grainTitles[id] || `${users[id].name} grain`, ownerTitle: grainTitles[id] || (id === 'alice' ? 'Alice grain' : 'Owner title'),
        href: `${mainOrigin}/grain/${id}-grain`, appTitle: 'Text Editor', appId: 'test-app', owned: id === 'alice', lastUsed: new Date(0).toISOString() },
        ...(id === 'alice' ? [{ key: 'alice-extra', title: 'Zebra shared', href: `${mainOrigin}/grain/alice-extra`,
          owned: false, appTitle: 'Spreadsheet', lastUsed: new Date(1000).toISOString() }] : [])], grainsLimited: false };
      snapshot.grains=snapshot.grains.filter(grain=>(grainStates.get(grain.key)||'active')===(query?.trash?'trashed':'active'));
      if (query) {
        snapshot.grains = snapshot.grains.filter(grain =>
          (!query.appId || grain.appId === query.appId) &&
          (query.ownership === 'all' || grain.owned === (query.ownership === 'owned')) &&
          `${grain.title} ${grain.appTitle}`.toLowerCase().includes(query.search.trim().toLowerCase()));
        snapshot.grains.sort((a, b) => query.sort === 'title' ? a.title.localeCompare(b.title) : b.lastUsed.localeCompare(a.lastUsed));
      }
      return snapshot;
    },
    dismiss: async (id, key) => {
      if (!rows.has(key)) throw Object.assign(new Error('Notification not found.'), {status:404});
      if (rows.get(key)?.user !== id) throw Object.assign(new Error('Not your notification'), { status: 403 });
      rows.delete(key); changed();
    },
    markRead: async (id,key) => { for (const row of rows.values()) if (row.user === id && (key === undefined || row.key === key)) row.unread = false; changed(); },
  };
  let sharedRevoked = false;
  let guestsAllowed = true;
  const sharedOpens = [];
  bridgeOptions.shared = {
    waitForResponse,
    inspect: async webkey => {
      if (webkey !== 'valid-share' || sharedRevoked) throw Object.assign(new Error('Sharing link revoked or invalid'), {status:403});
      return {title:'Shared test grain',guestsAllowed};
    },
    open: async (webkey,accountId) => {
      sharedOpens.push({webkey,accountId});
      const handle = ++serial; liveGrains.add(handle);
      return {handle,view:{grainId:'shared-grain',title:'Shared test grain',ownerTitle:'Shared test grain',
        origin:grainOrigin,url:grainOrigin+'/_sandstorm-init?sessionid='+handle,mainHref:mainOrigin+'/shared/'+webkey}};
    },
    keep: async handle => {if (!liveGrains.has(handle)) throw new Error('Revoked');},
    close: async handle => {liveGrains.delete(handle);},
  };
  let bridge = createRustShellBridge(bridgeOptions);
  try {
    if (process.env.RUST_SHELL_TEST_DEV === '1') {
      const root=fileURLToPath(new URL('..',import.meta.url));
      vite=await createViteServer({root,configFile:join(root,'vite.config.ts'),logLevel:'silent',server:{host:'127.0.0.1',port:await availablePort()}});
      await vite.listen(); vitePort=vite.httpServer.address().port;
    }
    proxy = await httpsProxy(directory, socket);
    grainServer = httpsServer(proxy.tls, (_req, res) => {
      if (_req.url === '/slow-app.js') {
        res.setHeader('Content-Type','text/javascript');
        if(stallAssets){heldAssets.add(res);res.on('close',()=>heldAssets.delete(res));}else res.end('');
        return;
      }
      const handle=Number(new URL(_req.url,'https://grain.test').searchParams.get('sessionid'));
      if(handle){responseReady.add(handle);responseEvents.emit(String(handle));}

      if (_req.url === '/powerbox-complete') { providerComplete = true; res.end('ok'); return; }
      if (_req.url === '/powerbox-provider') {
        res.setHeader('Content-Type','text/html');
        res.end(`<button onclick="fetch('/powerbox-complete')">Select test object</button>`); return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end((stallAssets?'<script defer src="/slow-app.js"></script>':'')+'<h1>Embedded test grain</h1><input aria-label="App state"><script>window.addEventListener("message", event => { window.reply = event.data; });</script>');
    });
    grainServer.listen(0, '127.0.0.1'); await once(grainServer, 'listening');
    grainOrigin = `https://localhost:${grainServer.address().port}`;
    bridgeServer = httpServer((req, res) => {
      if (bridgeOffline) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"Main shell starting"}'); return; }
      return bridgeHandler(bridge)(req, res);
    });
    bridgeServer.listen(bridgeSocket); await once(bridgeServer, 'listening'); await chmod(bridgeSocket, 0o600);
    main = httpsServer(proxy.tls, async (req, res) => {
      try {
        if (req.url === '/picture-token' && req.method === 'POST') {
          assert.equal(req.headers.cookie,undefined);
          const chunks=[]; for await (const chunk of req) chunks.push(chunk);
          const uploaded = Buffer.concat(chunks); uploadedPicture=uploaded;
          assert.equal(uploaded[0],255); assert.equal(uploaded[1],216);
          assert.ok(uploaded.length <= 65536);
          assert.equal(req.headers['content-type'],'image/jpeg');
          profiles.alice.pictureUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
          changed();
          res.writeHead(204,{'Access-Control-Allow-Origin':'*'}); res.end(); return;
        }
        if (req.url === '/picture-token' && req.method === 'OPTIONS') {
          res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'POST'}); res.end(); return;
        }
        if (req.url === '/rust-shell-powerbox') {
          res.setHeader('Content-Type', 'text/html');
          res.end(`<button id="choose">Choose test capability</button><script>
            window.addEventListener('message', event => {
              if (event.source !== opener || event.origin !== '${proxy.origin}' || event.data.type !== 'rust-powerbox-request') return;
              window.request = event.data;
            });
            opener.postMessage({type:'rust-powerbox-ready'}, '${proxy.origin}');
            document.getElementById('choose').onclick = () => opener.postMessage({type:'rust-powerbox-result',
              nonce:request.nonce, result:{rpcId:request.request.rpcId, token:'test-capability', descriptor:'test-descriptor'}}, '${proxy.origin}');
          </script>`);
          return;
        }
        const state = new URL(req.url, 'https://localhost').searchParams.get('state');
        const code = await bridge.issue(activeMainAccount, users[activeMainAccount].hash, state);
        res.setHeader('Content-Type', 'text/html');
        res.end(`<form method="POST" action="${proxy.origin}/auth/login"><input type="hidden" name="state" value="${state}"><input type="hidden" name="code" value="${code}"><button>Connect ${users[activeMainAccount].name}</button></form>`);
      } catch { res.writeHead(400); res.end(); }
    });
    main.listen(0, '127.0.0.1'); await once(main, 'listening');
    mainOrigin = `https://localhost:${main.address().port}`;
    rust = (await start('debug/sandstorm-rust-shell', [], {
      RUST_SHELL_SOCKET: socket, RUST_SHELL_ORIGIN: proxy.origin, RUST_SHELL_DEV_PORT: vitePort?.toString(),
      RUST_SHELL_MAIN_URL: mainOrigin, RUST_SHELL_WILDCARD_HOST: new URL(mainOrigin).host, RUST_SHELL_BRIDGE_SOCKET: bridgeSocket,
      RUST_SHELL_FIXTURE_SOCKET: '',
    }, /Rust shell: (https:\/\/\S+)/)).child;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium',
      headless: true, args: [`--ignore-certificate-errors-spki-list=${proxy.pin}`] });
    const context = await browser.newContext();
    await context.route('https://identity.example.test/saml**', async route => { oauthReady.saml=true; await route.fulfill({contentType:'text/html',body:'Authorization complete'}); });
    await context.route('https://identity.example.test/authorize**', async route => { oauthReady.oidc=true; await route.fulfill({contentType:'text/html',body:'Authorization complete'}); });
    await context.route('https://github.com/login/oauth/authorize**', async route => { oauthReady.github=true; await route.fulfill({contentType:'text/html',body:'Authorization complete'}); });
    await context.route('https://accounts.google.com/o/oauth2/auth**', async route => { oauthReady.google=true; await route.fulfill({contentType:'text/html',body:'Authorization complete'}); });
    const page = await context.newPage();
    const errors = [];
    let receivedFrames = 0;
    page.on('websocket', (socket) => socket.on('framereceived', () => { ++receivedFrames; }));
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(proxy.origin);
    await page.getByRole('link', { name: 'Sign in with Sandstorm' }).waitFor();


    assert.equal(await page.getByRole('button', { name: 'Add test notification' }).count(), 0);
    const guest = await context.newPage();
    stallAssets=true;
    await guest.goto(proxy.origin+'/shared/valid-share/folder?view=guest#document',{waitUntil:'domcontentloaded'});
    await guest.frameLocator('iframe').getByRole('heading',{name:'Embedded test grain'}).waitFor();
    await expect(guest.locator('.frame-loading')).toHaveCount(0);
    assert.notEqual(await guest.frames().find(frame=>frame.url().startsWith(grainOrigin)).evaluate(()=>document.readyState),'complete','shared readiness reveals the frame before assets finish');
    releaseAssets();

    await serveProbe(guest, './shared-probe.ts', 'shared-probe.js');
    assert.equal(await guest.evaluate(async ()=>(await import('/shared-probe.js')).probe()),true,'public shared bootstrap cannot be cast to account Shell');
    assert.equal(await guest.evaluate(async ()=>(await import('/shared-probe.js')).checkResults()),true,'shared policy failures are typed without issuing a lease');
    for (const kind of ['reply', 'flood']) {
      assert.equal(await guest.evaluate(async kind => (await import('/shared-probe.js')).attack(kind), kind), kind === 'reply',
        `only malformed replies are disconnected (${kind})`);
    }
    assert.equal(await guest.evaluate(async () => (await fetch('/healthz')).status), 200, 'server survives malformed RPC and flooding');
    assert.equal(sharedOpens.at(-1).accountId,null);
    assert.equal(new URL(await guest.locator('iframe').getAttribute('src')).searchParams.get('path'),'/folder?view=guest#document');
    assert.equal(await guest.getByRole('button',{name:'Rename grain',exact:true}).count(),0);
    await guest.frameLocator('iframe').locator('body').evaluate(()=>parent.postMessage({setPath:'/next?x=1#part'},'*'));
    await guest.waitForURL('**/shared/valid-share/next?x=1#part');
    await guest.getByRole('link',{name:'Notifications',exact:true}).click();
    assert.equal(await guest.locator('iframe').count(),1,'shared views stay mounted in the background');
    await guest.reload();
    await expect(guest.locator('iframe')).toHaveCount(1);
    await expect(guest.locator('iframe:visible')).toHaveCount(0);
    await expect(guest.getByRole('link',{name:'Switch to Shared test grain'})).toHaveAttribute('href','/shared/valid-share/next?x=1#part');
    await guest.getByRole('link',{name:'Switch to Shared test grain'}).click();
    sharedRevoked = true; await bridge.sweepGrains();
    await expect.poll(()=>liveGrains.size).toBe(0);
    await expect(guest.getByRole('alert')).toContainText('Shared session ended',{timeout:15000});
    await guest.close(); sharedRevoked = false;
    guestsAllowed = false;
    const blockedGuest = await context.newPage();
    await blockedGuest.goto(proxy.origin+'/shared/valid-share');
    await blockedGuest.getByText('This server requires you to sign in before viewing shared grains.').waitFor();
    assert.equal(await blockedGuest.locator('iframe').count(),0);
    await blockedGuest.close(); guestsAllowed = true;
    const denied = await page.evaluate(() => new Promise((resolve) => {
      const ws = new WebSocket(location.origin.replace('https:', 'wss:') + '/rpc');
      ws.onopen = () => { ws.close(); resolve(false); }; ws.onerror = () => resolve(true);
    }));
    assert.equal(denied, true);
    const bad = await page.evaluate(async () => (await fetch('/auth/login', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `code=${'a'.repeat(64)}&state=${'b'.repeat(64)}` })).status);
    assert.equal(bad, 403);
    const samlPage=await context.newPage();
    await samlPage.goto(proxy.origin+'/login');
    await samlPage.getByRole('button',{name:'Sign in with SAML',exact:true}).click();
    await samlPage.getByRole('heading',{name:/Alice notification/}).waitFor();
    await samlPage.evaluate(()=>fetch('/auth/logout',{method:'POST'}));
    await samlPage.close();
    const oidcPage=await context.newPage();
    await oidcPage.goto(proxy.origin+'/login');
    await oidcPage.getByRole('button',{name:'Sign in with OpenID Connect',exact:true}).click();
    await oidcPage.getByRole('heading',{name:/Alice notification/}).waitFor();
    await oidcPage.evaluate(()=>fetch('/auth/logout',{method:'POST'}));
    await oidcPage.close();
    const googlePage=await context.newPage();
    await googlePage.goto(proxy.origin+'/login');
    await context.clearCookies({name:'__Host-sandstorm-rust-flow'}); // An idle page outlived its flow cookie.
    await googlePage.getByRole('button',{name:'Sign in with Google',exact:true}).click();
    await googlePage.getByRole('heading',{name:/Alice notification/}).waitFor();
    await googlePage.evaluate(()=>fetch('/auth/logout',{method:'POST'}));
    await googlePage.close();
    await page.getByRole('link', { name: 'Sign in with Sandstorm' }).click();
    await page.getByRole('button',{name:'Sign in with GitHub',exact:true}).click();
    await page.getByRole('heading', { name: /Alice notification/ }).waitFor();
    assert.equal(await page.getByRole('heading', { name: /Bob notification/ }).count(), 0);
    await page.getByText('From <script>window.senderInjected = true</script>', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.senderInjected), undefined);
    await expect(page.locator('.notification-item .avatar img')).toHaveAttribute('src',fixtureAvatar);
    paginated = true; changed();
    await page.getByRole('heading',{name:'First page',exact:true}).waitFor();
    const pager = page.getByRole('navigation',{name:'Notifications pages'});
    await pager.getByRole('button',{name:'Next',exact:true}).click();
    await page.getByRole('heading',{name:'Older notification',exact:true}).waitFor();
    await expect(page.getByLabel('Unread notifications')).toBeVisible();
    laterTitle = 'Older notification updated'; changed();
    await page.getByRole('heading',{name:laterTitle,exact:true}).waitFor();
    await pager.getByRole('button',{name:'Previous',exact:true}).click();
    await page.getByRole('heading',{name:'First page',exact:true}).waitFor();
    paginated = false; changed();
    await page.getByRole('heading',{name:/Alice notification/}).waitFor();
    rows.get('alice-real-id').nativePath = '/grain/alice-grain/folder?mode=read#comment';
    add('alice-update','alice','App updates available');
    rows.get('alice-update').nativePath = '/install';
    add('alice-admin','alice','Administration');
    rows.get('alice-admin').href = mainOrigin + '/admin';
    changed();
    for (const [key,title,kind] of [['stats','Share usage statistics','stats'],['referrals','Referral update','referrals'],['identity','Account identities have changed','identity']]) {
      add(key,'alice',title); rows.get(key).nativeAction = kind;
    }
    changed();
    await page.getByRole('button',{name:'Share usage statistics',exact:true}).click();
    await page.getByText('Not yet chosen', {exact:true}).waitFor();
    reportingAllowed = false;
    await page.getByRole('button',{name:'Enable reporting',exact:true}).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Administrator access is required.');
    assert.ok(rows.has('stats'), 'a denied write must not dismiss the notice');
    reportingAllowed = true;
    await page.getByRole('button',{name:'Disable reporting',exact:true}).click();
    await page.getByText('Reporting preference saved.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await serveProbe(page, './result-probe.ts', 'result-probe.js');
    assert.equal(await page.evaluate(async ()=>(await import('/result-probe.js')).checkResults()),true,'catalog, factory validation and query denials are typed');
    await serveProbe(page, './notification-probe.ts', 'notification-probe.js');
    assert.deepEqual(await page.evaluate(() => import('/notification-probe.js').then(probe => probe.checkAuthority())),
      {referrals:true,wrongKind:true,missing:true,otherAccount:true,foreignDismiss:true,foreignRead:true,emptyRead:true,missingDismiss:true});
    await page.getByRole('button',{name:'Referral update',exact:true}).click();
    await page.getByText('Completed person',{exact:true}).waitFor();
    await expect.poll(() => rows.get('referrals').unread).toBe(false);
    assert.equal(rows.get('identity').unread,true,'Opening a notice must not read other notices');
    assert.equal(rows.get('bob-real-id').unread,true,'Opening a notice must not read another account’s notices');
    await page.getByText('Pending person',{exact:true}).waitFor();
    await expect(page.getByRole('dialog').locator('li .avatar img')).toHaveCount(2);
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await page.getByRole('button',{name:'Account identities have changed',exact:true}).click();
    await page.getByText(/No action is required for this notice/).waitFor();
    await page.getByRole('button',{name:'Close',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Reconnect',exact:true}).count(),0);
    rows.delete('referrals'); rows.delete('identity'); changed();
    rows.get('alice-admin').ongoing = true; changed();
    await page.getByRole('button',{name:'Cancel activity for Administration'}).waitFor();
    const datePositions = await page.locator('.notification-item time').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().x));
    assert.ok(datePositions.every(x => Math.abs(x-datePositions[0]) < 1),'Dates align even when action buttons have different labels');
    const notificationCount = context.pages().length;
    await expect(page.getByRole('link',{name:'Open grain',exact:true})).toHaveAttribute('href','/grain/alice-grain/folder?mode=read#comment');
    await expect(page.getByRole('link',{name:'Open in main shell ↗',exact:true})).toHaveAttribute('href',mainOrigin+'/admin');
    await page.getByRole('link',{name:'Open grain',exact:true}).click();
    await page.waitForURL('**/grain/alice-grain/folder?mode=read#comment');
    await expect.poll(() => rows.get('alice-real-id').unread).toBe(false);
    assert.equal(rows.get('alice-update').unread,true);
    await page.frameLocator('iframe').getByRole('heading',{name:'Embedded test grain'}).waitFor();
    assert.equal(new URL(await page.locator('iframe').getAttribute('src')).searchParams.get('path'),'/folder?mode=read#comment');
    await page.locator('.open-grains li.current button').click();
    await page.getByRole('link',{name:'Notifications',exact:true}).click();
    await page.getByRole('link',{name:'Review updates',exact:true}).click();
    await page.waitForURL('**/install');
    await page.getByRole('heading',{name:'Available updates',exact:true}).waitFor();
    assert.equal(context.pages().length,notificationCount,'native notification navigation must not open legacy windows');
    rows.delete('alice-update'); rows.delete('alice-admin'); delete rows.get('alice-real-id').nativePath; changed();
    await page.getByRole('link',{name:'Notifications',exact:true}).click();

    await page.getByRole('button', {name:'Account: Alice',exact:true}).click();
    await page.getByRole('link', {name:'Account',exact:true}).click();
    await expect(page).toHaveTitle('Account · Sandstorm');
    await expect(page.locator('.route-content')).toBeFocused();
    const settings = page.getByRole('region',{name:'Login methods'});
    await settings.getByText('second@example.test',{exact:true}).waitFor();
    await settings.getByRole('button',{name:'Make primary',exact:true}).click();
    await expect(settings.getByRole('listitem').filter({has:page.getByText('second@example.test',{exact:true})})).toContainText('Primary');
    await expect(settings.getByRole('button',{name:'Remove',exact:true})).toBeDisabled();
    await settings.getByLabel('Add an email address').fill('new@example.test');
    await settings.getByRole('button',{name:'Send verification code'}).click();
    await settings.getByLabel('Verification code for new@example.test').fill('123456');
    await settings.getByRole('button',{name:'Verify email',exact:true}).click();
    const credential = settings.getByRole('listitem').filter({has:page.getByText('new@example.test',{exact:true})});
    await credential.getByRole('button',{name:'Remove',exact:true}).click();
    await credential.getByRole('button',{name:'Confirm removal'}).click();
    await expect(credential).toHaveCount(0);
    assert.ok(accountCalls.includes('verifyEmail'));
    await settings.getByRole('button',{name:'Link Google account',exact:true}).click();
    await settings.getByText('google fixture',{exact:true}).waitFor();
    await settings.getByRole('button',{name:'Link GitHub account',exact:true}).click();
    await settings.getByText('github fixture',{exact:true}).waitFor();
    await settings.getByRole('button',{name:'Link OpenID Connect account',exact:true}).click();
    await settings.getByText('oidc fixture',{exact:true}).waitFor();
    await settings.getByRole('button',{name:'Link SAML account',exact:true}).click();
    await settings.getByText('saml fixture',{exact:true}).waitFor();


    await expect(page.getByLabel('Display name', {exact:true})).toHaveValue('Alice');
    await page.getByLabel('Choose an image',{exact:true}).setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('not an image')});
    await expect(page.locator('.picture [role=alert]')).toContainText('could not be opened');
    await expect(page.getByRole('button',{name:'Upload picture',exact:true})).toBeDisabled();
    const source = await page.evaluate(async () => {
      const canvas=document.createElement('canvas'); canvas.width=900; canvas.height=600;
      const ctx=canvas.getContext('2d'); const pixels=ctx.createImageData(900,600);
      for (let i=0;i<pixels.data.length;i+=4) { pixels.data[i]=Math.random()*255; pixels.data[i+1]=Math.random()*255; pixels.data[i+2]=Math.random()*255; pixels.data[i+3]=255; }
      ctx.putImageData(pixels,0,0);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    assert.ok(Buffer.from(source,'base64').length > 65536);
    await page.getByLabel('Choose an image',{exact:true}).setInputFiles({name:'avatar.png',mimeType:'image/png',buffer:Buffer.from(source,'base64')});
    const thumbnail = page.getByRole('img',{name:'New avatar preview'});
    await expect(thumbnail).toBeVisible();
    assert.equal(uploadedPicture,undefined,'Choosing an image does not upload it');
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await expect(thumbnail).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Upload picture',exact:true})).toBeDisabled();
    await page.getByLabel('Choose an image',{exact:true}).setInputFiles({name:'avatar.png',mimeType:'image/png',buffer:Buffer.from(source,'base64')});
    await expect(thumbnail).toBeVisible();
    profiles.alice = {...profiles.alice,name:'Remote avatar edit'}; changed();
    await page.getByText('The profile was updated by someone else.',{exact:true}).waitFor();
    await expect(thumbnail).toBeVisible();
    profiles.alice = {...profiles.alice,name:'Alice'}; changed();
    await expect(page.getByText('The profile was updated by someone else.',{exact:true})).toHaveCount(0);
    const previewBytes = Buffer.from((await thumbnail.getAttribute('src')).split(',')[1],'base64');
    await page.getByRole('button',{name:'Upload picture',exact:true}).click();
    await page.getByText('Profile picture updated.',{exact:true}).waitFor();
    assert.ok(uploadedPicture.equals(previewBytes),'Uploaded bytes must exactly match the preview');
    await expect(thumbnail).toHaveCount(0);
    const dimensions = await page.evaluate(async base64 => {
      const bytes=Uint8Array.from(atob(base64), c=>c.charCodeAt(0));
      const image=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));
      const result=[image.width,image.height]; image.close(); return result;
    },uploadedPicture.toString('base64'));
    assert.deepEqual(dimensions,[512,512]);
    await expect(page.locator('.picture [role=alert]')).toHaveCount(0);
    await expect(page.getByText('The profile was updated by someone else.',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('img',{name:'Current avatar'})).toHaveAttribute('src',profiles.alice.pictureUrl);
    await expect(page.locator('.trigger .avatar img')).toHaveAttribute('src',profiles.alice.pictureUrl);
    assert.equal(profiles.bob.pictureUrl,undefined);
    await page.getByLabel('Handle', {exact:true}).fill('reserved_handle');
    await page.getByRole('button', {name:'Save profile',exact:true}).click();
    await expect(page.getByRole('alert')).toHaveText('That handle cannot be used.');
    assert.equal(profiles.alice.handle, 'alice', 'rejected profile edits do not change persisted values');
    await page.getByLabel('Display name', {exact:true}).fill('Alice renamed');
    await page.getByLabel('Handle', {exact:true}).fill('alice_renamed');
    await page.getByLabel('Pronouns', {exact:true}).selectOption('female');
    await page.getByRole('button', {name:'Save profile',exact:true}).click();
    await page.getByText('Profile saved.', {exact:true}).waitFor();
    await page.getByRole('button', {name:'Account: Alice renamed',exact:true}).waitFor();
    assert.equal(profiles.bob.name,'Bob');
    assert.equal(profiles.alice.pronoun,'female', 'typed pronouns map to the canonical profile option');
    await page.reload();
    await expect(page.getByLabel('Display name', {exact:true})).toHaveValue('Alice renamed');
    await expect(page.getByRole('button',{name:'Refresh',exact:true})).toHaveCount(0);
    await page.getByLabel('Display name',{exact:true}).fill('Unsaved draft');
    profiles.alice = {name:'Legacy edit',handle:'alice',pronoun:'neutral'}; changed();
    await page.getByText('The profile was updated by someone else.',{exact:true}).waitFor();
    await expect(page.getByLabel('Display name',{exact:true})).toHaveValue('Unsaved draft');
    await page.getByRole('button', {name:'Refresh',exact:true}).click();
    await expect(page.getByLabel('Display name', {exact:true})).toHaveValue('Legacy edit');
    await page.getByLabel('Display name', {exact:true}).fill('Alice');
    await page.getByRole('button', {name:'Save profile',exact:true}).click();
    await page.getByText('Profile saved.', {exact:true}).waitFor();
    await page.getByRole('link', {name:'Apps',exact:true}).click();
    await page.getByRole('heading', {name:'All apps'}).waitFor();
    assert.equal(new URL(page.url()).pathname,'/apps');
    await expect(page).toHaveTitle('Apps · Sandstorm');
    await expect(page.locator('.route-content')).toBeFocused();
    await expect(page.getByRole('link', {name:'Apps',exact:true})).toHaveAttribute('aria-current','page');
    await expect(page.getByRole('heading',{name:'Most used',exact:true})).toBeVisible();
    await expect(page.locator('[aria-labelledby=installed-apps-title] .app-tile').first()).toHaveAttribute('aria-label','Install from App Market');
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-apps.png',fullPage:true});
    await page.getByRole('link',{name:'Install from App Market',exact:true}).click();
    await expect(page).toHaveTitle('Install app · Sandstorm');
    const market = new URL(await page.getByRole('link',{name:'Browse app market'}).getAttribute('href'));
    assert.equal(market.searchParams.get('host'),new URL(page.url()).origin);
    await page.getByRole('button',{name:'Review update'}).click();
    await page.reload();
    installPermissions.canInstall = false;
    installPermissions.installReason = 'An invitation is required to install apps.';
    await expect(page.getByRole('button',{name:'Download app',exact:true})).toBeDisabled();
    await expect(page.getByText(installPermissions.installReason,{exact:true})).toBeVisible();
    assert.equal(installCalls.includes('download'), false);
    installPermissions.canInstall = true;
    installPermissions.installReason = '';
    await page.getByRole('button',{name:'Download app',exact:true}).click();
    await page.getByRole('button',{name:'Install app',exact:true}).waitFor();
    assert.equal(installState.installed,false,'download does not install without confirmation');
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-install.png',fullPage:true});
    await page.getByRole('button',{name:'Install app',exact:true}).click();
    await expect(page.getByRole('alert')).toHaveText('Your account needs an invitation before you can install apps. Ask the server administrator to grant you access.');
    assert.equal(installState.installed,false);
    denyInstall = false;
    await page.getByRole('button',{name:'Install app',exact:true}).click();
    await page.getByText('Installed for your account.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Upgrade 2 existing grains',exact:true}).click();
    await expect(page.getByRole('button',{name:'Upgrade 2 existing grains',exact:true})).toHaveCount(0);
    await page.reload();
    await page.getByText('Installed for your account.',{exact:true}).waitFor();
    assert.equal(installCalls.filter(op=>op==='confirm').length,2);
    assert.equal(installCalls.filter(op=>op==='upgrade').length,1);
    await page.getByRole('button',{name:'Back to app installation'}).click();
    await page.route('**/upload/test-token',route => route.fulfill({status:200,body:installId,headers:{'Access-Control-Allow-Origin':'*'}}));
    await page.getByLabel('Upload an SPK').setInputFiles({name:'test.spk',mimeType:'application/octet-stream',buffer:Buffer.from('test package')});
    await page.getByText('Installed for your account.',{exact:true}).waitFor();
    assert.equal(installCalls.filter(op=>op==='upload').length,1);
    await page.getByRole('link', {name:'Apps',exact:true}).click();

    await page.reload();
    await page.getByRole('link', {name:'Open Test app',exact:true}).first().click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/apps/test-app');
    await expect(page.locator('.grain-item')).toHaveCount(1);
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-app-detail.png',fullPage:true});
    await page.reload();
    await expect(page.locator('.grain-item')).toHaveCount(1);
    await page.getByRole('button', {name:'New grain',exact:true}).click();
    await page.getByLabel('Installed app action').selectOption('alice-action');
    await page.getByLabel('Grain title').fill('Denied creation');
    await page.getByRole('button', {name:'Create grain',exact:true}).click();
    await expect(page.getByRole('alert')).toHaveText('You must be invited to create grains.');
    assert.equal(creations,0,'a policy denial must not create or replay a grain');
    await expect(page.getByText('The request was not retried. Check your grains before creating another.')).toHaveCount(0);
    await page.getByRole('button', {name:'Dismiss',exact:true}).click();
    await page.getByLabel('Grain title').fill('Created in Rust');
    await page.getByRole('button', {name:'Create grain',exact:true}).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/grain/alice-created');
    await page.locator('.open-grains li.current button').waitFor();
    const signedShare = await context.newPage();
    await signedShare.goto(proxy.origin+'/shared/valid-share');
    await signedShare.getByRole('button',{name:'Open as Alice',exact:true}).waitFor();
    await expect(signedShare.getByRole('button',{name:'Open as Alice',exact:true}).locator('.avatar img')).toHaveAttribute('src',fixtureAvatar);
    assert.equal(await signedShare.locator('iframe').count(),0,'signed-in identity must not be revealed automatically');
    await signedShare.getByRole('button',{name:'Open anonymously',exact:true}).click();
    await signedShare.frameLocator('iframe').getByRole('heading',{name:'Embedded test grain'}).waitFor();
    assert.equal(sharedOpens.at(-1).accountId,null);
    await signedShare.reload();
    await signedShare.getByRole('button',{name:'Open as Alice',exact:true}).click();
    await signedShare.frameLocator('iframe').getByRole('heading',{name:'Embedded test grain'}).waitFor();
    assert.equal(sharedOpens.at(-1).accountId,'alice');
    await signedShare.screenshot({path:'/tmp/sandstorm-rust-ui-shared.png'});
    await signedShare.close();
    await expect.poll(()=>liveGrains.size).toBe(1);
    assert.equal(creations,1);
    await page.locator('.open-grains li.current button').click();
    failCreation = true;
    await page.getByRole('link', {name:'Apps',exact:true}).click();
    await expect(page.getByText('Grain created.', {exact:true})).toHaveCount(0);
    await expect(page.getByRole('button', {name:'Open created grain',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button', {name:'Create another grain',exact:true})).toHaveCount(0);
    await page.getByRole('link', {name:'Open Test app',exact:true}).first().click();
    await page.getByRole('button', {name:'New grain',exact:true}).click();
    await page.getByLabel('Installed app action').selectOption('alice-action');
    await page.getByLabel('Grain title').fill('Created in Rust');
    await page.getByRole('button', {name:'Create grain',exact:true}).click();
    await page.getByText('The request was not retried. Check your grains before creating another.').waitFor();
    await expect(page.getByRole('button', {name:'Create grain',exact:true})).toBeDisabled();
    assert.equal(creations,2);
    await page.getByRole('button', {name:'Check grains',exact:true}).click();
    assert.equal(creations,2);
    failCreation = false;
    await page.getByRole('link', {name:'Apps',exact:true}).click();
    await page.getByText('The request was not retried. Check your grains before creating another.').waitFor();
    await expect(page.getByRole('button', {name:'Create grain',exact:true})).toHaveCount(0);
    await page.getByRole('link', { name: 'Grains', exact: true }).click();
    await page.getByRole('link', { name: 'Alice grain', exact: true }).waitFor();
    let releaseList;
    const listGate = new Promise(resolve => { releaseList = resolve; });
    await page.route('**/auth/session', async route => { await listGate; await route.continue(); });
    await page.reload({waitUntil:'domcontentloaded'});
    await page.getByRole('status').filter({hasText:'Connecting to Sandstorm…'}).waitFor();
    await expect(page.getByText('You have no grains to show.', {exact:true})).toHaveCount(0);
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-grains-loading.png'});
    releaseList();
    await page.getByRole('link', { name: 'Alice grain', exact: true }).waitFor();
    await page.unroute('**/auth/session');
    await expect(page.locator('.grain-skeleton')).toHaveCount(0);
    assert.equal(new URL(page.url()).pathname, '/grains');
    assert.equal(await page.getByRole('link', { name: 'Alice grain', exact: true }).getAttribute('href'), '/grain/alice-grain');
    assert.equal(await page.getByRole('link', { name: 'Bob grain', exact: true }).count(), 0);
    await page.locator('.grain-item').getByText('Owned by you', { exact: true }).waitFor();
    assert.equal(await page.locator('.grain-item .grain-name').first().innerText(), 'Zebra shared');
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-grains.png',fullPage:true});
    await page.getByLabel('Sort by').selectOption('title');
    assert.equal(await page.locator('.grain-item .grain-name').first().innerText(), 'Alice grain');
    await page.getByLabel('Filter shown grains').fill('editor');
    await expect(page.locator('.grain-item')).toHaveCount(1);
    await page.getByLabel('Filter shown grains').fill('');
    await page.getByLabel('Show', { exact: true }).selectOption('shared');
    assert.equal(await page.locator('.grain-item .grain-name').innerText(), 'Zebra shared');
    await page.getByLabel('Show', { exact: true }).selectOption('all');
    await page.getByLabel('Filter shown grains').fill('nothing matches');
    await page.getByText('No matching grains.', { exact: true }).waitFor();
    await page.getByLabel('Filter shown grains').fill('');
    await serveProbe(page, './resource-probe.ts', 'resource-probe.js');
    assert.equal(await page.evaluate(() => import('/resource-probe.js').then(probe => probe.resources())), true,
      'action selectors are account-bound and view references open independent reusable leases');
    await expect.poll(() => liveGrains.size).toBe(0);
    await serveProbe(page, './grain-session-probe.ts', 'grain-session-probe.js');
    await page.evaluate(() => import('/grain-session-probe.js').then((probe) => probe.open()));
    await expect.poll(() => liveGrains.size).toBe(1);
    await page.evaluate(() => import('/grain-session-probe.js').then((probe) => probe.release()));
    await expect.poll(() => liveGrains.size).toBe(0);
    await page.evaluate(() => import('/grain-session-probe.js').then((probe) => probe.disconnect()));
    assert.equal(await page.evaluate(() => import('/grain-session-probe.js').then(probe => probe.closedSharing())), true,
      'retained sharing capabilities lose authority when their grain closes');
    await expect.poll(() => liveGrains.size).toBe(0);

    // Bulk management, explicit permanent deletion, partial failure, and a
    // legacy-side change arriving through the existing list subscription.
    const management=await context.newPage();
    await management.goto(proxy.origin+'/grains');
    await management.getByRole('link',{name:'Alice grain',exact:true}).click();
    await management.frameLocator('iframe').getByRole('heading',{name:'Embedded test grain'}).waitFor();
    await management.getByRole('link',{name:'Grains',exact:true}).click();
    await management.getByLabel('Sort by',{exact:true}).selectOption('title');
    await management.getByRole('checkbox',{name:'Select all shown grains'}).check();
    managementFailure=true;
    await management.getByRole('button',{name:'Move to Trash',exact:true}).click();
    await expect(management.getByRole('alert')).toContainText('You cannot change this grain');
    await expect(management.getByText('1 grain moved to Trash.',{exact:true})).toBeVisible();
    managementFailure=false;
    await management.getByRole('checkbox',{name:'Select Zebra shared',exact:true}).check();
    await management.getByRole('button',{name:'Move to Trash',exact:true}).click();
    await expect(management.locator('iframe')).toHaveCount(0);
    await expect(management.getByRole('checkbox',{name:'Select Zebra shared',exact:true})).toHaveCount(0);
    await management.getByRole('link',{name:'Trash',exact:true}).click();
    await management.getByRole('checkbox',{name:'Select all shown grains'}).check();
    await management.getByRole('button',{name:'Restore',exact:true}).click();
    await expect(management.getByText('2 grains restored.',{exact:true})).toBeVisible();
    await management.getByRole('link',{name:'Grains',exact:true}).click();
    await management.getByRole('checkbox',{name:'Select all shown grains'}).check();
    await management.getByRole('button',{name:'Move to Trash',exact:true}).click();
    await expect(management.getByText('2 grains moved to Trash.',{exact:true})).toBeVisible();
    await management.getByRole('link',{name:'Trash',exact:true}).click();
    await management.reload();
    await management.getByRole('checkbox',{name:'Select all shown grains'}).check();
    await management.getByRole('button',{name:'Delete permanently',exact:true}).click();
    const removeDialog=management.getByRole('dialog',{name:'Delete permanently?',exact:true});
    await expect(removeDialog).toContainText('Forget access');
    await removeDialog.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(grainStates.get('alice-grain'),'trashed');
    await management.getByRole('button',{name:'Delete permanently',exact:true}).click();
    await removeDialog.getByRole('button',{name:'Confirm permanent deletion',exact:true}).click();
    await expect(management.getByText('Trash is empty.',{exact:true})).toBeVisible();
    assert.equal(grainStates.get('alice-extra'),'unavailable');
    grainStates.clear();changed();
    await management.getByRole('link',{name:'Grains',exact:true}).click();
    await management.getByRole('link',{name:'Alice grain',exact:true}).click();
    await management.frameLocator('iframe').getByRole('heading',{name:'Embedded test grain'}).waitFor();
    await management.getByRole('link',{name:'Grains',exact:true}).click();
    grainStates.set('alice-grain','trashed');
    for(const [handle,id] of grainSessions)if(id==='alice-grain')liveGrains.delete(handle);
    changed();
    await expect(management.getByRole('link',{name:'Alice grain',exact:true})).toHaveCount(0);
    await expect(management.locator('iframe')).toHaveCount(0,{timeout:20000});
    await expect.poll(()=>management.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('sandstorm.workspace.grains.')).flatMap(key=>JSON.parse(sessionStorage.getItem(key))).some(tab=>tab.id==='alice-grain'))).toBe(false);
    grainStates.clear();changed();
    await management.reload();
    await management.getByRole('link',{name:'Alice grain',exact:true}).waitFor();
    await expect(management.locator('iframe')).toHaveCount(0);
    await management.close();

    // Each browser tab owns its reload workspace; shared authentication does
    // not share the open-grain list.
    const workspacePage=await context.newPage();
    await workspacePage.goto(proxy.origin+'/grains');
    await expect(workspacePage.locator('iframe')).toHaveCount(0);
    await workspacePage.getByRole('link',{name:'Alice grain',exact:true}).click();
    await workspacePage.frameLocator('iframe').getByRole('heading',{name:'Embedded test grain'}).waitFor();
    await workspacePage.frameLocator('iframe').locator('body').evaluate(()=>parent.postMessage({setPath:'/saved?edit=1#part'},'*'));
    await workspacePage.waitForURL('**/grain/alice-grain/saved?edit=1#part');
    await workspacePage.getByRole('link',{name:'Grains',exact:true}).click();
    await workspacePage.getByRole('link',{name:'Zebra shared',exact:true}).click();
    await expect(workspacePage.locator('iframe')).toHaveCount(2);
    const oldFrames=await workspacePage.locator('iframe').evaluateAll(frames=>frames.map(frame=>frame.src));
    await workspacePage.reload();
    await expect(workspacePage.locator('iframe')).toHaveCount(2);
    await expect(workspacePage.locator('iframe:visible')).toHaveAttribute('title','Zebra shared');
    await expect(workspacePage.getByRole('link',{name:'Switch to Alice grain'})).toHaveAttribute('href','/grain/alice-grain/saved?edit=1#part');
    const restoredFrames=await workspacePage.locator('iframe').evaluateAll(frames=>frames.map(frame=>frame.src));
    assert.ok(restoredFrames.every(url=>!oldFrames.includes(url)),'reload establishes fresh sessions');
    await workspacePage.getByRole('button',{name:'Close Alice grain',exact:true}).click();
    await workspacePage.getByRole('link',{name:'Notifications',exact:true}).click();
    await workspacePage.reload();
    await expect(workspacePage.locator('iframe')).toHaveCount(1);
    assert.equal(new URL(workspacePage.url()).pathname,'/notifications');
    await expect(workspacePage.locator('iframe:visible')).toHaveCount(0);
    await expect(workspacePage.getByRole('link',{name:'Switch to Alice grain'})).toHaveCount(0);
    await expect(page.locator('iframe')).toHaveCount(0);
    await workspacePage.close();
    await expect.poll(()=>liveGrains.size).toBe(0);

    stallAssets=true;
    await page.getByRole('link',{name:'Alice grain',exact:true}).click();
    await page.frameLocator('iframe').getByRole('heading',{name:'Embedded test grain'}).waitFor();
    await expect(page.locator('.frame-loading')).toHaveCount(0);
    assert.notEqual(await page.frames().find(frame=>frame.url().startsWith(grainOrigin)).evaluate(()=>document.readyState),'complete','gateway readiness reveals the frame before assets finish');
    releaseAssets();
    await page.getByRole('button',{name:'Close Alice grain',exact:true}).click();
    await page.getByRole('link',{name:'Grains',exact:true}).click();
    await page.getByRole('link',{name:'Alice grain',exact:true}).waitFor();

    let releaseFrame;
    const frameGate = new Promise(resolve => { releaseFrame = resolve; });
    await page.route(grainOrigin+'/**', async route => { await frameGate; await route.continue(); });
    await page.getByRole('link', { name: 'Alice grain', exact: true }).click();
    await page.getByRole('status').filter({hasText:'Loading app…'}).waitFor();
    await expect(page.locator('iframe')).toHaveAttribute('aria-busy','true');
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-grain-loading.png'});
    await page.getByText('Still loading this app…', {exact:true}).waitFor({timeout:20000});
    await page.getByRole('button', {name:'Show app',exact:true}).click();
    await expect(page.locator('.frame-loading')).toHaveCount(0);
    releaseFrame();
    await page.frameLocator('iframe').getByRole('heading', { name: 'Embedded test grain' }).waitFor();
    await page.unroute(grainOrigin+'/**');
    await expect(page.locator('iframe')).toHaveAttribute('aria-busy','false');
    assert.equal(liveGrains.size, 1);
    assert.equal(new URL(page.url()).pathname, '/grain/alice-grain');
    const originalUrl = await page.locator('iframe').getAttribute('src');
    await page.frames().find(frame => frame.url().startsWith(grainOrigin)).evaluate(() =>
      parent.postMessage({setPath:'/folder/document?mode=edit#heading'}, '*'));
    await page.waitForURL('**/grain/alice-grain/folder/document?mode=edit#heading');
    await expect(page.locator('iframe')).toHaveAttribute('aria-busy','false');
    await expect(page.locator('.frame-loading')).toHaveCount(0);
    await page.reload();
    await page.frameLocator('iframe').getByRole('heading', { name: 'Embedded test grain' }).waitFor();
    const restoredUrl = new URL(await page.locator('iframe').getAttribute('src'));
    assert.equal(restoredUrl.searchParams.get('path'), '/folder/document?mode=edit#heading');
    assert.notEqual(restoredUrl.searchParams.get('sessionid'), new URL(originalUrl).searchParams.get('sessionid'));
    assert.equal(page.url().includes('sessionid'), false);
    await page.goBack();
    await page.getByRole('link', { name: 'Alice grain', exact: true }).waitFor();
    await expect.poll(() => liveGrains.size).toBe(1);
    await page.goForward();
    await page.frameLocator('iframe').getByRole('heading', { name: 'Embedded test grain' }).waitFor();
    const app = page.frames().find((frame) => frame.url().startsWith(grainOrigin));
    await app.evaluate(() => { window.renameFrameMarker = 'still here'; });
    await app.getByLabel('App state').fill('background draft');
    const firstSession = await page.locator('iframe').getAttribute('src');
    await page.getByRole('link', {name:'Grains',exact:true}).click();
    await page.getByRole('link', { name: 'Zebra shared', exact: true }).click();
    await expect(page.locator('iframe')).toHaveCount(2);
    await expect.poll(() => liveGrains.size).toBe(2);
    await expect(page.locator('iframe:visible')).toHaveAttribute('title','Zebra shared');
    const secondSession = await page.locator('iframe:visible').getAttribute('src');
    await page.frameLocator('iframe:visible').getByLabel('App state').fill('second draft');
    await app.evaluate(() => parent.postMessage({setPath:'/background-path'}, '*'));
    await expect(page.getByRole('link',{name:'Switch to Alice grain'})).toHaveAttribute('href','/grain/alice-grain/background-path');
    assert.equal(new URL(page.url()).pathname, '/grain/alice-extra');
    await page.getByRole('link',{name:'Switch to Alice grain'}).click();
    await expect(page.locator('iframe:visible')).toHaveAttribute('src',firstSession);
    assert.equal(await app.getByLabel('App state').inputValue(),'background draft');
    await page.getByRole('link',{name:'Switch to Zebra shared'}).click();
    await expect(page.locator('iframe:visible')).toHaveAttribute('src',secondSession);
    await expect(page.frameLocator('iframe:visible').getByLabel('App state')).toHaveValue('second draft');
    await expect.poll(() => page.getByRole('link',{name:'Switch to Zebra shared'}).locator('img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
    const frameBox = await page.locator('iframe:visible').boundingBox();
    const headerBox = await page.locator('header').boundingBox();
    const sideBox = await page.getByRole('complementary').boundingBox();
    assert.equal(frameBox.x,sideBox.width);
    assert.equal(frameBox.y,headerBox.height);
    assert.equal(frameBox.width,page.viewportSize().width-sideBox.width);
    assert.equal(frameBox.height,page.viewportSize().height-headerBox.height);
    const accountTrigger = page.getByRole('button',{name:'Account: Alice',exact:true});
    await accountTrigger.click();
    const accountBounds = await page.locator('.account-menu').boundingBox();
    const triggerBounds = await accountTrigger.boundingBox();
    assert.ok(accountBounds.y >= triggerBounds.y + triggerBounds.height);
    assert.ok(accountBounds.y < triggerBounds.y + triggerBounds.height + 12);
    assert.ok(accountBounds.y + accountBounds.height <= page.viewportSize().height);
    await page.keyboard.press('Escape');
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-workspace.png'});
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();
    const toggleBox = await page.getByRole('button',{name:'Expand sidebar',exact:true}).boundingBox();
    assert.ok(toggleBox.x >= 0 && toggleBox.x+toggleBox.width <= 56, 'Collapsed toggle stays fully visible');
    const mobileFrame = await page.locator('iframe:visible').boundingBox();
    assert.equal(mobileFrame.x,56);
    assert.equal(mobileFrame.y,(await page.locator('header').boundingBox()).height);
    assert.equal(mobileFrame.y+mobileFrame.height,844);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-workspace-mobile.png'});
    await page.setViewportSize({width:1280,height:720});
    await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();
    // Losing one background lease must not discard another grain's iframe state.
    liveGrains.delete(Number(new URL(secondSession).searchParams.get('sessionid')));
    await expect(page.locator('iframe')).toHaveCount(1, {timeout:20000});
    assert.equal(await app.getByLabel('App state').inputValue(), 'background draft');
    await expect(page.getByRole('alert')).toContainText('This grain session ended');
    await page.getByRole('button',{name:'Reopen grain',exact:true}).click();
    await expect(page.locator('iframe')).toHaveCount(2);
    await expect.poll(() => liveGrains.size).toBe(2);
    await page.locator('.open-grains li.current button').click();
    await expect.poll(() => liveGrains.size).toBe(1);
    await expect(page.locator('iframe')).toHaveCount(1);
    await page.getByRole('link',{name:'Switch to Alice grain'}).click();
    assert.equal(await app.evaluate(() => window.renameFrameMarker),'still here');
    await page.getByRole('link',{name:'Notifications',exact:true}).hover();
    await expect(page.locator('.grain-title:visible .rename-action')).toHaveCSS('opacity','0');
    await page.locator('.grain-title:visible').hover();
    await expect(page.locator('.grain-title:visible .rename-action')).toHaveCSS('opacity','1');
    const currentRow = page.locator('.open-grains li.current');
    await expect(currentRow.locator('.close-grain')).toHaveCSS('opacity','0');
    await currentRow.hover();
    await expect(currentRow.locator('.close-grain')).toHaveCSS('opacity','1');
    await expect(currentRow.locator('a span')).toHaveCSS('text-overflow','ellipsis');
    const grainIcon = await currentRow.locator('svg, img').first().boundingBox();
    const navIcon = await page.getByRole('link',{name:'Grains',exact:true}).locator('svg').boundingBox();
    assert.equal(grainIcon.x,navIcon.x);
    assert.equal(grainIcon.width,navIcon.width);
    assert.equal(await page.locator('header').getByRole('link',{name:/Main shell/}).count(),0);
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-grain.png',fullPage:true});
    await page.locator('.grain-title:visible').hover();
    await page.getByRole('button', {name:'Rename grain',exact:true}).click();
    const dialog = page.getByRole('dialog', {name:'Rename grain',exact:true});
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel('Grain title', {exact:true})).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', {name:'Cancel rename',exact:true})).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Grain title', {exact:true})).toBeFocused();
    assert.equal(await dialog.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-dialog.png'});
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', {name:'Rename grain',exact:true})).toBeFocused();
    await page.locator('.grain-title:visible').hover();
    await page.getByRole('button', {name:'Rename grain',exact:true}).click();

    await page.getByLabel('Grain title', {exact:true}).fill('Denied rename');
    await page.getByRole('button', {name:'Save title',exact:true}).click();
    await expect(dialog.getByRole('alert')).toHaveText('You cannot rename this grain.');
    assert.equal(grainTitles.alice,undefined,'a denied rename must not change the title');
    await page.getByLabel('Grain title', {exact:true}).fill('Renamed in Rust with a long title that must fit in the sidebar');
    await page.getByRole('button', {name:'Save title',exact:true}).click();
    await page.getByRole('heading', {name:'Renamed in Rust with a long title that must fit in the sidebar',exact:true}).waitFor();
    assert.equal(grainTitles.alice,'Renamed in Rust with a long title that must fit in the sidebar');
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-long-title.png'});
    assert.ok(await page.locator('.open-grains li.current a span').evaluate(label => label.scrollWidth > label.clientWidth));
    assert.equal(await app.evaluate(() => window.renameFrameMarker),'still here');
    grainTitles.alice = 'Legacy rename'; changed();
    await page.getByRole('heading', {name:'Legacy rename',exact:true}).waitFor();
    assert.equal(await app.evaluate(() => window.renameFrameMarker),'still here');
    await page.locator('.grain-title:visible').hover();
    await page.getByRole('button', {name:'Rename grain',exact:true}).click();
    await page.getByLabel('Grain title', {exact:true}).fill('Alice grain');
    await page.getByRole('button', {name:'Save title',exact:true}).click();
    await page.getByRole('heading', {name:'Alice grain',exact:true}).waitFor();

    const pathBeforeForged = page.url();
    await app.evaluate(() => parent.postMessage({setPath:'//untrusted.test/'}, '*'));
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(page.url(), pathBeforeForged);
    await app.getByLabel('App state').fill('keep this iframe alive');
    await page.evaluate((origin) => window.dispatchEvent(new MessageEvent('message', {
      origin, source: window, data: { setTitle: 'Forged title' },
    })), grainOrigin);
    assert.equal(await page.getByRole('heading', { name: 'Forged title' }).count(), 0);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://untrusted.test', source: document.querySelector('iframe').contentWindow,
      data: { setTitle: 'Wrong origin' },
    })));
    assert.equal(await page.getByRole('heading', { name: 'Wrong origin' }).count(), 0);
    await app.evaluate(() => parent.postMessage({ setTitle: 'App page title', setPath: '/document?x=1#section' }, '*'));
    await page.getByRole('heading', { name: 'App page title' }).waitFor();
    await app.evaluate(() => parent.postMessage({ getGrainTitle: {}, rpcId: 'title' }, '*'));
    await expect.poll(() => app.evaluate(() => window.reply?.grainTitle)).toBe('Alice grain');
    await app.evaluate(() => parent.postMessage({ getGrainTitle: {}, subscribe: true, rpcId:'subscribed-title' }, '*'));
    await expect.poll(() => app.evaluate(() => window.reply?.rpcId)).toBe('subscribed-title');
    grainTitles.alice = 'Owner rename'; changed();
    await expect.poll(() => app.evaluate(() => window.reply?.grainTitle)).toBe('Owner rename');
    grainTitles.alice = 'Alice grain'; changed();
    await expect.poll(() => app.evaluate(() => window.reply?.grainTitle)).toBe('Alice grain');
    await app.evaluate(() => parent.postMessage({ renderTemplate: { rpcId: 'template',
      template: '<script>window.injected=true</script> $API_TOKEN $API_HOST $GRAIN_TITLE_SLUG',
      clipboardButton: 'right', style: { color: '#123456' } } }, '*'));
    await expect.poll(() => app.evaluate(() => window.reply?.uri)).toContain('/offer-template.html#');
    const offered = await app.evaluate(() => {
      const reply = window.reply;
      const iframe = document.createElement('iframe'); iframe.id = 'offer'; iframe.src = reply.uri;
      document.body.appendChild(iframe);
      return reply;
    });
    assert.deepEqual(Object.keys(offered).sort(), ['rpcId', 'uri']);
    assert.equal(offered.uri.includes('sensitive'), false);
    const offer = app.frameLocator('#offer');
    await expect(offer.locator('#text')).toContainText('sensitive-template-token');
    await expect(offer.locator('#text')).toContainText('alice-grain');
    await expect(offer.getByRole('button', { name: 'Copy API instructions' })).toBeVisible();
    assert.equal(await app.evaluate(() => {
      try { return !!document.getElementById('offer').contentWindow.document.body; } catch { return false; }
    }), false, 'app must not read shell-origin token text');
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await app.evaluate(() => parent.postMessage({renderTemplate:{rpcId:'client',template:'Connect desktop client',clientapp:'DaVrOs'}}, '*'));
    await expect.poll(() => app.evaluate(() => window.reply?.rpcId)).toBe('client');
    const clientOffer = await app.evaluate(() => {
      const iframe = document.createElement('iframe'); iframe.id = 'client-offer'; iframe.src = window.reply.uri;
      document.body.appendChild(iframe);
      return window.reply;
    });
    assert.deepEqual(Object.keys(clientOffer).sort(), ['rpcId', 'uri']);
    assert.equal(clientOffer.uri.includes('sensitive'), false);
    const clientFrame = app.frameLocator('#client-offer');
    await expect(clientFrame.getByRole('link', {name:'Connect desktop client'})).toHaveAttribute('href',
      `clientapp-davros:https://${new URL(grainOrigin).host}#sensitive-template-token`);
    await expect(clientFrame.locator('#link')).toHaveAttribute('rel', 'noopener noreferrer');
    assert.equal(await app.evaluate(() => {
      try { return !!document.getElementById('client-offer').contentWindow.document.body; } catch { return false; }
    }), false, 'app must not read the desktop client credential');
    // Display options share the same canonical token; invalid schemes issue nothing.
    assert.equal(templates, 1);
    for (const clientapp of ['javascript:alert(1)', 'foo/bar', 'foo\\bar', 'foo\nbar', 42, {}]) {
      await app.evaluate(clientapp => parent.postMessage({renderTemplate:{rpcId:'invalid-client',template:'Connect',clientapp}}, '*'), clientapp);
      await expect.poll(() => app.evaluate(() => window.reply?.rpcId)).toBe('invalid-client');
      assert.match(await app.evaluate(() => window.reply.error), /Invalid template request/);
      await app.evaluate(() => { window.reply = null; });
    }
    assert.equal(templates, 1);
    await page.evaluate(uri => sessionStorage.removeItem('rustOfferTemplate:' + new URL(uri).hash.slice(1)), clientOffer.uri);
    await expect(clientFrame.locator('#link')).toHaveCount(0);
    await expect(clientFrame.locator('#text')).toContainText('expired');
    // Davros renders these simultaneously; token-specific host and password must match.
    await app.evaluate(() => {
      window.templateReplies = {};
      window.addEventListener('message', e => { if (e.data?.rpcId?.startsWith('davros-')) window.templateReplies[e.data.rpcId] = e.data; });
      const unauthenticated = { resources: { '/status.php': { type: 'text/json', language: 'en', body: '{"installed":true}' } },
        options: { dav: ['1', '2', '3', 'mkcol-extended'] } };
      for (const [id, template] of [['host','$API_HOST'],['user','$GRAIN_TITLE_SLUG'],['password','$API_TOKEN']]) {
        parent.postMessage({renderTemplate:{rpcId:'davros-'+id, template, unauthenticated,
          roleAssignment:{roleId:1,addPermissions:[false,true],removePermissions:[true]}, clipboardButton:'right'}}, '*');
      }
    });
    await expect.poll(() => app.evaluate(() => Object.keys(window.templateReplies).length)).toBe(3);
    const davrosReplies = await app.evaluate(() => window.templateReplies);
    for (const reply of Object.values(davrosReplies)) assert.ok(reply.uri, JSON.stringify(reply));
    assert.equal(templates, 2, 'three matching requests issue only one additional token');
    assert.deepEqual(templateOptions.at(-1), {
      petname:'connected external app',forSharing:false,
      roleAssignment:{roleId:1,addPermissions:[false,true],removePermissions:[true]},
      unauthenticated:{resources:{'/status.php':{type:'text/json',language:'en',body:'{"installed":true}'}},
        options:{dav:['1','2','3','mkcol-extended']}},
    });
    const records = await page.evaluate(replies => Object.values(replies).map(reply =>
      JSON.parse(sessionStorage.getItem('rustOfferTemplate:' + new URL(reply.uri).hash.slice(1)))), davrosReplies);
    assert.equal(new Set(records.map(record => record.token)).size, 1);
    assert.equal(new Set(records.map(record => record.host)).size, 1);

    // Native sharing stays in the trusted shell, including app-supplied paths.
    const pageCount = context.pages().length;
    await app.evaluate(() => { window.sharingMessages = []; addEventListener('message', event => window.sharingMessages.push(event.data));
      parent.postMessage({startSharing:{pathname:'/folder',hash:'#document'}}, '*'); });
    const sharingDialog = page.getByRole('dialog', {name:'Sharing',exact:true});
    await sharingDialog.getByLabel('Link label', {exact:true}).fill('Denied test link');
    await sharingDialog.getByRole('button', {name:'Create link',exact:true}).click();
    await expect(sharingDialog.getByRole('alert')).toHaveText('You cannot share this grain.');
    assert.equal(shareCreations, 0, 'permission denial must not create a token');
    await sharingDialog.getByLabel('Link label', {exact:true}).fill('Project team');
    await sharingDialog.getByLabel('Permissions', {exact:true}).selectOption('1');
    await sharingDialog.getByRole('button', {name:'Create link',exact:true}).click();
    await expect(sharingDialog.getByLabel('New sharing link', {exact:true})).toHaveValue(proxy.origin + '/shared/native-share-1/folder#document');
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-sharing.png'});
    assert.equal(shareCreations, 1);
    assert.equal(context.pages().length,pageCount,'sharing must not open a legacy window');
    assert.equal(JSON.stringify(await app.evaluate(() => window.sharingMessages)).includes('native-share-1'), false, 'bearer token stays out of app messages');
    assert.equal(await page.evaluate(() => JSON.stringify({...sessionStorage,...localStorage}).includes('native-share-1')), false);
    await expect(sharingDialog.getByRole('table')).toHaveCount(0);
    await sharingDialog.getByRole('tab', {name:'Create link',exact:true}).focus();
    await page.keyboard.press('ArrowRight');
    await expect(sharingDialog.getByRole('tab', {name:'Who has access',exact:true})).toHaveAttribute('aria-selected','true');
    await expect(sharingDialog.getByRole('table', {name:'Current access'})).toBeVisible();
    await expect(sharingDialog.locator('.recipient .avatar img')).toHaveAttribute('src',fixtureAvatar);
    await sharingDialog.getByText('Bob',{exact:true}).waitFor();
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-access.png'});
    await sharingDialog.getByRole('button', {name:'Edit',exact:true}).click();
    await sharingDialog.getByLabel('Edit label', {exact:true}).fill('Renamed link');
    await sharingDialog.getByLabel('Edit permissions', {exact:true}).selectOption('0');
    await sharingDialog.getByRole('button', {name:'Save changes',exact:true}).click();
    await sharingDialog.getByText('Renamed link',{exact:true}).waitFor();
    assert.equal(sharingGrants[0].role,'0');
    sharingGrants[0].role = 'custom';
    await sharingDialog.getByRole('button', {name:'Refresh sharing',exact:true}).click();
    await sharingDialog.getByText('Custom permissions',{exact:true}).waitFor();
    await sharingDialog.getByRole('button', {name:'Edit',exact:true}).click();
    await sharingDialog.getByLabel('Edit label', {exact:true}).fill('Custom grant renamed');
    await expect(sharingDialog.getByLabel('Edit permissions', {exact:true})).toHaveValue('custom');
    await sharingDialog.getByRole('button', {name:'Save changes',exact:true}).click();
    await sharingDialog.getByText('Custom grant renamed',{exact:true}).waitFor();
    assert.equal(sharingGrants[0].role,'custom','label edits preserve custom permission settings');
    await sharingDialog.getByRole('button', {name:'Revoke',exact:true}).click();
    assert.equal(sharingGrants.length,1,'revocation requires confirmation');
    await sharingDialog.getByRole('button', {name:'Confirm revoke',exact:true}).click();
    await expect(sharingDialog.getByRole('button', {name:'Revoke',exact:true})).toHaveCount(0);
    assert.equal(sharingGrants.length,0);
    await sharingDialog.getByRole('button', {name:'Done',exact:true}).click();
    await expect(sharingDialog).toHaveCount(0);
    await app.evaluate(() => parent.postMessage({startSharing:{pathname:'/%2e%2e/escape'}}, '*'));
    await expect(sharingDialog).toHaveCount(0);
    await page.getByRole('button', {name:'Who has access',exact:true}).click();
    await sharingDialog.getByText('Bob',{exact:true}).waitFor();
    await expect(sharingDialog.getByRole('button',{name:'Revoke',exact:true})).toHaveCount(0);
    await sharingDialog.getByRole('button', {name:'Done',exact:true}).click();
    await expect(sharingDialog).toHaveCount(0);

    // Native selection and embedded provider completion do not open a popup.
    const nativeDialog = page.getByRole('dialog',{name:'Connect an app',exact:true});
    for (const kind of ['identity','url']) {
      await app.evaluate(kind => parent.postMessage({powerboxRequest:{rpcId:'native-'+kind,query:['supported']}},'*'),kind);
      await expect(nativeDialog.getByRole('button',{name:'More options in main shell'})).toHaveCount(0);
      if (kind === 'identity') {
        await nativeDialog.getByRole('button',{name:'Disabled Google',exact:true}).click();
        await expect(nativeDialog.getByRole('status')).toContainText('An administrator must enable Google.');
        await expect(nativeDialog.getByRole('button',{name:'Authorize Google'})).toBeDisabled();
        await nativeDialog.getByRole('button',{name:'Back',exact:true}).click();
      }
      await nativeDialog.getByRole('button',{name:kind === 'identity' ? 'Pat Example' : 'Connect to a URL',exact:true}).click();
      if (kind === 'identity') await expect(nativeDialog.getByLabel('Connection permissions')).toHaveValue('2');
      else await nativeDialog.getByLabel('URL',{exact:true}).fill('https://example.com/#bearer-secret');
      await nativeDialog.getByRole('button',{name:kind === 'identity' ? 'Share with person' : 'Allow connection',exact:true}).click();
      await expect.poll(() => app.evaluate(() => window.reply?.token)).toBe('native-'+kind+'-token');
      await expect(nativeDialog).toHaveCount(0);
    }
    for (const mode of ['view','provider','cancel-provider']) {
      await app.evaluate(mode => parent.postMessage({powerboxRequest:{rpcId:'native-'+mode,query:[]}},'*'), mode);
      await nativeDialog.getByRole('button',{name:mode === 'view' ? 'Whole grain' : 'Test provider',exact:true}).click();
      const pagesBefore = context.pages().length;
      if (mode === 'view') await nativeDialog.getByRole('button',{name:'Connect grain',exact:true}).click();
      else {
        await nativeDialog.getByRole('button',{name:'Choose from app',exact:true}).click();
        await nativeDialog.frameLocator('iframe').getByRole('button',{name:'Select test object'}).waitFor();
        if (mode === 'provider') {
          const providerFrame = nativeDialog.frameLocator('iframe');
          await providerFrame.locator('body').evaluate(() => {
            window.nestedReplies=[];
            window.addEventListener('message',event=>window.nestedReplies.push(event.data));
            parent.postMessage({powerboxRequest:{rpcId:'nested-request',query:[]}},'*');
          });
          const childDialog = page.getByRole('dialog',{name:'Connect an app',exact:true}).last();
          await childDialog.getByRole('button',{name:'Nested grain',exact:true}).click();
          await childDialog.getByRole('button',{name:'Connect grain',exact:true}).click();
          await expect.poll(() => providerFrame.locator('body').evaluate(() => window.nestedReplies.some(reply=>reply.rpcId==='nested-request' && reply.token==='native-nested-token'))).toBe(true);
        }
        if (mode === 'cancel-provider') await nativeDialog.getByRole('button',{name:'Cancel request',exact:true}).click();
        else {
          await page.screenshot({path:'/tmp/sandstorm-rust-ui-powerbox.png'});
          await nativeDialog.frameLocator('iframe').getByRole('button',{name:'Select test object'}).click();
        }
      }
      await expect.poll(() => app.evaluate(() => window.reply?.rpcId)).toBe('native-'+mode);
      assert.equal(context.pages().length,pagesBefore);
      if (mode === 'cancel-provider') assert.equal(await app.evaluate(() => window.reply.canceled),true);
      else assert.equal(await app.evaluate(() => window.reply.token),mode === 'view' ? 'native-view-token' : 'native-provider-token');
      await expect.poll(() => nativeProviders.size).toBe(0);
      await expect(nativeDialog).toHaveCount(0);
    }

    await app.evaluate(() => { window.webkeyMessages = []; addEventListener('message', event => window.webkeyMessages.push(event.data));
      parent.postMessage({powerboxRequest:{rpcId:'native-webkey',query:[]}},'*'); });
    const beforePastePages = context.pages().length;
    await nativeDialog.getByRole('button',{name:'Paste capability link',exact:true}).click();
    await nativeDialog.getByLabel('API capability link',{exact:true}).fill('https://api.example.test/#source-secret');
    await page.screenshot({path:'/tmp/sandstorm-rust-ui-powerbox-webkey.png'});
    await nativeDialog.getByRole('button',{name:'Connect using link',exact:true}).click();
    await expect.poll(() => app.evaluate(() => window.reply?.rpcId)).toBe('native-webkey');
    assert.equal(await app.evaluate(() => window.reply.token),'derived-webkey-token');
    assert.equal(JSON.stringify(await app.evaluate(() => window.webkeyMessages)).includes('source-secret'),false);
    assert.equal(await page.evaluate(() => JSON.stringify({...sessionStorage,...localStorage}).includes('source-secret')),false);
    assert.equal(context.pages().length,beforePastePages);
    await expect(nativeDialog).toHaveCount(0);
    for (const failure of ['denied', 'unavailable']) {
      await app.evaluate(failure => parent.postMessage({powerboxRequest:{rpcId:failure,query:[]}},'*'), failure);
      await nativeDialog.getByRole('button',{name:'Paste capability link',exact:true}).click();
      await nativeDialog.getByLabel('API capability link',{exact:true}).fill('https://api.example.test/#' + failure);
      await nativeDialog.getByRole('button',{name:'Connect using link',exact:true}).click();
      await expect(nativeDialog.getByRole('alert')).toHaveText(failure === 'denied'
        ? 'You do not have access to this capability.'
        : 'Could not confirm the connection. Cancel and check the current status before trying again.');
      await nativeDialog.getByRole('button',{name:'Cancel request',exact:true}).click();
      await expect(nativeDialog).toHaveCount(0);
      assert.equal(await page.locator('iframe').count(), 1, 'a request failure must not close the app');
    }
    await app.evaluate(() => {
      window.googleResult = new Promise(resolve => addEventListener('message',event => {if(event.data?.rpcId==='google-powerbox') resolve(event.data);}));
      parent.postMessage({powerboxRequest:{rpcId:'google-powerbox',query:[]}},'*');
    });
    await nativeDialog.getByRole('button',{name:/Connect to Google/}).click();
    await nativeDialog.getByRole('button',{name:'Authorize Google',exact:true}).click();
    assert.equal((await app.evaluate(()=>window.googleResult)).token,'native-google-token');

    await app.evaluate(() => parent.postMessage({powerboxRequest:{rpcId:'cancel-webkey',query:[]}},'*'));
    await nativeDialog.getByRole('button',{name:'Paste capability link',exact:true}).click();
    await nativeDialog.getByLabel('API capability link',{exact:true}).fill('https://api.example.test/#source-secret');
    await nativeDialog.getByRole('button',{name:'Back',exact:true}).click();
    await nativeDialog.getByRole('button',{name:'Paste capability link',exact:true}).click();
    await expect(nativeDialog.getByLabel('API capability link',{exact:true})).toHaveValue('');
    await nativeDialog.getByRole('button',{name:'Cancel request',exact:true}).click();
    await expect.poll(() => app.evaluate(() => window.reply?.rpcId)).toBe('cancel-webkey');

    await app.evaluate(() => parent.postMessage({ powerboxRequest: { rpcId: 'powerbox' } }, '*'));
    await page.getByRole('button', { name: 'More options in main shell' }).waitFor();
    await app.evaluate(() => parent.postMessage({ powerboxRequest: { rpcId: 'duplicate' } }, '*'));
    await expect.poll(() => app.evaluate(() => window.reply?.rpcId)).toBe('duplicate');
    assert.match(await app.evaluate(() => window.reply.error), /already open/);
    const popupPromise = context.waitForEvent('page');
    await page.getByRole('button', { name: 'More options in main shell' }).click();
    const popup = await popupPromise;
    await popup.waitForURL(mainOrigin + '/rust-shell-powerbox');
    await popup.waitForLoadState('domcontentloaded');
    await expect.poll(() => popup.evaluate(() => !!window.request)).toBe(true);
    assert.equal(await popup.evaluate(() => window.request.sessionId), new URL(firstSession).searchParams.get('sessionid'));
    assert.equal(new URL(popup.url()).search, '');
    await page.evaluate(origin => window.dispatchEvent(new MessageEvent('message', {
      origin, source: window, data: { type: 'rust-powerbox-result', result: {rpcId:'powerbox', token:'forged'} },
    })), mainOrigin);
    await popup.evaluate(() => opener.postMessage({type:'rust-powerbox-result', nonce:'wrong',
      result:{rpcId:'powerbox', token:'forged'}}, '*'));
    await popup.getByRole('button', { name: 'Choose test capability' }).click();
    await expect.poll(() => app.evaluate(() => window.reply?.token)).toBe('test-capability');
    assert.equal(await app.evaluate(() => window.reply.descriptor), 'test-descriptor');
    await expect.poll(() => popup.isClosed()).toBe(true);
    await app.evaluate(() => parent.postMessage({ powerboxRequest: { rpcId: 'cancel' } }, '*'));
    await page.getByRole('button', { name: 'Cancel request' }).click();
    await expect.poll(() => app.evaluate(() => window.reply?.canceled)).toBe(true);
    assert.equal(await app.evaluate(() => window.reply.rpcId), 'cancel');
    await app.evaluate(() => parent.postMessage({ powerboxRequest: { rpcId: 'window-close' } }, '*'));
    const closedPopupPromise = context.waitForEvent('page');
    await page.getByRole('button', { name: 'More options in main shell' }).click();
    const closedPopup = await closedPopupPromise;
    await closedPopup.close();
    await expect.poll(() => app.evaluate(() => window.reply?.rpcId)).toBe('window-close');
    assert.equal(await app.evaluate(() => window.reply.canceled), true);
    const beforeUpdate = receivedFrames;
    add('while-open', 'alice', 'Notification while grain is open');
    await expect.poll(() => receivedFrames).toBeGreaterThan(beforeUpdate);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(app.getByLabel('App state')).toHaveValue('keep this iframe alive');
    await expect.poll(() => renewals, { timeout: 15000 }).toBeGreaterThan(0);
    await app.evaluate(() => parent.postMessage({ powerboxRequest: { rpcId: 'grain-close' } }, '*'));
    const grainClosePopupPromise = context.waitForEvent('page');
    await page.getByRole('button', { name: 'More options in main shell' }).click();
    const grainClosePopup = await grainClosePopupPromise;
    await page.locator('.open-grains li.current button').click();
    await expect.poll(() => grainClosePopup.isClosed()).toBe(true);
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('rustOfferTemplate:')).length), 0);
    await expect.poll(() => liveGrains.size).toBe(0);
    await page.getByRole('link', { name: 'Alice grain', exact: true }).click();
    await page.frameLocator('iframe').getByRole('heading', { name: 'Embedded test grain' }).waitFor();
    // A Rust crash closes the browser view; Meteor's bounded lease survives only
    // until expiry. The independent grain host stays alive throughout.
    rust.kill('SIGKILL'); await stop(rust);
    await expect.poll(() => page.locator('iframe').count()).toBe(0);
    leaseClockOffset += 46000;
    await bridge.sweepGrains();
    assert.equal(liveGrains.size, 0);
    await rm(socket, { force: true });
    rust = (await start('debug/sandstorm-rust-shell', [], {
      RUST_SHELL_SOCKET: socket, RUST_SHELL_ORIGIN: proxy.origin, RUST_SHELL_DEV_PORT: vitePort?.toString(),
      RUST_SHELL_MAIN_URL: mainOrigin, RUST_SHELL_WILDCARD_HOST: new URL(mainOrigin).host, RUST_SHELL_BRIDGE_SOCKET: bridgeSocket,
      RUST_SHELL_FIXTURE_SOCKET: '',
    }, /Rust shell: (https:\/\/\S+)/)).child;
    await page.reload();
    await page.frameLocator('iframe').getByRole('heading', { name: 'Embedded test grain' }).waitFor();
    // Recreate Meteor's bridge over the same durable store while an app and
    // chooser are active. Startup discards UI sessions, never the linked login.
    const loginBeforeRestart = (await context.cookies()).find(c => c.name === '__Host-sandstorm-rust-session').value;
    const restartApp = page.frames().find(frame => frame.url().startsWith(grainOrigin));
    await restartApp.evaluate(() => parent.postMessage({powerboxRequest:{rpcId:'restart'}}, '*'));
    const restartPopupPromise = context.waitForEvent('page');
    await page.getByRole('button', {name:'More options in main shell'}).click();
    const restartPopup = await restartPopupPromise;
    bridgeOffline = true;
    changed();
    await page.getByRole('status').filter({hasText:'Waiting for Sandstorm…'}).waitFor();
    assert.equal(await page.locator('iframe').count(), 0);
    await expect.poll(() => restartPopup.isClosed()).toBe(true);
    bridge = createRustShellBridge(bridgeOptions);
    liveGrains.clear(); // Production removes marked Mongo UI sessions at startup.
    bridgeOffline = false;
    await page.getByRole('button', {name:'Reopen grain', exact:true}).waitFor();
    assert.equal(await page.locator('iframe').count(), 0, 'restart must not replay grain opening');
    assert.equal((await context.cookies()).find(c => c.name === '__Host-sandstorm-rust-session').value, loginBeforeRestart);
    await page.reload();
    await page.frameLocator('iframe').getByRole('heading', {name:'Embedded test grain'}).waitFor();
    await page.getByRole('link', { name: 'Notifications', exact: true }).click();
    await page.getByRole('heading', { name: /Alice notification/ }).waitFor();
    await expect.poll(() => liveGrains.size).toBe(1);
    const cookie = (await context.cookies()).find((cookie) => cookie.name === '__Host-sandstorm-rust-session');
    assert.equal(cookie.httpOnly, true); assert.equal(cookie.secure, true); assert.equal(cookie.sameSite, 'Lax');
    assert.equal(await page.evaluate(() => document.cookie.includes('__Host-sandstorm-rust-session')), false);
    await page.evaluate(() => sessionStorage.setItem('rustOfferTemplate:orphaned-before-reload', 'stale credential'));
    await page.reload();
    await page.getByRole('heading', { name: /Alice notification/ }).waitFor();
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('rustOfferTemplate:')).length), 0,
      'a shell reload must clear stale template credentials even without opening a grain');
    assert.equal((await context.cookies()).find((entry) => entry.name === cookie.name).value, cookie.value,
      'ordinary reload must preserve the linked session');
    await expect.poll(() => [...observers.values()]).toEqual(expect.arrayContaining([
      {pages:{},query:undefined},
      {pages:{notifications:0},query:undefined},
    ]));
    await expect.poll(() => [...observers.values()]).toHaveLength(2);
    const starts = observationStarts;
    await new Promise((resolve) => setTimeout(resolve, 6000));
    assert.equal(observationStarts, starts, 'idle watch must survive the ordinary five-second HTTP timeout');
    add('from-legacy', 'alice', 'Written by main shell');
    await page.getByRole('heading', { name: /Written by main shell/ }).waitFor();
    await page.getByRole('button', { name: 'Dismiss Written by main shell', exact: true }).click();
    await page.getByRole('heading', { name: /Written by main shell/ }).waitFor({ state: 'detached' });
    assert.equal(rows.has('from-legacy'), false);
    await page.getByRole('button', { name: 'Mark all as read' }).click();
    await expect.poll(() => rows.get('alice-real-id').unread).toBe(false);
    assert.equal(rows.get('bob-real-id').unread, true);
    const deep = await context.newPage();
    await deep.goto(proxy.origin + '/grain/alice-hidden/deep?q=1#part');
    await deep.frameLocator('iframe').getByRole('heading', {name:'Embedded test grain'}).waitFor();
    await deep.getByRole('heading', {name:'Hidden grain', exact:true}).waitFor();
    await deep.goto(proxy.origin + '/grain/bob-grain');
    await expect(deep.getByRole('alert')).toContainText('Denied');
    await expect(deep.getByRole('alert')).not.toContainText('CAPNP');
    await expect(deep.locator('iframe:visible')).toHaveCount(0);
    await expect(deep.locator('iframe')).toHaveCount(1);
    await expect(deep.getByRole('link',{name:'Switch to Hidden grain'})).toBeVisible();
    await deep.close();
    const racing = await context.newPage();
    await racing.goto(proxy.origin + '/grains');
    holdOpen = true;
    await racing.getByRole('link', { name: 'Alice grain', exact: true }).click();
    await expect.poll(() => !!releaseOpen).toBe(true);
    await racing.getByRole('link', {name:'Notifications', exact:true}).click();
    holdOpen = false; releaseOpen();
    await racing.waitForURL('**/notifications');
    await racing.getByRole('heading', {name:/Alice notification/}).waitFor();
    assert.equal(await racing.locator('iframe').count(), 0);
    // Only the original browser tab's restored background grain remains.
    await expect.poll(() => liveGrains.size).toBe(1);
    assert.equal(await racing.evaluate(async () => (await fetch('/auth/unknown')).status), 404);
    assert.equal(await racing.evaluate(async () => (await fetch('/missing.js')).status), 404);
    await racing.close();
    const other = await context.newPage();
    await other.goto(proxy.origin);
    await other.getByRole('heading', { name: /Alice notification/ }).waitFor();
    activeMainAccount = 'bob';
    await page.getByRole('button', {name:'Account: Alice',exact:true}).click();
    await page.getByRole('link', { name: 'Switch account' }).click();
    await page.getByRole('link',{name:'Use main shell sign-in'}).click();
    await page.getByRole('button', { name: 'Connect Bob' }).click();
    await page.getByRole('heading', { name: /Bob notification/ }).waitFor();
    await other.getByRole('heading', { name: /Bob notification/ }).waitFor();
    assert.equal(await other.getByRole('heading', { name: /Alice notification/ }).count(), 0);
    await other.getByRole('link', { name: 'Grains', exact: true }).click();
    await other.getByRole('link', { name: 'Bob grain', exact: true }).waitFor();
    await other.locator('.grain-item').getByText('Shared with you', { exact: true }).waitFor();
    assert.equal(await other.getByRole('link', { name: 'Alice grain', exact: true }).count(), 0);
    await other.getByRole('link', { name: 'Bob grain', exact: true }).click();
    await other.frameLocator('iframe').getByRole('heading', { name: 'Embedded test grain' }).waitFor();
    await other.frameLocator('iframe').locator('body').evaluate(() => parent.postMessage({ getGrainTitle: {}, rpcId: 'shared-title' }, '*'));
    await expect.poll(() => other.frameLocator('iframe').locator('body').evaluate(() => window.reply?.grainTitle)).toBe('Owner title');
    await page.getByRole('button', {name:'Account: Bob',exact:true}).click();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect.poll(() => liveGrains.size).toBe(0);
    await expect.poll(() => other.locator('iframe').count()).toBe(0);
    await other.getByRole('link', { name: 'Sign in with Sandstorm' }).waitFor();
    assert.equal(await other.locator('.grain-item').count(), 0);
    await page.getByRole('link', { name: 'Sign in with Sandstorm' }).click();
    await page.getByRole('link',{name:'Use main shell sign-in'}).click();
    await page.getByRole('button', { name: 'Connect Bob' }).click();
    await page.getByRole('heading', { name: /Bob notification/ }).waitFor();
    users.bob.hash = 'revoked-by-main-shell';
    await page.getByRole('link', { name: 'Sign in with Sandstorm' }).waitFor();
    assert.equal(await page.locator('.notification-item').count(), 0);
    const freshContext = await browser.newContext();
    const fresh = await freshContext.newPage();
    activeMainAccount = 'alice';
    await fresh.goto(proxy.origin + '/grain/alice-hidden/clients?tab=sync#url');
    await fresh.getByRole('link', {name:'Sign in with Sandstorm'}).click();
    await fresh.getByRole('link',{name:'Use main shell sign-in'}).click();
    await fresh.getByRole('button', {name:'Connect Alice'}).click();
    await fresh.frameLocator('iframe').getByRole('heading', {name:'Embedded test grain'}).waitFor();
    assert.equal(new URL(fresh.url()).pathname + new URL(fresh.url()).search + new URL(fresh.url()).hash,
      '/grain/alice-hidden/clients?tab=sync#url');
    for (const mode of ['failure','unsafe','redirect']) {
      logoutMode=mode;
      if(mode==='redirect') await freshContext.route('https://idp.example/logout**',route=>route.fulfill({contentType:'text/html',body:'Identity provider signed out'}));
      await fresh.getByRole('button',{name:'Account: Alice',exact:true}).click();
      await fresh.getByRole('button',{name:'Disconnect',exact:true}).click();
      if(mode==='redirect') {
        await fresh.waitForURL('https://idp.example/logout?SAMLRequest=fixture');
        assert.equal((await freshContext.cookies(proxy.origin)).some(cookie=>cookie.name==='__Host-sandstorm-rust-session'),false);
        assert.equal((await freshContext.request.get(proxy.origin+'/auth/session',{ignoreHTTPSErrors:true})).status(),401);
      } else {
        await expect(fresh.getByRole('alert')).toContainText('Signed out of Sandstorm, but identity-provider logout could not start.');
        assert.equal((await freshContext.request.get(proxy.origin+'/auth/session',{ignoreHTTPSErrors:true})).status(),401);
        await fresh.goto(proxy.origin+'/login');
        await fresh.getByRole('button',{name:'Alice (admin)',exact:true}).click();
        await fresh.getByRole('heading',{name:/Alice notification/}).waitFor();
      }
    }
    logoutMode='none';
    await freshContext.close();
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error("Grain browser test failed:", error.message);
    throw error;
  } finally {
    await browser?.close();
    await vite?.close(); await stop(rust);
    leaseClockOffset += 46000;
    await bridge.sweepGrains();
    await expect.poll(() => observers.size).toBe(0);
    await expect.poll(() => liveGrains.size).toBe(0);
    for (const server of [main, grainServer, bridgeServer]) if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await proxy?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

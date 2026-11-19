import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';

const bundle = await build({ configFile: false, logLevel: 'silent', build: {
  write: false, minify: false,
  lib: { entry: fileURLToPath(new URL('./unit-entry.ts', import.meta.url)), formats: ['es'] },
} });
const code = bundle[0].output.find(item => item.type === 'chunk').code;
const { runOperation, OperationTimeout, AppService, GrainService, NavigationController,
  isPlainNavigation, templateRequest, powerboxRequest, shareData, GrainTitleSubscriptions,
  SharingWindow, ShellService, ProfileService, initialShellState } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));

function browserGlobals(t) {
  t.mock.method(globalThis, 'setInterval', () => 1);
  t.mock.method(globalThis, 'clearInterval', () => {});
  const old = Object.fromEntries(['location', 'history', 'sessionStorage', 'window'].map(key => [key, globalThis[key]]));
  globalThis.location = new URL('https://shell.test/grains');
  globalThis.history = {
    pushState: (_state, _unused, path) => { globalThis.location = new URL(path, location); },
    replaceState: (_state, _unused, path) => { globalThis.location = new URL(path, location); },
  };
  globalThis.sessionStorage = { getItem: () => null, removeItem: () => {} };
  globalThis.window = {};
  t.after(() => { for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  } });
}

test('RPC deadlines settle once, clean up late capabilities, and never replay', async () => {
  const request = deferred();
  let timeouts = 0;
  const late = [];
  const pending = runOperation(request.promise, 'Open', { timeoutMs: 5,
    onTimeout: () => ++timeouts, onLateResult: result => late.push(result) });
  await assert.rejects(pending, OperationTimeout);
  request.resolve('lease');
  await turn();
  assert.equal(timeouts, 1);
  assert.deepEqual(late, ['lease']);
  const controller = new AbortController();
  const canceled = runOperation(new Promise(() => {}), 'Rename', { signal: controller.signal });
  controller.abort();
  await assert.rejects(canceled, /session changed/);
  assert.equal(await runOperation(Promise.resolve(7), 'Read', { timeoutMs: 5, onTimeout: () => ++timeouts }), 7);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(timeouts, 1);
});

test('creation outcomes survive route changes and are isolated by account', async () => {
  let request = deferred();
  let calls = 0;
  const connection = { run: promise => promise, shell: { createGrain: () => { ++calls; return { promise: () => request.promise }; } } };
  const states = [];
  const apps = new AppService(connection, state => states.push(state));
  apps.selectAccount('alice');
  const creating = apps.create('action', 'Title');
  assert.equal(apps.state.status, 'pending');
  await assert.rejects(apps.create('action', 'Title'), /previous creation/);
  apps.selectAccount('bob');
  assert.equal(apps.state.status, 'idle');
  request.resolve({ grainId: 'created' });
  await assert.rejects(creating, /Account changed/);
  assert.equal(apps.state.status, 'idle');
  apps.selectAccount('alice');
  assert.deepEqual(apps.state, { status: 'created', grainId: 'created' });
  apps.acknowledge();
  request = deferred();
  const lost = apps.create('action', 'Title');
  request.reject(new Error('Lost response'));
  await assert.rejects(lost);
  apps.selectAccount('alice');
  assert.equal(apps.state.status, 'unknown');
  await assert.rejects(apps.create('action', 'Title'), /previous creation/);
  assert.equal(calls, 2);
});

test('acknowledging an interrupted creation cannot let its late failure overwrite a new attempt', async () => {
  const old = deferred();
  const next = deferred();
  let request = old;
  const apps = new AppService({ run: promise => promise, shell: { createGrain: () => ({ promise: () => request.promise }) } }, () => {});
  apps.selectAccount('alice');
  const first = apps.create('action', 'Title');
  apps.interrupt();
  apps.acknowledge();
  request = next;
  const second = apps.create('action', 'Title');
  old.reject(new Error('old failure'));
  await assert.rejects(first);
  assert.equal(apps.state.status, 'pending');
  next.resolve({ grainId: 'new' });
  await second;
  assert.deepEqual(apps.state, { status: 'created', grainId: 'new' });
});

test('snapshots preserve mutation errors; changing account clears them', t => {
  browserGlobals(t);
  let state;
  const service = new ShellService(value => { state = value; });
  service.connection.events.session({ fixture: false, account: { key: 'alice', name: 'Same name' } });
  service.update({ notificationError: 'Unknown notification outcome', grainError: 'Unknown rename outcome' });
  service.connection.events.snapshot({ entries: [], grains: [], grainsLimited: false, revision: 1, total: 0 });
  assert.equal(state.notificationError, 'Unknown notification outcome');
  assert.equal(state.grainError, 'Unknown rename outcome');
  service.connection.events.session({ fixture: false, account: { key: 'bob', name: 'Same name' } });
  assert.equal(state.notificationError, '');
  assert.equal(state.grainError, '');
});

test('navigation remains immediate during remote cleanup and opens only on explicit intent', async t => {
  browserGlobals(t);
  let closeCalls = 0;
  const opens = [];
  const navigation = new NavigationController({ close: () => { ++closeCalls; return new Promise(() => {}); },
    open: async (...args) => { opens.push(args); }, changed: () => {} });
  navigation.navigate('/grain/a');
  navigation.sync({ ...initialShellState(), status: 'ready' });
  navigation.sync({ ...initialShellState(), status: 'reconnecting' });
  navigation.sync({ ...initialShellState(), status: 'ready' });
  assert.deepEqual(opens, [['a', '/']]);
  navigation.navigate('/apps');
  assert.equal(location.pathname, '/apps');
  assert.equal(closeCalls, 2);
  history.pushState(null, '', '/grain/a/document');
  navigation.navigate(location.href, true);
  navigation.sync({ ...initialShellState(), status: 'ready' });
  assert.deepEqual(opens[1], ['a', '/document']);
  for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
    assert.equal(isPlainNavigation({ button: 0, [modifier]: true }), false);
  }
  assert.equal(isPlainNavigation({ button: 0 }), true);
});

test('closing a grain detaches immediately even when remote close throws', async t => {
  browserGlobals(t);
  let state;
  const grains = new GrainService({ run: promise => promise }, patch => { state = { ...state, ...patch }; });
  let released = false;
  grains.session = { close: () => { throw new Error('broken connection'); }, client: { close: () => { released = true; } } };
  grains.active = { grainId: 'grain' };
  assert.equal(grains.close(), undefined);
  assert.equal(state.activeGrain, null);
  await turn();
  assert.equal(released, true);
});

test('message parsers reject malformed structured clones without throwing out of the handler', () => {
  const cyclic = { rpcId: 'request' }; cyclic.self = cyclic;
  assert.equal(powerboxRequest(cyclic), undefined);
  assert.equal(powerboxRequest({ rpcId: NaN }), undefined);
  assert.equal(powerboxRequest({ rpcId: 'request', saveLabel: { defaultText: 'Label', bad: 1n } }), undefined);
  assert.throws(() => templateRequest({ rpcId: 'request', template: 'hello', roleAssignment: 1n }), /Invalid/);
  assert.throws(() => templateRequest({ rpcId: 'request', template: 'hello', style: [] }), /Invalid/);
  assert.equal(shareData({ pathname: '/../admin' }), undefined);
  assert.deepEqual(shareData({ pathname: '/document', hash: '#a' }), { pathname: '/document', hash: '#a' });
});

test('owner title subscriptions update once, are bounded, and clear at frame teardown', () => {
  const replies = [];
  const titles = new GrainTitleSubscriptions('Owner title', reply => replies.push(reply));
  titles.request('once', {});
  titles.request('sub', {}, true);
  titles.update('Owner title');
  assert.equal(replies.length, 2);
  titles.update('Owner renamed');
  assert.deepEqual(replies.at(-1), { rpcId: 'sub', grainTitle: 'Owner renamed' });
  for (let i = 0; i < 50; ++i) titles.request(i, {}, true);
  replies.length = 0;
  titles.update('Next');
  assert.equal(replies.length, 32);
  titles.clear();
  titles.update('Closed');
  assert.equal(replies.length, 32);
});

test('blocked sharing can retry; terminal errors have no pending popup action', t => {
  browserGlobals(t);
  const states = [];
  let sent;
  let closed = false;
  const popup = { postMessage: value => { sent = value; }, close: () => { closed = true; } };
  window.open = () => null;
  const sharing = new SharingWindow('https://main.test', 'session', state => states.push(state));
  sharing.request('share');
  sharing.open();
  assert.equal(states.at(-1).status, 'blocked');
  window.open = () => popup;
  sharing.open();
  sharing.message({ source: {}, origin: 'https://main.test', data: { type: 'rust-sharing-ready' } });
  assert.equal(sent, undefined);
  sharing.message({ source: popup, origin: 'https://main.test', data: { type: 'rust-sharing-ready' } });
  assert.equal(sent.sessionId, 'session');
  sharing.message({ source: popup, origin: 'https://main.test', data: { type: 'rust-sharing-result', nonce: sent.nonce, error: 'Denied' } });
  assert.equal(states.at(-1).status, 'failed');
  assert.equal(closed, true);
  sharing.open();
  assert.equal(states.at(-1).status, 'failed');
  sharing.cancel();
});

test('repeated navigation preserves pending cleanup before opening a replacement', async t => {
  browserGlobals(t);
  const closing = deferred();
  let opened = 0;
  const session = { close: () => ({ promise: () => closing.promise }), client: { close: () => {} } };
  const connection = { run: promise => promise, shell: { openGrain: () => {
    ++opened;
    return { promise: async () => ({ session, view: { url: 'https://grain.test/init', origin: 'https://grain.test', ownerTitle: 'Owner' } }) };
  } } };
  const grains = new GrainService(connection, () => {});
  grains.session = session;
  grains.close();
  grains.close();
  const opening = grains.open('next', '/', []);
  await turn();
  assert.equal(opened, 0);
  closing.resolve();
  await opening;
  assert.equal(opened, 1);
  grains.reset();
});

test('disconnect during rename retains uncertainty without leaking a late error into another account', async t => {
  browserGlobals(t);
  const pending = deferred();
  let state;
  const grains = new GrainService({ run: promise => promise }, patch => { state = { ...state, ...patch }; });
  grains.session = { rename: () => ({ promise: () => pending.promise }), client: { close: () => {} } };
  grains.active = { grainId: 'old' };
  const rename = grains.rename('New title');
  grains.reset();
  assert.match(state.grainError, /Could not confirm rename/);
  // The composition layer clears errors on account change.
  state.grainError = '';
  pending.reject(new Error('old account failure'));
  await assert.rejects(rename);
  assert.equal(state.grainError, '');
});


test('profile outcomes survive route changes; late reads and writes cannot overwrite new account state', async () => {
  const reading = deferred();
  const saving = deferred();
  let state;
  let renamed;
  const profile = new ProfileService({run:promise=>promise,shell:{
    getProfile:()=>({promise:()=>reading.promise}),
    updateProfile:()=>({promise:()=>saving.promise}),
  }}, value=>{state=value;}, value=>{renamed=value;});
  const load = profile.load();
  const save = profile.save({name:'New',handle:'alice',pronoun:'neutral'});
  reading.resolve({profile:{name:'Stale',handle:'alice',pronoun:'neutral',mainHref:''}});
  await load;
  assert.equal(state.value,null);
  profile.reset();
  assert.match(state.error,/Could not confirm/);
  profile.reset(true);
  saving.resolve({profile:{name:'Old account',handle:'alice',pronoun:'neutral',mainHref:''}});
  await save;
  assert.equal(state.value,null);
  assert.equal(state.error,'');
  assert.equal(renamed,undefined);
});

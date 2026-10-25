import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../shell/imports/server/transfers-server.js', import.meta.url), 'utf8');
const downloaderSource = source.slice(source.indexOf('export class Downloader'),
    source.indexOf('\nif (!Meteor.settings.replicaNumber)')).replace('export class', 'class');

function fixture() {
  const logs = [];
  const state = { cleared: false, updates: [], advanced: false };
  const context = vm.createContext({
    console: { log: (...args) => logs.push(args) },
    inMeteor: callback => callback(),
    setInterval: callback => { state.heartbeat = callback; return 42; },
    clearInterval: id => { assert.equal(id, 42); state.cleared = true; },
    globalDb: { collections: { incomingTransfers: {
      findOneAsync: async () => ({ downloading: true }),
      updateAsync: async (...args) => state.updates.push(args),
    } } },
    startOneTransfer: async () => { state.advanced = true; },
  });
  const Downloader = vm.runInContext(downloaderSource + '\nDownloader', context);
  return { Downloader, logs, state };
}

test('pending transfers report stage and progress without tokens; timer stops on completion', async () => {
  const { Downloader, logs, state } = fixture();
  const worker = new Downloader({ _id: 'transfer-id', grainId: 'grain-id', token: 'SECRET' });
  let finish;
  worker.nextStep = async () => {
    worker.setStage('downloading');
    worker.bytesStored = 65536;
    await new Promise(resolve => { finish = resolve; });
    worker.setStage('completed');
    worker.canceled = true;
  };
  await tick();
  state.heartbeat();
  const progress = logs.find(entry => entry[1] === 'progress');
  const details = JSON.parse(progress[2]);
  assert.equal(details.grainId, 'grain-id');
  assert.equal(details.stage, 'downloading');
  assert.equal(details.bytesStored, 65536);
  assert.equal(typeof details.idleSeconds, 'number');
  assert.equal(JSON.stringify(logs).includes('SECRET'), false);
  finish();
  await worker.promise;
  assert.equal(state.cleared, true);
  assert.equal(logs.at(-1)[1], 'worker stopped');
});

test('failure logs identify the stage, save the error, release request, and advance queue', async () => {
  const { Downloader, logs, state } = fixture();
  const worker = new Downloader({ _id: 'transfer-id', grainId: 'grain-id' });
  let destroyed = false;
  worker.request = { destroy() { destroyed = true; } };
  worker.nextStep = async () => {
    worker.setStage('downloading');
    throw new Error('RPC upload failed');
  };
  await worker.promise;
  const failed = logs.find(entry => entry[1] === 'failed');
  assert.equal(JSON.parse(failed[2]).stage, 'downloading');
  assert.equal(state.updates[0][1].$set.error, 'RPC upload failed');
  assert.equal(state.advanced, true);
  assert.equal(state.cleared, true);
  assert.equal(destroyed, true);
});

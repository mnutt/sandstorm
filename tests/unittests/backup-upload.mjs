import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable, PassThrough } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';

// Load the Meteor-independent helper without changing the shell's module configuration.
const source = await readFile(new URL('../../shell/imports/server/backup-upload.js', import.meta.url));
const { uploadBackupStream } = await import('data:text/javascript;base64,' + source.toString('base64'));

function backend(overrides = {}) {
  return {
    writes: [], closed: 0, finished: 0,
    async write(chunk) { this.writes.push(Buffer.from(chunk)); },
    async done() { this.finished++; },
    close() { this.closed++; },
    ...overrides,
  };
}

test('large uploads preserve bytes with only one outstanding RPC write', async () => {
  let active = 0;
  let maximum = 0;
  const chunks = Array.from({ length: 2048 }, (_, i) => Buffer.alloc(1024, i % 256));
  const stream = backend({
    async write(chunk) {
      maximum = Math.max(maximum, ++active);
      await tick();
      this.writes.push(Buffer.from(chunk));
      active--;
    },
    async done() { assert.equal(active, 0); this.finished++; },
  });
  const progress = [];
  await uploadBackupStream(Readable.from(chunks, { objectMode: false }), stream,
      bytes => progress.push(bytes));
  assert.equal(maximum, 1);
  assert.deepEqual(Buffer.concat(stream.writes), Buffer.concat(chunks));
  assert.equal(progress.at(-1), 2048 * 1024);
  assert.equal(stream.finished, 1);
  assert.equal(stream.closed, 1);
});

test('RPC failure rejects upload and stops input without calling done', async () => {
  const failure = new Error('writev EINVAL');
  const input = new PassThrough();
  const stream = backend({ async write() { throw failure; } });
  const result = assert.rejects(uploadBackupStream(input, stream), error => error === failure);
  input.write(Buffer.alloc(65536));
  await result;
  assert.equal(input.destroyed, true);
  assert.equal(stream.finished, 0);
  assert.equal(stream.closed, 1);
});

test('premature close rejects even while an RPC write is pending', async () => {
  const input = new PassThrough();
  let rejectWrite;
  const stream = backend({ write() { return new Promise((resolve, reject) => { rejectWrite = reject; }); } });
  const result = assert.rejects(uploadBackupStream(input, stream), /premature close/i);
  input.write(Buffer.from('partial'));
  await tick();
  input.destroy();
  await result;
  assert.equal(stream.finished, 0);
  assert.equal(stream.closed, 1);
  // A late RPC rejection must also be handled.
  rejectWrite(new Error('disconnected after cancellation'));
  await tick();
});

test('input errors propagate and release the capability', async () => {
  const input = new PassThrough();
  const stream = backend();
  const failure = new Error('connection reset');
  const result = assert.rejects(uploadBackupStream(input, stream), error => error === failure);
  input.destroy(failure);
  await result;
  assert.equal(stream.closed, 1);
  assert.equal(stream.finished, 0);
});

test('done failure propagates after all writes', async () => {
  const stream = backend({ async done() { throw new Error('fsync failed'); } });
  await assert.rejects(uploadBackupStream(Readable.from([Buffer.from('backup')]), stream), /fsync failed/);
  assert.equal(Buffer.concat(stream.writes).toString(), 'backup');
  assert.equal(stream.closed, 1);
});

test('empty backup still calls done and closes', async () => {
  const stream = backend();
  await uploadBackupStream(Readable.from([]), stream);
  assert.equal(stream.writes.length, 0);
  assert.equal(stream.finished, 1);
  assert.equal(stream.closed, 1);
});

test('blocked backend bounds how far input is read ahead', async () => {
  let readChunks = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const input = Readable.from((function* () {
    for (let i = 0; i < 2048; i++) {
      readChunks++;
      yield Buffer.alloc(65536);
    }
  })(), { objectMode: false, highWaterMark: 65536 });
  const stream = backend({ async write() { await gate; } });
  const uploading = uploadBackupStream(input, stream);
  await tick();
  assert.ok(readChunks <= 4, `Read ${readChunks} chunks while the backend was blocked`);
  assert.equal(stream.finished, 0);
  release();
  await uploading;
  assert.equal(readChunks, 2048);
  assert.equal(stream.finished, 1);
});

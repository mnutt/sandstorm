import { Conn } from 'capnp-es';
import { Shell, type Shell$Client } from '../src/generated/shell';
import { ByteSink, CounterObserver, type Counter$Client, type Fixture$Client } from '../src/generated/fixture';
import { WebSocketTransport } from '../src/lib/transport';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function check(ok: boolean, message: string): asserts ok { if (!ok) throw new Error(message); }
async function until(predicate: () => Promise<boolean> | boolean, label: string) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(10); }
  throw new Error(`Timed out: ${label}`);
}
async function connect() {
  const socket = new WebSocket(location.origin.replace('http', 'ws') + '/rpc');
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
  const conn = new Conn(new WebSocketTransport(socket, (error) => conn.shutdown(error)));
  conn.onError = () => {};
  return { conn, shell: conn.bootstrap(Shell) };
}
async function stats(fixture: Fixture$Client) {
  const result = await fixture.inspect().promise();
  return { counters: result.liveCounters, streams: result.liveStreams, sent: result.sentChunks };
}

export async function runInterop() {
  const { conn, shell } = await connect();
  const monitoring = await connect();
  try {
    const monitor = (await monitoring.shell.interop().promise()).fixture;
    const before = await stats(monitor);
    check(before.counters === 0 && before.streams === 0, 'fixture not initially empty');
    // Pipelining crosses both browser/Rust and Rust/C++ connections.
    const fixturePromise = shell.interop();
    const creating = fixturePromise.getFixture().newCounter((p) => { p.initial = 40; });
    const counter = creating.getCounter();
    const added = await counter.add((p) => { p.amount = 2; }).promise();
    check(added.value === 42, 'pipelined add failed');
    let callback = 0;
    await counter.report((p) => { p.observer = new CounterObserver.Server({ changed: async (p) => {
      callback = p.value;
      // Re-enter C++ while its report call is waiting for this browser callback.
      const nested = await counter.add((p) => { p.amount = 1; }).promise();
      check(nested.value === 43, 'reentrant call failed');
    } }).client(); }).promise();
    check(callback === 42, 'C++ callback was not forwarded');
    let exception = '';
    try { await counter.fail().promise(); } catch (error) { exception = String(error); }
    check(exception.includes('intentional C++ fixture exception'), 'C++ exception was not propagated');

    const fixture = (await fixturePromise.promise()).fixture;
    const temporary = (await fixture.newCounter().promise()).counter;
    check((await stats(monitor)).counters === 2, 'counter not created');
    temporary.client.close();
    await until(async () => (await stats(monitor)).counters === 1, 'forwarded counter release');

    let received = 0;
    let bytes = 0;
    let completed = false;
    const streaming = await counter.stream((p) => {
      p.count = 4; p.chunkBytes = 16384;
      p.sink = new ByteSink.Server({
        write: async (p) => {
          check(p.sequence === received, 'stream order');
          const data = p.data.toUint8Array();
          check(data.length === 16384, 'chunk length');
          for (let i = 0; i < data.length; i++) check(data[i] === (received + i) % 251, 'chunk contents');
          ++received; bytes += data.length;
          await delay(10);
        },
        done: async (p) => { check(p.count === received, 'stream completion count'); completed = true; },
      }).client();
    }).promise();
    await until(() => completed, 'stream completion');
    streaming.stream.client.close();
    await until(async () => (await stats(monitor)).streams === 0, 'completed stream release');

    let slowCalls = 0;
    let acknowledge: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { acknowledge = resolve; });
    const slow = await counter.stream((p) => {
      p.count = 8; p.chunkBytes = 16384;
      p.sink = new ByteSink.Server({ write: async () => { ++slowCalls; await blocked; }, done: async () => {} }).client();
    }).promise();
    await until(() => slowCalls === 1, 'first slow chunk');
    const sent = (await stats(monitor)).sent;
    await delay(100);
    check((await stats(monitor)).sent === sent && slowCalls === 1, 'sender ignored backpressure');
    await slow.stream.cancel().promise();
    acknowledge!();
    await delay(50);
    check((await stats(monitor)).sent === sent, 'cancel did not stop stream');
    slow.stream.client.close();
    await until(async () => (await stats(monitor)).streams === 0, 'cancelled stream release');

    // Lose the entire browser RPC connection while a callback is blocked.
    let abruptCalls = 0;
    let unblock!: () => void;
    const hanging = new Promise<void>((resolve) => { unblock = resolve; });
    await counter.stream((p) => {
      p.count = 8; p.chunkBytes = 1024;
      p.sink = new ByteSink.Server({ write: async () => { ++abruptCalls; await hanging; }, done: async () => {} }).client();
    }).promise();
    await until(() => abruptCalls === 1, 'disconnect fixture');
    conn.shutdown();
    await until(async () => {
      const state = await stats(monitor);
      return state.counters === 0 && state.streams === 0;
    }, 'C++ resources after browser disconnect');
    unblock();
    return { value: added.value, callback, bytes, received, backpressure: true, cancelled: true, released: true, exception: true };
  } finally { conn.shutdown(); monitoring.conn.shutdown(); }
}

let held: { conn: Conn; shell: Shell$Client; counter: Counter$Client } | undefined;
export async function holdCounter() {
  const connection = await connect();
  const fixture = (await connection.shell.interop().promise()).fixture;
  const counter = (await fixture.newCounter((p) => { p.initial = 10; }).promise()).counter;
  held = { ...connection, counter };
  return (await counter.add().promise()).value;
}
export async function useHeldCounter() {
  check(!!held, 'no held counter');
  let failed = false;
  try { await held.counter.add().promise(); } catch { failed = true; }
  // C++ loss must not terminate the Rust fixture's other services.
  await held.shell.addFixture().promise();
  return failed;
}
export async function freshCounter() {
  held?.conn.shutdown(); held = undefined;
  const connection = await connect();
  try {
    const fixture = (await connection.shell.interop().promise()).fixture;
    const counter = (await fixture.newCounter((p) => { p.initial = 99; }).promise()).counter;
    return (await counter.add().promise()).value;
  } finally { connection.conn.shutdown(); }
}

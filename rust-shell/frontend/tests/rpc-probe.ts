import { Conn } from 'capnp-es';
import { Observer, Shell } from '../src/generated/shell';
import { WebSocketTransport } from '../src/lib/transport';
import { ShellService } from '../src/lib/shell';

export async function probe() {
  const socket = new WebSocket(location.origin.replace('http', 'ws') + '/rpc');
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
  const conn = new Conn(new WebSocketTransport(socket, (error) => conn.shutdown(error)));
  conn.onError = () => {};
  const shell = conn.bootstrap(Shell);
  let calls = 0;
  let latest = -1;
  let entries = 0;
  const observer = () => new Observer.Server({ replace: async (params) => {
    ++calls; latest = params.snapshot.revision; entries = [...params.snapshot.entries].length;
  } }).client();
  const waitFor = async (predicate: () => boolean, label: string) => {
    for (let i = 0; i < 200; ++i) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Observer did not deliver ${label}; calls=${calls}, revision=${latest}, entries=${entries}`);
  };
  try {
    let fixtureDisabled = false;
    try { await shell.interop().promise(); }
    catch (error) { fixtureDisabled = String(error).includes('C++ fixture disabled'); }
    const watching = shell.watch((p) => { p.observer = observer(); });
    // Exercise a pipelined call on a returned capability before watch resolves.
    await watching.getSubscription().cancel().promise();
    const first = (await watching.promise()).subscription;
    const active = (await shell.watch((p) => { p.observer = observer(); }).promise()).subscription;
    await waitFor(() => latest === 0, 'initial');
    let duplicateRejected = false;
    try { await shell.watch((p) => { p.observer = observer(); }).promise(); }
    catch { duplicateRejected = true; }
    // Repeated cancel/release of an old handle must not unlock the new subscription.
    await first.cancel().promise();
    first.client.close();
    let oldCancelSafe = false;
    try { await shell.watch((p) => { p.observer = observer(); }).promise(); }
    catch { oldCancelSafe = true; }
    await shell.addFixture().promise();
    await waitFor(() => latest === 1 && entries === 2, 'first change');
    let closed = false;
    const closure = active.whenClosed().promise().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 60));
    if (closed) throw new Error('Healthy subscription reported closed');
    await active.cancel().promise();
    await closure;
    const cancelledCalls = calls;
    await shell.addFixture().promise();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const cancelled = calls === cancelledCalls;
    active.client.close();
    const resumed = (await shell.watch((p) => { p.observer = observer(); }).promise()).subscription;
    await waitFor(() => latest === 2 && entries === 3, 'resubscribe');
    for (let i = 0; i < 47; i++) await shell.addFixture().promise();
    let limitRejected = false;
    try { await shell.addFixture().promise(); } catch { limitRejected = true; }
    await waitFor(() => entries === 50, 'limit');
    // Releasing without cancel must free the sole subscription slot too.
    resumed.client.close();
    const replacement = (await shell.watch((p) => { p.observer = observer(); }).promise()).subscription;
    await replacement.cancel().promise();
    replacement.client.close();
    // A rejected callback and a stalled callback both report terminal failure.
    for (const stalled of [false, true]) {
      const broken = (await shell.watch((p) => {
        p.observer = new Observer.Server({ replace: async () => {
          if (stalled) await new Promise(() => {});
          else throw new Error('Deliberate observer failure');
        } }).client();
      }).promise()).subscription;
      let failed = false;
      try { await broken.whenClosed().promise(); }
      catch (error) { failed = String(error).includes('Live update delivery failed'); }
      if (!failed) throw new Error('Observer failure was not reported');
      await broken.cancel().promise();
      // Cleanup must not erase the failure for callers arriving later.
      try { await broken.whenClosed().promise(); throw new Error('Lost terminal failure'); }
      catch (error) { if (!String(error).includes('Live update delivery failed')) throw error; }
      broken.client.close();
    }
    // Exercise the actual frontend recovery path after a callback exception.
    let rejectOnce = true;
    let recovering = false;
    let recovered = false;
    const service = new ShellService(state => {
      if (state.status === 'ready' && rejectOnce) {
        rejectOnce = false;
        throw new Error('Deliberate UI callback failure');
      }
      if (state.status === 'reconnecting') recovering = true;
      if (state.status === 'ready' && recovering) recovered = true;
    });
    try {
      service.start();
      await waitFor(() => recovered, 'service recovery');
    } finally { service.stop(); }
    return { fixtureDisabled, duplicateRejected, oldCancelSafe, cancelled, limitRejected, entries };
  } finally { conn.shutdown(); }
}

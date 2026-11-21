import { Conn } from 'capnp-es';
import { Shell, FailureCode, type GrainSession$Client } from '../src/generated/shell';
import { unwrap } from '../src/lib/results';
import { WebSocketTransport } from '../src/lib/transport';

// Factories are pipelined selectors, not session allocation or permission grants.
export async function resources() {
  const socket = new WebSocket(location.origin.replace('https:', 'wss:') + '/rpc');
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
  const conn = new Conn(new WebSocketTransport(socket, error => conn.shutdown(error)));
  conn.onError = () => {};
  const shell = conn.bootstrap(Shell);
  const view = shell.grainView(p => { p.grainId = 'alice-grain'; }).getView();
  const action = shell.action(p => { p.key = 'alice-action'; }).getAction();
  const foreign = shell.action(p => { p.key = 'bob-action'; }).getAction();
  const sessions: GrainSession$Client[] = [];
  try {
    const denied = (await action.create(p => { p.title = 'Denied creation'; }).promise()).result;
    const unauthorized = (await foreign.create(p => { p.title = 'Created in Rust'; }).promise()).result;
    if (!denied._isFailure || denied.failure.code !== FailureCode.PERMISSION_DENIED ||
        !unauthorized._isFailure || unauthorized.failure.code !== FailureCode.PERMISSION_DENIED) throw new Error('Action authority escaped selector');
    const first = unwrap((await view.open().promise()).result);
    sessions.push(first.session);
    const second = unwrap((await view.open().promise()).result);
    sessions.push(second.session);
    if (first.view.url === second.view.url) throw new Error('Reference reused a session');
    await first.session.close().promise();
    // Closing one session does not revoke the independently opened second one.
    const sharing = second.session.sharing().getSharing();
    try { unwrap((await sharing.read().promise()).result); }
    finally { sharing.client.close(); }
    await second.session.close().promise();
    // Even after all its sessions close, the original reference remains usable.
    const third = unwrap((await view.open().promise()).result);
    sessions.push(third.session);
    await third.session.close().promise();
    return true;
  } finally {
    for (const session of sessions) session.client.close();
    for (const resource of [view, action, foreign]) resource.client.close();
    conn.shutdown();
  }
}

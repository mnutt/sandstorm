import { Conn } from 'capnp-es';
import { Shell, type GrainSession$Client } from '../src/generated/shell';
import { unwrap } from '../src/lib/results';
import { WebSocketTransport } from '../src/lib/transport';
let conn: Conn | undefined;
let session: GrainSession$Client | undefined;
export async function open() {
  const socket = new WebSocket(location.origin.replace('https:', 'wss:') + '/rpc');
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
  const connection = new Conn(new WebSocketTransport(socket, (error) => connection.shutdown(error)));
  connection.onError = () => {};
  conn = connection;
  const view = conn.bootstrap(Shell).grainView(p => {p.grainId='alice-grain';}).getView();
  try { session = unwrap((await view.open().promise()).result).session; }
  finally { view.client.close(); }
}
export function release() { session?.client.close(); session = undefined; }
export function disconnect() { conn?.shutdown(); conn = undefined; session = undefined; }

export async function closedSharing() {
  await open();
  const grain = session!;
  const sharing = grain.sharing().getSharing();
  try {
    const initial = await sharing.read().promise();
    if (!initial.result._isValue) throw new Error('Sharing projection unavailable');
    await grain.close().promise();
    const results = await Promise.all([
      sharing.read().promise(),
      sharing.create(p => {p.label = 'closed'; p._initRole().all = true;}).promise(),
      sharing.edit(p => {p.id = 'downstream'; p.label = 'closed';}).promise(),
      sharing.revoke(p => {p.id = 'downstream';}).promise(),
    ]);
    return results.every(result => result.result._isFailure && result.result.failure.message === 'Grain session closed');
  } finally { sharing.client.close(); release(); disconnect(); }
}

import { Conn } from 'capnp-es';
import { Shell, type GrainSession$Client } from '../src/generated/shell';
import { WebSocketTransport } from '../src/lib/transport';
let conn: Conn | undefined;
let session: GrainSession$Client | undefined;
export async function open() {
  const socket = new WebSocket(location.origin.replace('https:', 'wss:') + '/rpc');
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
  const connection = new Conn(new WebSocketTransport(socket, (error) => connection.shutdown(error)));
  connection.onError = () => {};
  conn = connection;
  session = (await conn.bootstrap(Shell).openGrain((params) => { params.grainId = 'alice-grain'; }).promise()).session;
}
export function release() { session?.client.close(); session = undefined; }
export function disconnect() { conn?.shutdown(); conn = undefined; session = undefined; }

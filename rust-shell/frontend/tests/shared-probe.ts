import { Conn } from 'capnp-es';
import { Shell } from '../src/generated/shell';
import { WebSocketTransport } from '../src/lib/transport';
export async function probe() {
  const ws=new WebSocket(location.origin.replace('https:','wss:')+'/shared-rpc');
  await new Promise<void>((resolve,reject)=>{ws.onopen=()=>resolve();ws.onerror=()=>reject(new Error('connect'));});
  const conn=new Conn(new WebSocketTransport(ws,()=>{}));
  try {await conn.bootstrap(Shell).getProfile().promise();return false;}
  catch {return true;}
  finally {conn.shutdown();ws.close();}
}

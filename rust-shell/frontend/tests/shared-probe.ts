import { Conn } from 'capnp-es';
import { Message } from 'capnp-es';
import { Message as RpcMessage } from 'capnp-es/capnp/rpc';
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

// Run only against the isolated test server. Neither attack has a valid webkey.
export async function attack(kind: 'reply' | 'flood') {
  const ws = new WebSocket(location.origin.replace('https:', 'wss:') + '/shared-rpc');
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('connect')); });
  const closed = new Promise<boolean>(resolve => {
    const timer = setTimeout(() => { ws.close(); resolve(false); }, 3000);
    ws.onclose = () => { clearTimeout(timer); resolve(true); };
  });
  for (let id = 0; id < (kind === 'reply' ? 1 : 1100); ++id) {
    const frame = new Message();
    const root = frame.initRoot(RpcMessage);
    if (kind === 'reply') root._initReturn().answerId = 0xffffffff;
    else root._initBootstrap().questionId = id;
    ws.send(frame.toArrayBuffer());
  }
  return closed;
}

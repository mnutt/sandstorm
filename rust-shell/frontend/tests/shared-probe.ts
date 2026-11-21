import { Conn } from 'capnp-es';
import { Message } from 'capnp-es';
import { Message as RpcMessage } from 'capnp-es/capnp/rpc';
import { Shell } from '../src/generated/shell';
import { WebSocketTransport } from '../src/lib/transport';
export async function probe() {
  const ws=new WebSocket(location.origin.replace('https:','wss:')+'/shared-rpc');
  await new Promise<void>((resolve,reject)=>{ws.onopen=()=>resolve();ws.onerror=()=>reject(new Error('connect'));});
  const conn=new Conn(new WebSocketTransport(ws,()=>{}));
  try {await conn.bootstrap(Shell).account().getAccount().readProfile().promise();return false;}
  catch {return true;}
  finally {conn.shutdown();ws.close();}
}

// An invalid reply must close; a burst of valid bootstraps must remain connected.
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

export async function checkResults() {
  const {SharedShell, FailureCode} = await import('../src/generated/shell');
  const ws=new WebSocket(location.origin.replace('https:','wss:')+'/shared-rpc');
  await new Promise<void>((resolve,reject)=>{ws.onopen=()=>resolve();ws.onerror=()=>reject(new Error('connect'));});
  const conn=new Conn(new WebSocketTransport(ws,()=>{}));
  conn.onError=()=>{};
  try {
    const shared=conn.bootstrap(SharedShell);
    const denied=(await shared.inspect(p=>{p.webkey='invalid-share';}).promise()).result;
    const valid=(await shared.inspect(p=>{p.webkey='valid-share';}).promise()).result;
    const open=(await shared.open(p=>{p.webkey='invalid-share';}).promise()).result;
    return denied._isFailure && denied.failure.code===FailureCode.PERMISSION_DENIED &&
      valid._isValue && valid.value.title==='Shared test grain' && open._isFailure && open.failure.code===FailureCode.PERMISSION_DENIED;
  } finally {conn.shutdown();ws.close();}
}

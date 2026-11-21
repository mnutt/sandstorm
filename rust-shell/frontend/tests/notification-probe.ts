import { Conn } from 'capnp-es';
import { Shell, FailureCode } from '../src/generated/shell';
import { WebSocketTransport } from '../src/lib/transport';

export async function checkAuthority() {
  const socket = new WebSocket(location.origin.replace('https:', 'wss:') + '/rpc');
  await new Promise<void>((resolve, reject) => {socket.onopen=()=>resolve();socket.onerror=()=>reject(new Error('connect'));});
  const conn = new Conn(new WebSocketTransport(socket, error => conn.shutdown(error)));
  conn.onError = () => {};
  const shell = conn.bootstrap(Shell);
  const handles = ['referrals', 'stats', 'bob-real-id', ''].map(key => shell.notification(p=>{p.key=key;}).getNotice());
  try {
    const read = (await handles[0].read().promise()).result;
    const wrongKind = (await handles[0].setStatisticsReporting(p=>{p.enabled=true;}).promise()).result;
    const missing = (await handles[1].read().promise()).result;
    const otherAccount = (await handles[2].read().promise()).result;
    const foreignDismiss = (await handles[2].dismiss().promise()).result;
    const foreignRead = (await handles[2].markRead().promise()).result;
    const emptyRead = (await handles[3].markRead().promise()).result;
    const missingDismiss = (await handles[1].dismiss().promise()).result;
    return {
      foreignDismiss:foreignDismiss._isFailure && foreignDismiss.failure.code === FailureCode.PERMISSION_DENIED,
      foreignRead:foreignRead._isValue,
      emptyRead:emptyRead._isFailure && emptyRead.failure.code === FailureCode.INVALID_INPUT,
      missingDismiss:missingDismiss._isFailure && missingDismiss.failure.code === FailureCode.NOT_FOUND,
      referrals:read._isValue && read.value._isReferrals && read.value.referrals.pending.get(0).name === 'Pending person',
      wrongKind:wrongKind._isFailure && wrongKind.failure.code === FailureCode.INVALID_INPUT,
      missing:missing._isFailure && missing.failure.code === FailureCode.NOT_FOUND,
      otherAccount:otherAccount._isFailure && otherAccount.failure.code === FailureCode.NOT_FOUND,
    };
  } finally { for (const handle of handles) handle.client.close(); conn.shutdown(); }
}

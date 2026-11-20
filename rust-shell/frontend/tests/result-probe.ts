import { Conn } from 'capnp-es';
import { Shell, GrainObserver, NotificationObserver, FailureCode } from '../src/generated/shell';
import { WebSocketTransport } from '../src/lib/transport';

export async function checkResults() {
  const ws=new WebSocket(location.origin.replace('https:','wss:')+'/rpc');
  await new Promise<void>((resolve,reject)=>{ws.onopen=()=>resolve();ws.onerror=()=>reject(new Error('connect'));});
  const conn=new Conn(new WebSocketTransport(ws,()=>{}));
  conn.onError=()=>{};
  const shell=conn.bootstrap(Shell);
  const subscriptions: {client:{close:()=>void}}[]=[];
  const observers: {client:{close:()=>void}}[]=[];
  try {
    const apps=(await shell.listApps(p=>{p.appId='denied-test';}).promise()).result;
    // An invalid selector still creates a pipelinable handle; its domain
    // operation reports the validation error as a typed value.
    const install=shell.installer().getInstaller().open(p=>{p.packageId='invalid';}).getInstallation();
    const invalid=(await install.read().promise()).result;
    install.client.close();
    const grainFailure=new Promise<boolean>(resolve=>{
      const observer=new GrainObserver.Server({replace:async p=>{resolve(p.result._isFailure && p.result.failure.code===FailureCode.PERMISSION_DENIED);}}).client();
      observers.push(observer);
      const subscription=shell.watchGrains(p=>{p._initQuery().search='denied-test';p.observer=observer;}).getSubscription();
      subscriptions.push(subscription);
    });
    const noticeFailure=new Promise<boolean>(resolve=>{
      const observer=new NotificationObserver.Server({replace:async p=>{resolve(p.result._isFailure && p.result.failure.code===FailureCode.PERMISSION_DENIED);}}).client();
      observers.push(observer);
      const subscription=shell.watchNotifications(p=>{p.page=99;p.observer=observer;}).getSubscription();
      subscriptions.push(subscription);
    });
    return apps._isFailure && apps.failure.code===FailureCode.PERMISSION_DENIED &&
      invalid._isFailure && invalid.failure.code===FailureCode.INVALID_INPUT && await grainFailure && await noticeFailure;
  } finally {for(const item of [...subscriptions,...observers]) item.client.close();conn.shutdown();ws.close();}
}

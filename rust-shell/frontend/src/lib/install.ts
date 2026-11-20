import { PackageStage, InstallationObserver, type Installation$Client, type Subscription$Client, type InstallationState } from '../generated/shell';
import { unwrap, ApplicationError } from './results';
import type { ShellConnection } from './connection';
// Only explicitly returned application errors are safe to display. RPC and
// transport failures do not establish whether a write completed.
export class InstallationError extends Error {}
export function installationError(error: unknown, writing = false): string {
  if (error instanceof InstallationError || error instanceof ApplicationError) return error.message;
  return writing
    ? 'Could not confirm the operation. Check the current status before trying again.'
    : 'Could not load app information. Please try again.';
}
export interface InstallState {
  packageId: string; status: string; progress: number; error: string;
  appId: string; title: string; description: string; version: string; fingerprint: string;
  iconSrc: string; installed: boolean; newerInstalled: boolean; olderGrains: number;
}
export interface InstallCatalog { marketUrl: string; updates: {packageId:string;title:string;version:string;url:string}[] }
export class InstallService {
  constructor(private connection: ShellConnection) {}
  open(packageId:string,url='') {
    const client=this.connection.installer.open(p=>{p.packageId=packageId;p.url=url;}).getInstallation();
    return new InstallationView(this.connection,client);
  }
  async catalog(): Promise<InstallCatalog> {
    const value=unwrap((await this.connection.run(this.connection.installer.catalog().promise(),'Load app catalog')).result);
    return {marketUrl:value.marketUrl,updates:[...value.updates].map(row=>({packageId:row.packageId,title:row.title,version:row.version,url:row.url}))};
  }
  async state(operation: string, packageId: string, url = ''): Promise<InstallState> {
    const installer=this.connection.installer;
    const request = operation === 'status' ? installer.status(p=>{p.packageId=packageId;})
      : operation === 'confirm' ? installer.confirm(p=>{p.packageId=packageId;})
      : operation === 'upgrade' ? installer.upgrade(p=>{p.packageId=packageId;})
      : operation === 'download' || operation === 'retry' ? installer.download(p=>{p.packageId=packageId;p.url=url;p.retry=operation==='retry';})
      : undefined;
    if (!request) throw new Error('Invalid installation operation');
    return installState(unwrap((await this.connection.run(request.promise(),'App installation')).result));
  }
  async upload(file: File, signal: AbortSignal, progress: (percent: number) => void): Promise<string> {
    const lifetime = this.connection.signal;
    const result = unwrap((await this.connection.run(this.connection.installer.upload().promise(),'Upload app')).result);
    const aborted = AbortSignal.any([signal,lifetime]);
    aborted.throwIfAborted();
    // The one-use upload credential comes from the authenticated server. File
    // bytes go straight to the existing streaming verifier, never through RPC.
    const id = await new Promise<string>((resolve,reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      aborted.addEventListener('abort',abort,{once:true});
      const clean = () => aborted.removeEventListener('abort',abort);
      xhr.open('POST',result.url);
      xhr.timeout = 30 * 60 * 1000;
      xhr.upload.onprogress = event => { if (event.lengthComputable) progress(event.loaded / event.total * 100); };
      xhr.onload = () => {
        clean();
        if (xhr.status === 200 && /^[a-f0-9]{32}$/.test(xhr.responseText)) resolve(xhr.responseText);
        else reject(new InstallationError('Upload failed. The package may be invalid; choose the file again to retry.'));
      };
      xhr.onerror = xhr.ontimeout = xhr.onabort = () => { clean(); reject(new InstallationError('Upload interrupted. It was not retried.')); };
      xhr.send(file);
    });
    aborted.throwIfAborted();
    await this.state('download',id);
    return id;
  }
}

export function installState(value: InstallationState): InstallState {
  const stages:Record<number,string> = {
    [PackageStage.MISSING]:'missing',[PackageStage.DOWNLOAD]:'download',[PackageStage.VERIFY]:'verify',
    [PackageStage.UNPACK]:'unpack',[PackageStage.ANALYZE]:'analyze',[PackageStage.READY]:'ready',
    [PackageStage.FAILED]:'failed',[PackageStage.DELETE]:'delete',
  };
  return {packageId:value.packageId,status:stages[value.stage] || 'unknown',progress:value.progress,error:value.error,
    appId:value.appId,title:value.title,description:value.description,version:value.version,fingerprint:value.fingerprint,
    iconSrc:value.iconSrc,installed:value.installed,newerInstalled:value.newerInstalled,olderGrains:value.olderGrains};
}

/** A mounted installation view owns observation, never the package download. */
export class InstallationView {
  private subscription?:Subscription$Client;
  private closed=false;
  private stopObserver?:()=>void;
  constructor(private connection:ShellConnection,private client:Installation$Client) {}
  async act(operation:string):Promise<InstallState> {
    if (this.closed) throw new Error('Installation view closed');
    const request=operation==='confirm' ? this.client.confirm() : operation==='upgrade' ? this.client.upgrade()
      : this.client.download(p=>{p.retry=operation==='retry';});
    return installState(unwrap((await this.connection.run(request.promise(),'App installation')).result));
  }
  watch(changed:(state:InstallState)=>void,failed:(error:unknown)=>void) {
    const observer=new InstallationObserver.Server({changed:async p=>{
      if(this.closed)return;
      try {changed(installState(unwrap(p.result)));} catch(error){failed(error);}
    }}).client();
    this.stopObserver=()=>observer.client.close();
    void this.connection.run(this.client.watch(p=>{p.observer=observer;}).promise(),'Observe installation',{
      onLateResult:r=>{void r.subscription.cancel().promise().catch(()=>{}).finally(()=>r.subscription.client.close());},
    }).then(result=>{
      this.subscription=result.subscription;
      if(this.closed){this.releaseSubscription();return;}
      void result.subscription.whenClosed().promise().then(()=>{if(!this.closed)failed(new Error('Observation ended'));},error=>{if(!this.closed)failed(error);});
    }).catch(error=>{if(!this.closed)failed(error);});
  }
  private releaseSubscription() {
    const subscription=this.subscription;this.subscription=undefined;
    if(subscription) void subscription.cancel().promise().catch(()=>{}).finally(()=>subscription.client.close());
  }
  close() {
    if(this.closed)return;
    this.closed=true;this.releaseSubscription();this.stopObserver?.();this.client.client.close();
  }
}

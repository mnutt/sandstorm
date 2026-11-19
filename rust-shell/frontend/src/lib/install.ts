import type { ShellConnection } from './connection';
export interface InstallState {
  packageId: string; status: string; progress: number; error: string;
  appId: string; title: string; description: string; version: string; fingerprint: string;
  iconSrc: string; installed: boolean; newerInstalled: boolean; olderGrains: number;
}
export interface InstallCatalog { marketUrl: string; updates: {packageId:string;title:string;version:string;url:string}[] }
export class InstallService {
  constructor(private connection: ShellConnection) {}
  async call<T>(operation: string, data: {packageId?:string;url?:string} = {}): Promise<T> {
    const result = await this.connection.run(this.connection.shell.install(params => {
      params.operation = operation; params.input = JSON.stringify(data);
    }).promise(), 'App installation');
    return JSON.parse(result.state);
  }
  catalog() { return this.call<InstallCatalog>('catalog'); }
  state(operation: string, packageId: string, url = '') { return this.call<InstallState>(operation,{packageId,url}); }
  async upload(file: File, signal: AbortSignal, progress: (percent: number) => void): Promise<string> {
    const lifetime = this.connection.signal;
    const result = await this.call<{uploadUrl:string}>('upload');
    const aborted = AbortSignal.any([signal,lifetime]);
    aborted.throwIfAborted();
    // The one-use upload credential comes from the authenticated server. File
    // bytes go straight to the existing streaming verifier, never through RPC.
    const id = await new Promise<string>((resolve,reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      aborted.addEventListener('abort',abort,{once:true});
      const clean = () => aborted.removeEventListener('abort',abort);
      xhr.open('POST',result.uploadUrl);
      xhr.timeout = 30 * 60 * 1000;
      xhr.upload.onprogress = event => { if (event.lengthComputable) progress(event.loaded / event.total * 100); };
      xhr.onload = () => {
        clean();
        if (xhr.status === 200 && /^[a-f0-9]{32}$/.test(xhr.responseText)) resolve(xhr.responseText);
        else reject(new Error('Upload failed. The package may be invalid; choose the file again to retry.'));
      };
      xhr.onerror = xhr.ontimeout = xhr.onabort = () => { clean(); reject(new Error('Upload interrupted. It was not retried.')); };
      xhr.send(file);
    });
    aborted.throwIfAborted();
    await this.state('download',id);
    return id;
  }
}

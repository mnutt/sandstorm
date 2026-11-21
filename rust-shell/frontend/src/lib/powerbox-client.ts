import type { GrainSession$Client, PowerboxRequest$Client, PowerboxState as WireState } from '../generated/shell';
import { unwrap, ApplicationError } from './results';
import { FailureCode, HttpOAuthProvider } from '../generated/shell';
import type { ShellConnection } from './connection';
import type { PowerboxActions, PowerboxState } from './powerbox-native';

function state(value: WireState): PowerboxState {
  if (value._isChoices) return {status:'choices',limited:value.choices.limited,legacy:value.choices.legacy,
    candidates:[...value.choices.candidates].map(c=>({key:c.key,title:c.title,detail:c.detail,iconSrc:c.iconSrc,
      uiView:c.uiView,hostedObject:c.hostedObject,urlInput:c.urlInput,emailInput:c.emailInput,oauthProvider:c.oauthProvider === HttpOAuthProvider.GITHUB ? 'github' as const : c.oauthProvider === HttpOAuthProvider.GOOGLE ? 'google' as const : undefined,
      roles:[...c.roles].map(r=>({key:r.key,title:r.title}))}))};
  if (value._isProvider) return {status:'provider',title:value.provider.title,origin:value.provider.origin,url:value.provider.url};
  if (value._isOauth) return {status:'oauth',request:value.oauth.request,url:value.oauth.url};
  if (value._isEmail) return {status:'email',address:value.email};
  if (value._isComplete) return {status:'complete',token:value.complete.token,descriptor:value.complete.descriptor};
  if (value._isWaiting) return {status:'waiting'};
  if (value._isClosed) throw new ApplicationError(FailureCode.EXPIRED, 'Connection request closed.');
  throw new Error('Unsupported connection request state.');
}

/** UI correlation IDs stay local. Remote authority is carried by request capabilities. */
export class PowerboxRequests {
  private requests = new Map<string,{client:PowerboxRequest$Client;parent?:string}>();
  private generation = 0;
  constructor(private connection:ShellConnection) {}
  reset() {
    ++this.generation;
    for (const {client} of this.requests.values()) this.release(client);
    this.requests.clear();
  }
  private release(client:PowerboxRequest$Client) {
    void this.connection.run(client.cancel().promise(),'Cancel connection request').catch(()=>{}).finally(()=>client.client.close());
  }
  async call(session:GrainSession$Client,id:string,operation:Parameters<PowerboxActions['call']>[1],input:Record<string,unknown>={},parent?:string):Promise<PowerboxState> {
    if (operation==='select' && input.mode==='nested') {
      const view=await this.call(session,String(input.nestedRequest),input.nestedOperation as Parameters<PowerboxActions['call']>[1],input.nestedInput as Record<string,unknown>,id);
      return {status:'nested',view};
    }
    const generation=this.generation;
    if (operation==='begin') {
      if (this.requests.has(id)) throw new Error('Connection request is already open.');
      const query=(input.query || []) as string[];
      const fill=(p:{_initQuery:(length:number)=>{set:(index:number,value:string)=>void}})=>{const list=p._initQuery(query.length);query.forEach((v,i)=>list.set(i,v));};
      const parentRequest=parent ? this.requests.get(parent)?.client : undefined;
      if (parent && !parentRequest) throw new Error('Provider request closed.');
      const request=parentRequest ? parentRequest.nested(fill) : session.beginPowerbox(fill);
      const result=await this.connection.run(request.promise(),'Open connection request',{onLateResult:r=>{if(r.result._isValue)this.release(r.request);}});
      if (generation!==this.generation) {if(result.result._isValue)this.release(result.request);throw new Error('Grain session changed.');}
      try {const view=state(unwrap(result.result));this.requests.set(id,{client:result.request,parent});return view;}
      catch(error) {if(result.result._isValue)this.release(result.request);throw error;}
    }
    const current=this.requests.get(id);
    if (!current) {if(operation==='cancel') return {status:'waiting'};throw new Error('Connection request closed.');}
    if (current.parent!==parent) throw new Error('Connection request belongs to another provider.');
    const client=current.client;
    if (operation==='cancel') {this.requests.delete(id);this.release(client);return {status:'waiting'};}
    const request=operation==='poll' ? client.poll() : client.select(p=>{
      const selection=p._initSelection();selection.key=String(input.key || '');
      switch(input.mode) {
        case 'view':selection.view=String(input.role || '');break;
        case 'hosted':selection.hosted=true;break;
        case 'webkey':selection.webkey=String(input.url || '');break;
        case 'url':selection.url=String(input.url || '');break;
        case 'sendEmail':selection.sendEmail=String(input.email || '');break;
        case 'verifyEmail':selection.verifyEmail=String(input.code || '');break;
        case 'oauthStart':selection.startOAuth=true;break;
        case 'oauthFinish':selection.finishOAuth=true;break;
        default: selection.direct=true;
      }
    });
    const result=await this.connection.run(request.promise(),'Connection request');
    if (generation!==this.generation) throw new Error('Grain session changed.');
    return state(unwrap(result.result));
  }
}

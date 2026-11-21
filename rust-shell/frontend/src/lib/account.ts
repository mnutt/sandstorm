import { OAuthProvider } from '../generated/shell';
import { unwrap, applicationErrorMessage } from './results';
import type { ShellConnection } from './connection';

export interface AccountSettings {
  emailEnabled: boolean;
  githubEnabled?: boolean;
  googleEnabled?: boolean;
  oidcEnabled?: boolean;
  samlEnabled?: boolean;
  authorization?: {request:string; url?:string; pending?:boolean};
  emails: {email: string; verified: boolean; primary: boolean}[];
  credentials: {id: string; service: string; name: string; pictureUrl: string; login: boolean}[];
}
export type AccountOperation = 'samlStart' | 'samlFinish' | 'samlCancel' | 'oauthStart' | 'oauthFinish' | 'oauthCancel' | 'state' | 'primary' | 'sendEmail' | 'verifyEmail' | 'unlink' | 'allowLogin';
export interface AccountState { value: AccountSettings | null; pending: boolean; error: string; notice: string }
export const emptyAccount = (): AccountState => ({value:null, pending:false, error:'', notice:''});

export class AccountService {
  private state = emptyAccount();
  private generation = 0;
  constructor(private connection: ShellConnection, private changed: (state: AccountState) => void) {}
  private update(patch: Partial<AccountState>) { this.state = {...this.state, ...patch}; this.changed(this.state); }
  reset() { ++this.generation; this.state = emptyAccount(); this.changed(this.state); }
  async call(operation: AccountOperation = 'state', input: Record<string, string | boolean> = {}, signal?:AbortSignal) {
    if (this.state.pending) return false;
    const generation = this.generation;
    this.update({pending:true, error:'', notice:''});
    try {
      const account=this.connection.account;
      const email=String(input.email || '');
      if (operation.startsWith('oauth') && input.provider !== 'github' && input.provider !== 'google' && input.provider !== 'oidc') throw new Error('Unsupported OAuth provider.');
      const provider = input.provider === 'oidc' ? OAuthProvider.OIDC : input.provider === 'google' ? OAuthProvider.GOOGLE : OAuthProvider.GITHUB;
      const request = operation === 'state' ? account.read()
        : operation === 'primary' ? account.setPrimaryEmail(p=>{p.email=email;})
        : operation === 'sendEmail' ? account.sendEmail(p=>{p.email=email;p.allowLogin=!!input.allowLogin;})
        : operation === 'verifyEmail' ? account.verifyEmail(p=>{p.email=email;p.code=String(input.code || '');p.allowLogin=!!input.allowLogin;})
        : operation === 'unlink' ? account.unlink(p=>{p.credentialId=String(input.id || '');})
        : operation === 'allowLogin' ? account.setLoginAllowed(p=>{p.credentialId=String(input.id || '');p.allowed=!!input.allowLogin;})
        : operation === 'samlStart' ? account.startSaml()
        : operation === 'samlFinish' ? account.finishSaml(p=>{p.request=String(input.request || '');})
        : operation === 'samlCancel' ? account.cancelSaml(p=>{p.request=String(input.request || '');})
        : operation === 'oauthStart' ? account.startOAuth(p=>{p.provider=provider;})
        : operation === 'oauthFinish' ? account.finishOAuth(p=>{p.provider=provider;p.request=String(input.request || '');})
        : account.cancelOAuth(p=>{p.provider=provider;p.request=String(input.request || '');});
      const result = await this.connection.run(request.promise(), 'Account settings', {signal: signal ? AbortSignal.any([this.connection.signal,signal]) : this.connection.signal});
      if (generation !== this.generation) return false;
      const data = unwrap(result.result);
      const value: AccountSettings = {emailEnabled:data.emailEnabled,githubEnabled:data.githubEnabled,googleEnabled:data.googleEnabled,oidcEnabled:data.oidcEnabled,samlEnabled:data.samlEnabled,
        emails:[...data.emails].map(item=>({email:item.email,verified:item.verified,primary:item.primary})),
        credentials:[...data.credentials].map(item=>({id:item.id,service:item.service,name:item.name,pictureUrl:item.pictureUrl,login:item.login})),
        authorization:data._hasAuthorization() ? {request:data.authorization.request,url:data.authorization.url,pending:data.authorization.pending} : undefined};
      this.update({value, notice: operation === 'sendEmail' ? 'Verification code sent. Check your email.' : operation === 'state' || value.authorization || operation === 'oauthCancel' || operation === 'samlCancel' ? '' : 'Account settings updated.'});
      return value;
    } catch (error) {
      if (generation === this.generation) this.update({error:applicationErrorMessage(error, operation === 'state' ? 'Could not load account settings. Please try again.' : 'Could not confirm the change. Check your account settings before trying again.')});
      return false;
    } finally { if (generation === this.generation) this.update({pending:false}); }
  }
}

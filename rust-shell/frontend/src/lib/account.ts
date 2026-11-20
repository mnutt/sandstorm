import type { ShellConnection } from './connection';
import { errorMessage } from './operations';

export interface AccountSettings {
  emailEnabled: boolean;
  githubEnabled?: boolean;
  oauth?: {request:string; url?:string; pending?:boolean};
  emails: {email: string; verified: boolean; primary: boolean}[];
  credentials: {id: string; service: string; name: string; pictureUrl: string; login: boolean}[];
}
export type AccountOperation = 'githubStart' | 'githubFinish' | 'githubCancel' | 'state' | 'primary' | 'sendEmail' | 'verifyEmail' | 'unlink' | 'allowLogin';
export interface AccountState { value: AccountSettings | null; pending: boolean; error: string; notice: string }
export const emptyAccount = (): AccountState => ({value:null, pending:false, error:'', notice:''});

export class AccountService {
  private state = emptyAccount();
  private generation = 0;
  constructor(private connection: ShellConnection, private changed: (state: AccountState) => void) {}
  private update(patch: Partial<AccountState>) { this.state = {...this.state, ...patch}; this.changed(this.state); }
  reset() { ++this.generation; this.state = emptyAccount(); this.changed(this.state); }
  async call(operation: AccountOperation = 'state', input: Record<string, string | boolean> = {}) {
    if (this.state.pending) return false;
    const generation = this.generation;
    this.update({pending:true, error:'', notice:''});
    try {
      const result = await this.connection.run(this.connection.shell.accountSettings(params => {
        params.operation = operation; params.input = JSON.stringify(input);
      }).promise(), 'Account settings');
      if (generation !== this.generation) return false;
      const value: AccountSettings = JSON.parse(result.state);
      this.update({value, notice: operation === 'sendEmail' ? 'Verification code sent. Check your email.' : operation === 'state' || value.oauth || operation === 'githubCancel' ? '' : 'Account settings updated.'});
      return value;
    } catch (error) {
      if (generation === this.generation) this.update({error:operation === 'state' ? errorMessage(error) : `${errorMessage(error)} Check the current settings before trying again.`});
      return false;
    } finally { if (generation === this.generation) this.update({pending:false}); }
  }
}

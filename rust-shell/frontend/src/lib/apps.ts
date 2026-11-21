import type { ShellConnection } from './connection';
import type { AppActionHandle$Client } from '../generated/shell';
import type { AppAction } from './model';
import { ApplicationError, unwrap, applicationErrorMessage } from './results';

export type CreationState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'unknown'; error: string }
  | { status: 'rejected'; error: string }
  | { status: 'created'; grainId: string };

// Route components do not own mutation outcomes. Keep them scoped to account
// identity (not display name), including when the user visits another route.
export class AppService {
  private account: string | null = null;
  private accountVersion = 0;
  private attempts = new Map<string, symbol>();
  private outcomes = new Map<string, CreationState>();
  constructor(private connection: ShellConnection, private changed: (state: CreationState) => void) {}
  selectAccount(key: string | null) {
    if (key !== this.account) ++this.accountVersion;
    this.account = key;
    this.changed(this.state);
  }
  get state(): CreationState {
    return this.account ? this.outcomes.get(this.account) ?? { status: 'idle' } : { status: 'idle' };
  }
  private set(key: string, state: CreationState) {
    this.outcomes.set(key, state);
    if (this.account === key) this.changed(state);
  }
  interrupt() {
    if (this.account && this.state.status === 'pending') {
      this.set(this.account, { status: 'unknown', error: 'Connection changed before creation was confirmed.' });
    }
  }
  opened(grainId: string) {
    const state = this.state;
    if (state.status === 'created' && state.grainId === grainId) this.acknowledge();
  }
  acknowledge() {
    if (!this.account || this.state.status === 'pending') return;
    this.outcomes.delete(this.account);
    this.attempts.delete(this.account);
    this.changed({ status: 'idle' });
  }
  async list(page = 0, appId = ''): Promise<{ actions: AppAction[]; limited: boolean }> {
    try {
      const response = await this.connection.run(this.connection.shell.listApps(params => { params.page=page; params.appId=appId; }).promise(), 'Load apps');
      const result = unwrap(response.result);
      const actions = [...result.actions].map(action => ({grainCount:action.grainCount,key:action.key,title:action.title,appTitle:action.appTitle,shortDescription:action.shortDescription,appId:action.appId,iconSrc:action.iconSrc,lastUsed:action.lastUsed}));
      return {actions,limited:result.limited};
    } catch (error) {
      throw new Error(applicationErrorMessage(error, 'Could not load installed apps. Please try again.'));
    }
  }

  async create(actionId: string, title: string): Promise<string> {
    const account = this.account;
    if (!account) throw new Error('Connect to Sandstorm first.');
    if (this.state.status !== 'idle') throw new Error('Review the previous creation before starting another.');
    const version = this.accountVersion;
    const attempt = Symbol();
    this.attempts.set(account, attempt);
    this.set(account, { status: 'pending' });
    let action: AppActionHandle$Client | undefined;
    try {
      action = this.connection.shell.action(params => { params.key = actionId; }).getAction();
      const response = await this.connection.run(action.create(params => {
        params.title = title;
      }).promise(), 'Create grain');
      const result = unwrap(response.result);
      if (this.attempts.get(account) !== attempt) throw new Error('Creation was already acknowledged.');
      this.set(account, { status: 'created', grainId: result.grainId });
      if (this.account !== account || version !== this.accountVersion) throw new Error('Account changed.');
      return result.grainId;
    } catch (error) {
      if (this.attempts.get(account) === attempt && this.outcomes.get(account)?.status !== 'created') this.set(account,
        error instanceof ApplicationError ? {status:'rejected',error:error.message}
          : {status:'unknown',error:'Could not confirm grain creation. The request was not retried.'});
      throw error;
    } finally { action?.client.close(); }
  }
}

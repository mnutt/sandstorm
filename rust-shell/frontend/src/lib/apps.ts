import type { ShellConnection } from './connection';
import type { AppAction } from './model';
import { errorMessage } from './operations';

export type CreationState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'unknown'; error: string }
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
    const result = await this.connection.run(this.connection.shell.listApps(params => { params.page=page; params.appId=appId; }).promise(), 'Load apps');
    const actions: AppAction[] = [];
    for (const action of result.actions) actions.push({ grainCount: action.grainCount, key: action.key, title: action.title, appTitle: action.appTitle, shortDescription: action.shortDescription, appId: action.appId, iconSrc: action.iconSrc, lastUsed: action.lastUsed });
    return { actions, limited: result.limited };
  }
  async create(actionId: string, title: string): Promise<string> {
    const account = this.account;
    if (!account) throw new Error('Connect to Sandstorm first.');
    if (this.state.status !== 'idle') throw new Error('Review the previous creation before starting another.');
    const version = this.accountVersion;
    const attempt = Symbol();
    this.attempts.set(account, attempt);
    this.set(account, { status: 'pending' });
    try {
      const result = await this.connection.run(this.connection.shell.createGrain(params => {
        params.actionId = actionId;
        params.title = title;
      }).promise(), 'Create grain');
      if (this.attempts.get(account) !== attempt) throw new Error('Creation was already acknowledged.');
      this.set(account, { status: 'created', grainId: result.grainId });
      if (this.account !== account || version !== this.accountVersion) throw new Error('Account changed.');
      return result.grainId;
    } catch (error) {
      if (this.attempts.get(account) === attempt && this.outcomes.get(account)?.status !== 'created') this.set(account, {
        status: 'unknown', error: `Could not confirm grain creation. ${errorMessage(error)}`,
      });
      throw error;
    }
  }
}

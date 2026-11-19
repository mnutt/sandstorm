import { clearStoredTemplateOffers } from './template';
import { ProfileService, type Profile } from './profile';
import type { Shell$Client, Snapshot } from '../generated/shell';
import { ShellConnection } from './connection';
import { GrainWorkspace } from './workspace';
import { AppService } from './apps';
import { initialShellState, type ShellState, type Grain, type Notification } from './model';
import { errorMessage } from './operations';
export { initialShellState } from './model';
export type { ShellState, Grain, Notification, AppAction, ActiveGrain } from './model';

// Composition boundary: one connection, domain-owned operations, plain UI state.
export class ShellService {
  private state = initialShellState();
  private connection: ShellConnection;
  private grains: GrainWorkspace;
  private apps: AppService;
  private profile: ProfileService;
  private accountKey: string | null = null;
  private notificationOperation = 0;

  constructor(private changed: (state: ShellState) => void) {
    clearStoredTemplateOffers();
    this.connection = new ShellConnection({
      reset: () => {
        this.grains.reset();
        clearStoredTemplateOffers();
        this.profile.reset();
        this.apps.interrupt();
        if (this.state.pending) this.update({ pending: false, notificationError: 'Connection changed. The action was not retried; its outcome may be unknown.' });
        ++this.notificationOperation;
      },
      session: session => {
        const key = session.account?.key ?? null;
        if (key !== this.accountKey) {
          this.accountKey = key;
          this.profile.reset(true);
          this.update({ notificationError: '', grainError: '' });
        }
        this.apps.selectAccount(key);
        this.update({ fixture: session.fixture, account: session.account?.name ?? null, accountKey:key });
      },
      status: (status, connectionError) => this.update({
        status, connectionError, entries: [], grains: [], grainsLimited: false, total: 0,
      }),
      snapshot: snapshot => this.snapshot(snapshot),
    });
    this.grains = new GrainWorkspace(this.connection, state => this.update(state));
    this.profile = new ProfileService(this.connection, profile => this.update({ profile }), account => this.update({ account }));
    this.apps = new AppService(this.connection, creation => this.update({ creation }));
  }
  private update(patch: Partial<ShellState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  private snapshot(snapshot: Snapshot) {
    const entries: Notification[] = [];
    for (const entry of snapshot.entries) entries.push({
      id: entry.key || String(entry.id), title: entry.title, body: entry.body,
      href: entry.href, unread: entry.unread, ongoing: entry.ongoing,
      timestamp: entry.timestamp, senderName: entry.senderName,
    });
    const grains: Grain[] = [];
    for (const grain of snapshot.grains) grains.push({
      key: grain.key, title: grain.title, ownerTitle: grain.ownerTitle,
      href: grain.href, owned: grain.owned, lastUsed: grain.lastUsed, appTitle: grain.appTitle, iconSrc: grain.iconSrc,
    });
    this.update({ status: 'ready', entries, grains, grainsLimited: snapshot.grainsLimited,
      revision: snapshot.revision, total: snapshot.total, connectionError: '' });
    this.grains.applyMenu(grains);
  }
  start() { this.connection.start(); }
  stop() { this.connection.stop(); }
  reconnect() { this.connection.reconnect(); }
  selectGrain(id: string | null) { this.grains.select(id); }
  grainPathChanged(id: string, path: string) { this.grains.pathChanged(id, path); }
  closeGrain(id?: string) { this.grains.close(id); }
  openGrain(requested: Grain | string, path = '/') {
    return this.grains.open(typeof requested === 'string' ? requested : requested.key, path, this.state.grains);
  }
  renameGrain(id: string, title: string) { return this.grains.rename(id, title); }
  renderTemplate(id: string, input: unknown) { return this.grains.renderTemplate(id, input); }
  loadProfile() { return this.profile.load(); }
  saveProfile(profile: Pick<Profile, 'name' | 'handle' | 'pronoun'>) { return this.profile.save(profile); }
  listApps() { return this.apps.list(); }
  createGrain(action: string, title: string) { return this.apps.create(action, title); }
  acknowledgeCreation() { this.apps.acknowledge(); }
  clearErrors() { this.update({ notificationError: '', grainError: '' }); }
  async logout() {
    try { await this.connection.logout(); }
    catch (error) { this.update({ connectionError: errorMessage(error) }); }
  }
  dismiss(id: string) {
    return this.mutate(shell => this.state.fixture
      ? shell.dismiss(params => { params.id = Number(id); }).promise()
      : shell.dismissReal(params => { params.key = id; }).promise());
  }
  addFixture() { return this.mutate(shell => shell.addFixture().promise()); }
  markRead() { return this.mutate(shell => shell.markRead().promise()); }
  private async mutate(operation: (shell: Shell$Client) => PromiseLike<unknown>) {
    if (this.state.status !== 'ready' || this.state.pending) return;
    const id = ++this.notificationOperation;
    this.update({ pending: true, notificationError: '' });
    try { await this.connection.run(operation(this.connection.shell), 'Update notification'); }
    catch (error) {
      if (id === this.notificationOperation) this.update({
        notificationError: `${errorMessage(error)}. The action was not retried; its outcome may be unknown.`,
      });
    } finally { if (id === this.notificationOperation) this.update({ pending: false }); }
  }
}

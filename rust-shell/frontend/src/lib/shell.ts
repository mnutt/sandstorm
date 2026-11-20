import { ListCache } from './list-delta';
import { grainRow, notificationRow, watchGrains, watchNotifications, type GrainQuery } from './queries';
import { AccountService } from './account';
import { NotificationView } from './notification-details';
import { InstallService } from './install';
import { clearStoredTemplateOffers } from './template';
import { ProfileService, type Profile } from './profile';
import type { Shell$Client, Snapshot, NotificationHandle$Client } from '../generated/shell';
import { ShellConnection } from './connection';
import { GrainWorkspace } from './workspace';
import { AppService } from './apps';
import { initialShellState, type ShellState, type Grain, type Notification } from './model';
import { errorMessage } from './operations';
import { unwrap, applicationErrorMessage } from './results';
export { initialShellState } from './model';
export type { ShellState, Grain, Notification, AppAction, ActiveGrain } from './model';

// Composition boundary: one connection, domain-owned operations, plain UI state.
export class ShellService {
  private state = initialShellState();
  private grainList = new ListCache<Grain>(row => row.key);
  private notificationList = new ListCache<Notification>(row => row.id);
  private connection: ShellConnection;
  private grains: GrainWorkspace;
  private apps: AppService;
  readonly accountSettings: AccountService;
  readonly installation: InstallService;
  private profile: ProfileService;
  private accountKey: string | null = null;
  private notificationOperation = 0;

  constructor(private changed: (state: ShellState) => void) {
    clearStoredTemplateOffers();
    this.connection = new ShellConnection({
      reset: () => {
        this.grainList.clear();
        this.notificationList.clear();
        this.grains.reset();
        clearStoredTemplateOffers();
        this.profile.reset();
        this.accountSettings.reset();
        this.apps.interrupt();
        if (this.state.pending) this.update({ pending: false, notificationError: 'Connection changed. The action was not retried; its outcome may be unknown.' });
        ++this.notificationOperation;
      },
      session: session => {
        const key = session.account?.key ?? null;
        if (key !== this.accountKey) {
          this.accountKey = key;
          this.profile.reset(true);
          this.accountSettings.reset();
          this.update({ notificationError: '', grainError: '' });
        }
        this.apps.selectAccount(key);
        this.update({ fixture: session.fixture, account: session.account?.name ?? null, accountKey:key, accountPictureUrl:session.account?.pictureUrl || '' });
      },
      status: (status, connectionError) => this.update({
        status, connectionError, entries: [], grains: [], grainsLimited: false, total: 0,
      }),
      snapshot: snapshot => this.snapshot(snapshot),
    });
    this.accountSettings = new AccountService(this.connection, accountSettings => this.update({accountSettings}));
    this.installation = new InstallService(this.connection);
    this.grains = new GrainWorkspace(this.connection, state => {
      this.update(state);
      // A resolved open call may also mean failure or cancellation. Only an
      // established session acknowledges the matching account's creation.
      for (const grain of state.openGrains ?? []) this.apps.opened(grain.grainId);
    });
    this.profile = new ProfileService(this.connection, profile => this.update({ profile }), account => this.update({ account }));
    this.apps = new AppService(this.connection, creation => this.update({ creation }));
  }
  private update(patch: Partial<ShellState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  private snapshot(snapshot: Snapshot) {
    this.profile.observe(snapshot.profileVersion);
    const entries = this.notificationList.apply(snapshot.entries.delta, [...snapshot.entries.upserts].map(notificationRow));
    const grains = this.grainList.apply(snapshot.grains.delta, [...snapshot.grains.upserts].map(grainRow));
    this.update({hasUnread:snapshot.hasUnread, accountPictureUrl:snapshot.accountPictureUrl, status: 'ready', entries, grains, grainsLimited: snapshot.grains.hasMore,
      revision: snapshot.revision, total: snapshot.entries.total, connectionError: '' });
    this.grains.applyMenu(grains);
  }
  watchGrains(query:GrainQuery,changed:(grains:Grain[],more:boolean)=>void,failed:(error:unknown)=>void) {return watchGrains(this.connection,query,changed,failed);}
  watchNotifications(page:number,changed:(entries:Notification[],total:number)=>void,failed:(error:unknown)=>void) {return watchNotifications(this.connection,page,changed,failed);}
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
  powerbox(id: string) { return this.grains.powerbox(id); }
  sharing(id: string) { return this.grains.sharing(id); }
  renderTemplate(id: string, input: unknown) { return this.grains.renderTemplate(id, input); }
  uploadProfilePicture(image: Blob) { return this.profile.uploadPicture(image); }
  loadProfile() { return this.profile.load(); }
  saveProfile(profile: Pick<Profile, 'name' | 'handle' | 'pronoun'>) { return this.profile.save(profile); }
  listApps(page = 0, appId = '') { return this.apps.list(page, appId); }
  createGrain(action: string, title: string) { return this.apps.create(action, title); }
  acknowledgeCreation() { this.apps.acknowledge(); }
  clearErrors() { this.update({ notificationError: '', grainError: '' }); }
  async logout() {
    try { await this.connection.logout(); }
    catch (error) { this.update({ connectionError: errorMessage(error) }); }
  }
  private async withNotice(shell: Shell$Client, key: string, operation: (notice: NotificationHandle$Client) => PromiseLike<unknown>) {
    const notice = shell.notification(params => { params.key = key; }).getNotice();
    try { return await this.connection.run(operation(notice), 'Update notification'); }
    finally { notice.client.close(); }
  }
  dismiss(id: string) {
    return this.mutate(shell => this.state.fixture
      ? this.connection.run(shell.dismiss(params => { params.id = Number(id); }).promise(), 'Dismiss notification')
      : this.withNotice(shell, id, async notice => unwrap((await notice.dismiss().promise()).result)));
  }
  addFixture() { return this.mutate(shell => this.connection.run(shell.addFixture().promise(), 'Add notification')); }
  openNotification(key: string) { return new NotificationView(this.connection, key); }
  async readNotification(key: string) {
    if (this.state.fixture || this.state.status !== 'ready') return;
    const account = this.accountKey;
    try {
      await this.withNotice(this.connection.shell, key, async notice => {
        const response = await notice.markRead().promise();
        unwrap(response.result);
      });
    } catch (error) {
      if (account === this.accountKey) this.update({ notificationError: applicationErrorMessage(error,
        'Could not confirm that the notification was marked as read. The action was not retried.') });
    }
  }
  markRead() { return this.mutate(async shell => unwrap((await this.connection.run(shell.markAllRead().promise(), 'Mark all notifications as read')).result)); }
  private async mutate(operation: (shell: Shell$Client) => PromiseLike<unknown>) {
    if (this.state.status !== 'ready' || this.state.pending) return;
    const id = ++this.notificationOperation;
    this.update({ pending: true, notificationError: '' });
    try { await operation(this.connection.shell); }
    catch (error) {
      if (id === this.notificationOperation) this.update({
        notificationError: applicationErrorMessage(error, 'Could not confirm the notification update. The action was not retried; its outcome may be unknown.'),
      });
    } finally { if (id === this.notificationOperation) this.update({ pending: false }); }
  }
}

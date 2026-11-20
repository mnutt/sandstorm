import { sharingState, writeRole } from './sharing-client';
import { unwrap, applicationErrorMessage } from './results';
import { writeTokenOptions } from './template-options';
import { PowerboxRequests } from './powerbox-client';
import type { PowerboxActions, PowerboxState } from './powerbox-native';
import type { SharingState } from './sharing';
import type { GrainSession$Client, Sharing$Client, ViewReference$Client } from '../generated/shell';
import type { ShellConnection } from './connection';
import type { ActiveGrain, Grain } from './model';
import { TemplateOffers } from './template';
import { runOperation } from './operations';

interface GrainState { activeGrain: ActiveGrain | null; openingGrain: boolean; grainError: string }
export class GrainService {
  private requests: PowerboxRequests;
  private session?: GrainSession$Client;
  private sharing?: Sharing$Client;
  private active: ActiveGrain | null = null;
  private opening = false;
  private renaming = false;
  private generation = 0;
  private cleanup: Promise<void> = Promise.resolve();
  private offers = new TemplateOffers();
  constructor(private connection: ShellConnection, private changed: (state: Partial<GrainState>) => void) {this.requests=new PowerboxRequests(connection);}
  reset(release = true, error?: string) {
    ++this.generation;
    this.requests.reset();
    this.offers.clear();
    try { this.sharing?.client.close(); } catch { /* already disconnected */ }
    this.sharing = undefined;
    try { if (release) this.session?.client.close(); } catch { /* already disconnected */ }
    this.session = undefined;
    this.active = null;
    this.opening = false;
    this.cleanup = Promise.resolve();
    this.changed({ activeGrain: null, openingGrain: false,
      ...(error ? {grainError:error} : this.renaming ? { grainError: 'Could not confirm rename. Check the current title before trying again.' } : {}),
    });
    this.renaming = false;
  }
  private release(session: GrainSession$Client, current = true): Promise<void> {
    const promise = Promise.resolve().then(() => session.close().promise());
    const closed = current ? this.connection.run(promise, 'Close grain') : runOperation(promise, 'Close grain');
    return closed.then(() => {}, () => {}).finally(() => {
      try { session.client.close(); } catch { /* transport already closed */ }
    });
  }
  close() {
    const session = this.session;
    const cleanup = this.cleanup;
    this.reset(false);
    this.cleanup = cleanup;
    // Navigating away is local and immediate. A subsequent open waits only for
    // bounded cleanup. Late open results are released by the generation check.
    if (session) this.cleanup = this.release(session);
  }
  async open(grainId: string, path: string, menu: Grain[]) {
    if (this.opening || this.active) return;
    const generation = ++this.generation;
    this.opening = true;
    this.changed({ openingGrain: true, grainError: '' });
    let reference: ViewReference$Client | undefined;
    try {
      await this.cleanup;
      if (generation !== this.generation) return;
      reference = this.connection.shell.grainView(params => { params.grainId = grainId; }).getView();
      const response = await this.connection.run(reference.open().promise(), 'Open grain', { onLateResult: response => {
        if (response.result._isValue) return this.release(response.result.value.session, false);
      } });
      const result = unwrap(response.result);
      if (generation !== this.generation) { void this.release(result.session, false); return; }
      let url: URL;
      try {
        url = new URL(result.view.url);
        if (url.origin !== result.view.origin || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
          throw new Error('Invalid grain session origin');
        }
      } catch (error) {
        void this.release(result.session);
        throw error;
      }
      url.searchParams.set('path', path);
      const known = menu.find(grain => grain.key === grainId);
      this.session = result.session;
      this.active = {
        ready: false,
        iconSrc: result.view.iconSrc || known?.iconSrc || '',
        grainId, path, origin: result.view.origin, url: url.href,
        title: result.view.title || known?.title || 'Grain',
        ownerTitle: result.view.ownerTitle || known?.ownerTitle || '',
        mainHref: result.view.mainHref || known?.href || location.origin + '/main-shell',
      };
      this.changed({ activeGrain: this.active });
      void result.session.whenReady().promise().then(response => {
        unwrap(response.result);
        if (generation !== this.generation || !this.active) return;
        this.active = {...this.active, ready: true};
        this.changed({activeGrain:this.active});
      }).catch(() => { /* Iframe load and the existing slow-load UI remain available. */ });

      const ended = () => {
        if (generation !== this.generation) return;
        this.reset(true, 'This grain session ended. Reopen the grain to continue.');
      };
      void result.session.whenClosed().promise().then(ended, ended);
    } catch (error) {
      if (generation === this.generation) this.changed({ grainError: applicationErrorMessage(error, 'Unable to open grain. Please try opening it again.') });
    } finally {
      reference?.client.close();
      if (generation === this.generation) {
        this.opening = false;
        this.changed({ openingGrain: false });
      }
    }
  }
  pathChanged(path: string) {
    if (this.active) { this.active = { ...this.active, path }; this.changed({activeGrain:this.active}); }
  }
  applyMenu(grains: Grain[]) {
    const active = this.active;
    const updated = active && grains.find(grain => grain.key === active.grainId);
    if (active && updated && (active.title !== updated.title || active.ownerTitle !== updated.ownerTitle || active.iconSrc !== updated.iconSrc)) {
      this.active = { ...active, title: updated.title, ownerTitle: updated.ownerTitle, iconSrc: updated.iconSrc };
      this.changed({ activeGrain: this.active });
    }
  }
  async rename(title: string) {
    const generation = this.generation;
    const session = this.session;
    if (!session || !this.active) throw new Error('No active grain.');
    if (this.renaming) throw new Error('A rename is already pending.');
    this.renaming = true;
    try {
      const response = await this.connection.run(session.rename(params => { params.title = title; }).promise(), 'Rename grain');
      const result = unwrap(response.result);
      if (generation !== this.generation || !this.active) throw new Error('Grain session changed.');
      this.active = { ...this.active, title: result.title, ownerTitle: result.ownerTitle || this.active.ownerTitle };
      this.changed({ activeGrain: this.active, grainError: '' });
    } catch (error) {
      const message = applicationErrorMessage(error, 'Could not confirm rename. Check the current title before trying again.');
      if (generation === this.generation) this.changed({ grainError: message });
      throw new Error(message);
    } finally { if (generation === this.generation) this.renaming = false; }
  }
  async powerbox(request: string, operation: Parameters<PowerboxActions['call']>[1], input: Record<string, unknown> = {}): Promise<PowerboxState> {
    const session = this.session;
    const generation = this.generation;
    if (!session) throw new Error('No active grain.');
    const result = await this.requests.call(session,request,operation,input);
    if (generation !== this.generation) throw new Error('Grain session changed.');
    return result;
  }

  private sharingClient() {
    if (!this.session) throw new Error('No active grain.');
    return this.sharing ??= this.session.sharing().getSharing();
  }
  async sharingState(): Promise<SharingState> {
    const generation = this.generation;
    const result = await this.connection.run(this.sharingClient().read().promise(), 'Load sharing');
    if (generation !== this.generation) throw new Error('Grain session changed.');
    return sharingState(unwrap(result.result));
  }
  async createShare(label: string, role: string): Promise<string> {
    const generation = this.generation;
    const result = await this.connection.run(this.sharingClient().create(params => {
      params.label = label; writeRole(role, params._initRole());
    }).promise(), 'Create sharing link');
    if (generation !== this.generation) throw new Error('Grain session changed. Check sharing links before trying again.');
    return unwrap(result.result).token;
  }
  async editShare(id: string, label: string, role?: string): Promise<void> {
    const generation = this.generation;
    const result = await this.connection.run(this.sharingClient().edit(params => {
      params.id = id; params.label = label;
      const change = params._initRole();
      if (role === undefined) change.unchanged = true;
      else writeRole(role, change._initSet());
    }).promise(), 'Edit sharing');
    if (generation !== this.generation) throw new Error('Grain session changed.');
    unwrap(result.result);
  }
  async revokeShare(id: string): Promise<void> {
    const generation = this.generation;
    const result = await this.connection.run(this.sharingClient().revoke(params => {params.id = id;}).promise(), 'Revoke sharing');
    if (generation !== this.generation) throw new Error('Grain session changed.');
    unwrap(result.result);
  }
  async renderTemplate(input: unknown) {
    const session = this.session;
    const active = this.active;
    if (!session || !active) throw new Error('No active grain.');
    return this.offers.render(input, active.title, async options => {
      try {
        const response = await this.connection.run(session.renderTemplate(params => {
          writeTokenOptions(params._initOptions(), options);
        }).promise(), 'Render template');
        const result = unwrap(response.result);
        return { token: result.token, host: result.host };
      } catch (error) {
        throw new Error(applicationErrorMessage(error, 'Could not confirm API token creation. Please try again.'));
      }
    });
  }
}

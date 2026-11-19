import type { GrainSession$Client } from '../generated/shell';
import type { ShellConnection } from './connection';
import type { ActiveGrain, Grain } from './model';
import { TemplateOffers } from './template';
import { errorMessage, runOperation } from './operations';

interface GrainState { activeGrain: ActiveGrain | null; openingGrain: boolean; grainError: string }
export class GrainService {
  private session?: GrainSession$Client;
  private active: ActiveGrain | null = null;
  private opening = false;
  private renaming = false;
  private generation = 0;
  private cleanup: Promise<void> = Promise.resolve();
  private offers = new TemplateOffers();
  constructor(private connection: ShellConnection, private changed: (state: Partial<GrainState>) => void) {}
  reset(release = true) {
    ++this.generation;
    this.offers.clear();
    try { if (release) this.session?.client.close(); } catch { /* already disconnected */ }
    this.session = undefined;
    this.active = null;
    this.opening = false;
    this.cleanup = Promise.resolve();
    this.changed({ activeGrain: null, openingGrain: false,
      ...(this.renaming ? { grainError: 'Could not confirm rename. Check the current title before trying again.' } : {}),
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
  close(reconnectPending = true) {
    const session = this.session;
    const opening = this.opening;
    const cleanup = this.cleanup;
    this.reset(false);
    this.cleanup = cleanup;
    // Navigating away is local and immediate. A subsequent open waits only for
    // bounded cleanup; cancelling an in-flight open discards that RPC scope.
    if (opening && reconnectPending) this.connection.reconnect();
    else if (session) this.cleanup = this.release(session);
  }
  async open(grainId: string, path: string, menu: Grain[]) {
    if (this.opening || this.active) return;
    const generation = ++this.generation;
    this.opening = true;
    this.changed({ openingGrain: true, grainError: '' });
    try {
      await this.cleanup;
      if (generation !== this.generation) return;
      const result = await this.connection.run(this.connection.shell.openGrain(params => {
        params.grainId = grainId;
      }).promise(), 'Open grain', { onLateResult: result => this.release(result.session, false) });
      if (generation !== this.generation) { void this.release(result.session, false); return; }
      const url = new URL(result.view.url);
      if (url.origin !== result.view.origin || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        void this.release(result.session);
        throw new Error('Invalid grain session origin');
      }
      url.searchParams.set('path', path);
      const known = menu.find(grain => grain.key === grainId);
      this.session = result.session;
      this.active = {
        iconSrc: result.view.iconSrc || known?.iconSrc || '',
        grainId, path, origin: result.view.origin, url: url.href,
        title: result.view.title || known?.title || 'Grain',
        ownerTitle: result.view.ownerTitle || known?.ownerTitle || '',
        mainHref: result.view.mainHref || known?.href || location.origin + '/main-shell',
      };
      this.changed({ activeGrain: this.active });
    } catch (error) {
      if (generation === this.generation) this.changed({ grainError: `Unable to open grain: ${errorMessage(error)}` });
    } finally {
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
      const result = await this.connection.run(session.rename(params => { params.title = title; }).promise(), 'Rename grain');
      if (generation !== this.generation || !this.active) throw new Error('Grain session changed.');
      this.active = { ...this.active, title: result.title, ownerTitle: result.ownerTitle || this.active.ownerTitle };
      this.changed({ activeGrain: this.active, grainError: '' });
    } catch (error) {
      if (generation === this.generation) this.changed({ grainError: `Could not confirm rename. Check the current title before trying again. ${errorMessage(error)}` });
      throw error;
    } finally { if (generation === this.generation) this.renaming = false; }
  }
  async renderTemplate(input: unknown) {
    const session = this.session;
    const active = this.active;
    if (!session || !active) throw new Error('No active grain.');
    return this.offers.render(input, active.title, async options => {
      const result = await this.connection.run(session.renderTemplate(params => { params.options = options; }).promise(), 'Render template');
      return { token: result.token, host: result.host };
    });
  }
}

import { TemplateOffers } from './template';
import { Conn } from 'capnp-es';
import { Observer, Shell, type Shell$Client, type Subscription$Client, type GrainSession$Client } from '../generated/shell';
import { WebSocketTransport } from './transport';

export interface Notification { id: string; title: string; body: string; href: string; unread: boolean; ongoing: boolean; timestamp: string; senderName: string }
export interface Grain { key: string; title: string; href: string; owned: boolean; lastUsed: string; appTitle: string }
export interface AppAction { key: string; title: string; appTitle: string }
export interface ActiveGrain { path: string; grainId: string; origin: string; url: string; title: string; mainHref: string }
export interface ShellState {
  activeGrain: ActiveGrain | null;
  openingGrain: boolean;
  grains: Grain[];
  grainsLimited: boolean;
  status: 'waiting' | 'connecting' | 'ready' | 'reconnecting' | 'stopped' | 'signed-out';
  entries: Notification[];
  revision: number;
  error: string;
  pending: boolean;
  fixture: boolean;
  account: string | null;
  total: number;
}

class MainShellUnavailable extends Error {}

// Owns all live capabilities. Svelte receives only decoded values.
export class ShellService {
  private state: ShellState = { status: 'connecting', entries: [], grains: [], grainsLimited: false, activeGrain: null, openingGrain: false, revision: 0, error: '', pending: false, fixture: true, account: null, total: 0 };
  private offers = new TemplateOffers();
  private grainSession?: GrainSession$Client;
  private grainGeneration = 0;
  private conn?: Conn;
  private socket?: WebSocket;
  private shell?: Shell$Client;
  private subscription?: Subscription$Client;
  private timer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private authRequest?: AbortController;
  private generation = 0;
  private stopped = true;
  private retry = 500;

  constructor(private changed: (state: ShellState) => void) {}

  private update(patch: Partial<ShellState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }

  start() { if (this.stopped) { this.stopped = false; this.connect(); } }

  private clearConnection() {
    this.offers.clear();
    ++this.grainGeneration;
    // Release may try to send on an already broken transport. Teardown must
    // still clear the iframe; the server scope/lease owns remote cleanup.
    try { this.grainSession?.client.close(); } catch { /* transport already closed */ }
    this.grainSession = undefined;
    clearTimeout(this.deadline);
    this.authRequest?.abort();
    this.authRequest = undefined;
    this.subscription = undefined;
    this.shell = undefined;
    this.conn?.shutdown();
    this.conn = undefined;
    if (this.socket) {
      this.socket.onopen = this.socket.onclose = this.socket.onerror = null;
      this.socket.close();
      this.socket = undefined;
    }
  }

  private async connect() {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.clearConnection();
    const fail = (error: Error) => {
      if (generation !== this.generation || this.stopped) return;
      ++this.generation;
      this.clearConnection();
      this.update({ status: error instanceof MainShellUnavailable ? 'waiting' : 'reconnecting', entries: [], grains: [], grainsLimited: false, activeGrain: null, openingGrain: false, pending: false, error: error instanceof MainShellUnavailable ? '' : error.message });
      this.timer = setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 5000);
    };
    try {
      const controller = this.authRequest = new AbortController();
      this.deadline = setTimeout(() => controller.abort(), 10000);
      const response = await fetch('/auth/session', { cache: 'no-store', signal: controller.signal });
      if (generation !== this.generation || this.stopped) return;
      if (response.status === 401) {
        clearTimeout(this.deadline);
        this.authRequest = undefined;
        this.update({ status: 'signed-out', entries: [], grains: [], grainsLimited: false, activeGrain: null, openingGrain: false, account: null, fixture: false, error: '', pending: false, total: 0 });
        return;
      }
      if (response.status === 502 || response.status === 503) throw new MainShellUnavailable();
      const session = await response.json();
      if (generation !== this.generation || this.stopped) return;
      if (!response.ok) throw new Error(session.error || 'Unable to check your session');
      clearTimeout(this.deadline);
      this.authRequest = undefined;
      this.update({ fixture: session.fixture, account: session.account?.name || null });
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
    const url = new URL('/rpc', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.socket = new WebSocket(url);
    socket.onerror = () => fail(new Error('Unable to connect to the Rust shell'));
    socket.onclose = () => fail(new Error('Connection closed'));
    this.deadline = setTimeout(() => fail(new Error('Live updates did not start. Retrying…')), 10000);
    socket.onopen = async () => {
      if (generation !== this.generation) return;
      try {
        const conn = this.conn = new Conn(new WebSocketTransport(socket, fail));
        conn.onError = (error) => fail(error instanceof Error ? error : new Error(String(error)));
        const shell = this.shell = conn.bootstrap(Shell);
        const observer = new Observer.Server({
          replace: async (params) => {
            if (generation !== this.generation) return;
            const snapshot = params.snapshot;
            const entries: Notification[] = [];
            for (const entry of snapshot.entries) entries.push({ id: entry.key || String(entry.id), title: entry.title, body: entry.body,
              href: entry.href, unread: entry.unread, ongoing: entry.ongoing, timestamp: entry.timestamp, senderName: entry.senderName });
            clearTimeout(this.deadline);
            this.retry = 500;
            const grains: Grain[] = [];
            for (const grain of snapshot.grains) grains.push({ key: grain.key, title: grain.title,
              href: grain.href, owned: grain.owned, lastUsed: grain.lastUsed, appTitle: grain.appTitle });
            this.update({ status: 'ready', entries, grains, grainsLimited: snapshot.grainsLimited, revision: snapshot.revision, total: snapshot.total, error: '' });
          },
        }).client();
        const result = await shell.watch((params) => { params.observer = observer; }).promise();
        if (generation === this.generation) {
          this.subscription = result.subscription;
          void result.subscription.whenClosed().promise().then(
            () => fail(new Error('Live updates stopped. Reconnecting…')),
            () => fail(new Error('Live updates failed. Reconnecting…')),
          );
        }
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    };
  }

  async closeGrain() {
    this.offers.clear();
    ++this.grainGeneration;
    const session = this.grainSession;
    this.grainSession = undefined;
    this.update({ activeGrain: null, openingGrain: false });
    if (session) {
      try { await session.close().promise(); }
      finally { session.client.close(); }
    }
  }

  async listApps() {
    const generation = this.generation;
    if (!this.shell || this.state.status !== 'ready') throw new Error('Connect to Sandstorm first.');
    const result = await this.shell.listApps().promise();
    if (generation !== this.generation) throw new Error('Connection changed.');
    const actions: AppAction[] = [];
    for (const action of result.actions) actions.push({key: action.key, title: action.title, appTitle: action.appTitle});
    return {actions, limited: result.limited};
  }

  async createGrain(actionId: string, title: string) {
    const generation = this.generation;
    if (!this.shell || this.state.status !== 'ready') throw new Error('Connect to Sandstorm first.');
    // One attempt, with an explicit unknown-outcome error on disconnect/timeout.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.shell.createGrain(params => { params.actionId = actionId; params.title = title; }).promise(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Creation timed out.')), 10000); }),
      ]);
      if (generation !== this.generation) throw new Error('Connection changed.');
      return result.grainId;
    } finally { clearTimeout(timeout); }
  }

  async renderTemplate(input: unknown) {
    const session = this.grainSession;
    const grain = this.state.activeGrain;
    if (!session || !grain) throw new Error('No active grain.');
    return this.offers.render(input, grain.title, async options => {
      const result = await session.renderTemplate(params => { params.options = options; }).promise();
      return { token: result.token, host: result.host };
    });
  }

  async openGrain(requested: Grain | string, path = '/') {
    const grain = typeof requested === 'string' ? this.state.grains.find(g => g.key === requested) ||
      { key: requested, title: 'Grain', href: location.origin + '/main-shell' } : requested;
    if (!this.shell || this.state.status !== 'ready' || this.state.openingGrain) return;
    const generation = this.generation;
    try { await this.closeGrain(); }
    catch { this.reconnect(); return; }
    if (!this.shell || generation !== this.generation) return;
    const operation = ++this.grainGeneration;
    this.update({ openingGrain: true, error: '' });
    try {
      const result = await this.shell.openGrain((params) => { params.grainId = grain.key; }).promise();
      if (generation !== this.generation || operation !== this.grainGeneration) {
        await result.session.close().promise().catch(() => {});
        result.session.client.close();
        return;
      }
      const url = new URL(result.view.url);
      if (url.origin !== result.view.origin || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        await result.session.close().promise().catch(() => {});
        result.session.client.close();
        throw new Error('Invalid grain session origin');
      }
      url.searchParams.set('path', path);
      this.grainSession = result.session;
      this.update({ activeGrain: { path, grainId: result.view.grainId, origin: result.view.origin,
        url: url.href, title: result.view.title || grain.title, mainHref: result.view.mainHref || grain.href }, openingGrain: false });
    } catch (error) {
      if (generation === this.generation && operation === this.grainGeneration) {
        this.update({ openingGrain: false, error: `Unable to open grain: ${String(error)}` });
      }
    }
  }

  async dismiss(id: string) {
    await this.mutate((shell) => this.state.fixture
      ? shell.dismiss((params) => { params.id = Number(id); }).promise()
      : shell.dismissReal((params) => { params.key = id; }).promise());
  }
  async addFixture() { await this.mutate((shell) => shell.addFixture().promise()); }
  async markRead() { await this.mutate((shell) => shell.markRead().promise()); }
  async logout() {
    try {
      const response = await fetch('/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Unable to disconnect. Please try again.');
      ++this.generation;
      clearTimeout(this.timer);
      this.clearConnection();
      this.update({ status: 'signed-out', entries: [], grains: [], grainsLimited: false, activeGrain: null, openingGrain: false, account: null, total: 0, pending: false, error: '' });
    } catch (error) { this.update({ error: String(error) }); }
  }

  private async mutate(operation: (shell: Shell$Client) => Promise<unknown>) {
    if (!this.shell || this.state.status !== 'ready' || this.state.pending) return;
    const generation = this.generation;
    this.update({ pending: true, error: '' });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        operation(this.shell),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Request timed out')), 10000); }),
      ]);
    } catch (error) {
      // Never replay a mutation on reconnect: the server may have applied it already.
      if (!this.stopped && generation === this.generation) this.update({ error: `${error instanceof Error ? error.message : String(error)}. The action was not retried; its outcome may be unknown.` });
    } finally {
      clearTimeout(timeout);
      if (generation === this.generation) this.update({ pending: false });
    }
  }

  reconnect() {
    ++this.generation;
    clearTimeout(this.timer);
    this.update({ status: 'connecting', entries: [], grains: [], grainsLimited: false, activeGrain: null, openingGrain: false, error: '', pending: false });
    this.connect();
  }

  stop() {
    this.stopped = true;
    ++this.generation;
    clearTimeout(this.timer);
    // Explicit cancellation is best effort; closing the connection also releases it.
    void this.subscription?.cancel().promise().catch(() => {});
    this.clearConnection();
    this.update({ status: 'stopped', entries: [], grains: [], grainsLimited: false, activeGrain: null, openingGrain: false, pending: false });
  }
}

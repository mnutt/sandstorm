import { Conn } from 'capnp-es';
import { Observer, Shell, type Shell$Client, type Subscription$Client } from '../generated/shell';
import { WebSocketTransport } from './transport';

export interface Notification { id: string; title: string; body: string; href: string; unread: boolean; ongoing: boolean; timestamp: string }
export interface NotificationState {
  status: 'connecting' | 'ready' | 'reconnecting' | 'stopped' | 'signed-out';
  entries: Notification[];
  revision: number;
  error: string;
  pending: boolean;
  fixture: boolean;
  account: string | null;
  total: number;
}

// Owns all live capabilities. Svelte receives only decoded values.
export class NotificationsService {
  private state: NotificationState = { status: 'connecting', entries: [], revision: 0, error: '', pending: false, fixture: true, account: null, total: 0 };
  private conn?: Conn;
  private socket?: WebSocket;
  private shell?: Shell$Client;
  private subscription?: Subscription$Client;
  private timer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private stopped = true;
  private retry = 500;

  constructor(private changed: (state: NotificationState) => void) {}

  private update(patch: Partial<NotificationState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }

  start() { if (this.stopped) { this.stopped = false; this.connect(); } }

  private clearConnection() {
    clearTimeout(this.deadline);
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
      this.update({ status: 'reconnecting', entries: [], pending: false, error: error.message });
      this.timer = setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 5000);
    };
    try {
      const response = await fetch('/auth/session', { cache: 'no-store' });
      if (generation !== this.generation || this.stopped) return;
      if (response.status === 401) {
        this.update({ status: 'signed-out', entries: [], account: null, fixture: false, error: '', pending: false, total: 0 });
        return;
      }
      const session = await response.json();
      if (generation !== this.generation || this.stopped) return;
      if (!response.ok) throw new Error(session.error || 'Unable to check your session');
      this.update({ fixture: session.fixture, account: session.account?.name || null });
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
    const url = new URL('/rpc', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.socket = new WebSocket(url);
    socket.onerror = () => fail(new Error('Unable to connect to the Rust shell'));
    socket.onclose = () => fail(new Error('Connection closed'));
    this.deadline = setTimeout(() => fail(new Error('Subscription timed out')), 10000);
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
              href: entry.href, unread: entry.unread, ongoing: entry.ongoing, timestamp: entry.timestamp });
            clearTimeout(this.deadline);
            this.retry = 500;
            this.update({ status: 'ready', entries, revision: snapshot.revision, total: snapshot.total, error: '' });
          },
        }).client();
        const result = await shell.watch((params) => { params.observer = observer; }).promise();
        if (generation === this.generation) this.subscription = result.subscription;
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    };
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
      this.update({ status: 'signed-out', entries: [], account: null, total: 0, pending: false, error: '' });
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
    this.update({ status: 'connecting', entries: [], error: '', pending: false });
    this.connect();
  }

  stop() {
    this.stopped = true;
    ++this.generation;
    clearTimeout(this.timer);
    // Explicit cancellation is best effort; closing the connection also releases it.
    void this.subscription?.cancel().promise().catch(() => {});
    this.clearConnection();
    this.update({ status: 'stopped', entries: [], pending: false });
  }
}

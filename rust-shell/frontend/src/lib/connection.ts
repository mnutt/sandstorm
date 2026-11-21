import { Conn } from 'capnp-es';
import { Observer, Shell, type Shell$Client, type Installer$Client, type Account$Client, type Subscription$Client, type Snapshot } from '../generated/shell';
import type { ConnectionStatus } from './model';
import { runOperation, type OperationOptions } from './operations';
import { WebSocketTransport } from './transport';

interface SessionInfo { fixture: boolean; account: { name: string; key: string; pictureUrl?: string } | null }
interface ConnectionEvents {
  reset: () => void;
  session: (session: SessionInfo) => void;
  status: (status: ConnectionStatus, error: string) => void;
  snapshot: (snapshot: Snapshot) => void;
}
class MainShellUnavailable extends Error {}

// Sole owner of authentication, reconnect policy, transport and subscription.
export class ShellConnection {
  private conn?: Conn;
  private socket?: WebSocket;
  private client?: Shell$Client;
  private installerClient?: Installer$Client;
  private accountClient?: Account$Client;
  private subscription?: Subscription$Client;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private lifetime = new AbortController();
  private stopped = true;
  private retry = 500;
  private generation = 0;

  constructor(private events: ConnectionEvents) {}
  get signal() { return this.lifetime.signal; }
  get shell() {
    if (!this.client) throw new Error('Connect to Sandstorm first.');
    return this.client;
  }
  get installer() { return this.installerClient ??= this.shell.installer().getInstaller(); }
  get account() { return this.accountClient ??= this.shell.account().getAccount(); }
  run<T>(promise: PromiseLike<T>, label: string, options: OperationOptions<T> = {}) {
    // A UI deadline says nothing about the health of other capabilities or
    // whether a mutation completed. Transport/subscription failure owns reconnect.
    return runOperation(promise, label, {...options, signal: options.signal ?? this.signal});
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }
  private clear() {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    clearTimeout(this.startupTimer);
    this.events.reset();
    this.subscription = undefined;
    this.client = undefined;
    this.installerClient = undefined;
    this.accountClient = undefined;
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
    this.clear();
    const fail = (error: Error) => {
      if (generation !== this.generation || this.stopped) return;
      ++this.generation;
      this.clear();
      this.events.status(error instanceof MainShellUnavailable ? 'waiting' : 'reconnecting',
        error instanceof MainShellUnavailable ? '' : error.message);
      this.retryTimer = setTimeout(() => void this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 5000);
    };
    try {
      const signal = AbortSignal.any([this.signal, AbortSignal.timeout(10000)]);
      const response = await fetch('/auth/session', { cache: 'no-store', signal });
      if (generation !== this.generation || this.stopped) return;
      if (response.status === 401) {
        this.events.session({ fixture: false, account: null });
        this.events.status('signed-out', '');
        return;
      }
      if (response.status === 502 || response.status === 503) throw new MainShellUnavailable();
      const session = await response.json();
      if (generation !== this.generation || this.stopped) return;
      if (!response.ok) throw new Error(session.error || 'Unable to check your session');
      this.events.session(session);
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
    const url = new URL('/rpc', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.socket = new WebSocket(url);
    socket.onerror = () => fail(new Error('Unable to connect to the Rust shell'));
    socket.onclose = () => fail(new Error('Connection closed'));
    this.startupTimer = setTimeout(() => fail(new Error('Live updates did not start. Retrying…')), 10000);
    socket.onopen = async () => {
      if (generation !== this.generation) return;
      try {
        const conn = this.conn = new Conn(new WebSocketTransport(socket, () => fail(new Error('Connection interrupted. Reconnecting…'))));
        conn.onError = () => fail(new Error('Connection interrupted. Reconnecting…'));
        const shell = this.client = conn.bootstrap(Shell);
        const observer = new Observer.Server({ replace: async params => {
          if (generation !== this.generation) return;
          clearTimeout(this.startupTimer);
          this.retry = 500;
          this.events.snapshot(params.snapshot);
        } }).client();
        const result = await this.run(shell.watch(params => { params.observer = observer; }).promise(), 'Subscribe');
        if (generation !== this.generation) return;
        this.subscription = result.subscription;
        // This is a lifetime signal, deliberately not an ordinary timed RPC.
        void result.subscription.whenClosed().promise().then(
          () => fail(new Error('Live updates stopped. Reconnecting…')),
          () => fail(new Error('Live updates failed. Reconnecting…')),
        );
      } catch { fail(new Error('Live updates could not start. Retrying…')); }
    };
  }
  reconnect() {
    clearTimeout(this.retryTimer);
    ++this.generation;
    this.events.status('connecting', '');
    void this.connect();
  }
  async logout() {
    // Ignore transport closure caused by revocation while awaiting the logout
    // response; reconnecting here could abort the IdP redirect response.
    const generation = ++this.generation;
    clearTimeout(this.retryTimer);
    try {
      const response = await fetch('/auth/logout', {
        method: 'POST', signal: AbortSignal.any([this.signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok) throw new Error('Unable to disconnect. Please try again.');
      const result = await response.json();
      if (generation !== this.generation) return;
      this.clear();
      this.events.session({ fixture: false, account: null });
      this.events.status('signed-out', typeof result.warning === 'string' ? result.warning : '');
      if (result.redirectUrl) location.assign(result.redirectUrl);
    } catch (error) {
      if (generation === this.generation) this.reconnect();
      throw error;
    }
  }
  stop() {
    this.stopped = true;
    ++this.generation;
    clearTimeout(this.retryTimer);
    void this.subscription?.cancel().promise().catch(() => {});
    this.clear();
    this.events.status('stopped', '');
  }
}

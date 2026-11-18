// One chooser per active frame. Secrets travel in messages, never in popup URLs.
export class PowerboxChooser {
  private pending?: { request: Record<string, unknown>; popup?: Window; nonce: string; sent: boolean; timer: ReturnType<typeof setInterval> };
  constructor(private mainOrigin: string, private sessionId: string,
    private reply: (value: Record<string, unknown>) => void, private changed: (pending: boolean) => void) {}

  request(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const request = value as Record<string, unknown>;
    if (typeof request.rpcId !== 'string' && typeof request.rpcId !== 'number') return;
    if (this.pending) { this.reply({ rpcId: request.rpcId, error: 'A Powerbox request is already open.' }); return; }
    if ((typeof request.rpcId === 'string' && request.rpcId.length > 256) ||
        (request.query !== undefined && (!Array.isArray(request.query) || request.query.length > 32 ||
          request.query.some(q => typeof q !== 'string' || q.length > 8192))) ||
        (request.saveLabel !== undefined && (!request.saveLabel || typeof request.saveLabel !== 'object' ||
          typeof (request.saveLabel as { defaultText?: unknown }).defaultText !== 'string')) || JSON.stringify(request).length > 65536) {
      this.reply({ rpcId: request.rpcId, error: 'Invalid Powerbox request.' }); return;
    }
    const expires = Date.now() + 5 * 60 * 1000;
    const timer = setInterval(() => {
      if (this.pending?.popup?.closed || Date.now() >= expires) this.cancel();
    }, 500);
    this.pending = { request: { rpcId: request.rpcId, query: request.query, saveLabel: request.saveLabel },
      nonce: crypto.randomUUID(), sent: false, timer };
    this.changed(true);
  }
  open() {
    const pending = this.pending;
    if (!pending) return;
    if (pending.popup && !pending.popup.closed) { pending.popup.focus(); return; }
    pending.popup = window.open(this.mainOrigin + '/rust-shell-powerbox', '_blank', 'popup,width=760,height=760') || undefined;
  }
  message(event: MessageEvent) {
    const pending = this.pending;
    if (!pending?.popup || event.source !== pending.popup || event.origin !== this.mainOrigin) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'rust-powerbox-ready' && !pending.sent) {
      pending.sent = true;
      pending.popup.postMessage({ type: 'rust-powerbox-request', nonce: pending.nonce,
        sessionId: this.sessionId, request: pending.request }, this.mainOrigin);
    } else if (data.type === 'rust-powerbox-result' && data.nonce === pending.nonce && pending.sent) {
      const result = data.result;
      if (!result || typeof result !== 'object' || result.rpcId !== pending.request.rpcId) return;
      if (result.canceled === true) this.finish({ rpcId: result.rpcId, canceled: true });
      else if (typeof result.error === 'string') this.finish({ rpcId: result.rpcId, error: result.error });
      else if (typeof result.token === 'string' && result.token.length <= 16384 &&
          (result.descriptor === undefined || (typeof result.descriptor === 'string' && result.descriptor.length <= 65536))) {
        this.finish({ rpcId: result.rpcId, token: result.token, descriptor: result.descriptor });
      }
    }
  }
  private finish(result: Record<string, unknown>) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearInterval(pending.timer);
    pending.popup?.close();
    this.changed(false);
    this.reply(result);
  }
  cancel() { if (this.pending) this.finish({ rpcId: this.pending.request.rpcId, canceled: true }); }
}

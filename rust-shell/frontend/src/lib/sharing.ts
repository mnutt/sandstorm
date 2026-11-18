// Reuse Meteor's sharing UI; never transfer sharing tokens back to the app.
export class SharingWindow {
  private pending?: { mode: 'share' | 'access'; shareData: Record<string, string>; nonce: string;
    popup?: Window; sent: boolean; opened: boolean; timer: ReturnType<typeof setInterval> };
  constructor(private mainOrigin: string, private sessionId: string,
    private changed: (message: string) => void) {}
  request(mode: 'share' | 'access', value: unknown = {}) {
    if (this.pending) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const data = value as Record<string, unknown>;
    if (Object.keys(data).some(key => !['pathname', 'hash'].includes(key)) ||
        Object.values(data).some(v => typeof v !== 'string' || v.length > 2048 || /[\x00-\x1f\x7f\\]/.test(v)) ||
        (typeof data.pathname === 'string' && (data.pathname.startsWith('//') || /(^|\/)(\.|%2e){2}(\/|$)/i.test(data.pathname)))) return;
    const expires = Date.now() + 60000;
    const timer = setInterval(() => {
      if (this.pending?.popup?.closed) this.cancel();
      else if (!this.pending?.opened && Date.now() >= expires) this.cancel('Sharing request expired. Try again.');
    }, 500);
    this.pending = { mode, shareData: data as Record<string, string>, nonce: crypto.randomUUID(), sent: false, opened: false, timer };
    this.changed(mode === 'share' ? 'Open sharing in Sandstorm.' : 'View who has access in Sandstorm.');
  }
  open() {
    if (!this.pending) return;
    if (this.pending.popup && !this.pending.popup.closed) { this.pending.popup.focus(); return; }
    this.pending.popup = window.open(this.mainOrigin + '/rust-shell-sharing', '_blank', 'popup,width=900,height=800') || undefined;
  }
  message(event: MessageEvent) {
    const pending = this.pending;
    if (!pending?.popup || event.source !== pending.popup || event.origin !== this.mainOrigin) return;
    const data = event.data;
    if (data?.type === 'rust-sharing-ready' && !pending.sent) {
      pending.sent = true;
      pending.popup.postMessage({ type: 'rust-sharing-request', nonce: pending.nonce, sessionId: this.sessionId,
        mode: pending.mode, shareData: pending.shareData }, this.mainOrigin);
    } else if (data?.type === 'rust-sharing-result' && pending.sent && data.nonce === pending.nonce) {
      if (typeof data.error === 'string') this.cancel(data.error.slice(0, 256));
      else if (data.opened === true) { pending.opened = true; this.changed('Sharing is open in Sandstorm.'); }
    }
  }
  cancel(message = '') {
    if (this.pending) { clearInterval(this.pending.timer); this.pending.popup?.close(); this.pending = undefined; }
    this.changed(message);
  }
}

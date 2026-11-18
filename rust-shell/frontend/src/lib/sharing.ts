import { record, shareData } from './protocol';

export type SharingState =
  | { status: 'idle' }
  | { status: 'pending' | 'blocked' | 'open' | 'failed'; message: string };
interface PendingSharing {
  mode: 'share' | 'access';
  shareData: Record<string, string>;
  nonce: string;
  popup?: Window;
  sent: boolean;
  opened: boolean;
  timer: ReturnType<typeof setInterval>;
}

// Reuse Meteor's sharing UI; never transfer sharing tokens back to the app.
export class SharingWindow {
  private pending?: PendingSharing;
  constructor(private mainOrigin: string, private sessionId: string,
    private changed: (state: SharingState) => void) {}
  request(mode: 'share' | 'access', value: unknown = {}) {
    if (this.pending) return;
    const data = shareData(value);
    if (!data) return;
    const expires = Date.now() + 60000;
    const timer = setInterval(() => {
      if (this.pending?.popup?.closed) this.cancel();
      else if (!this.pending?.opened && Date.now() >= expires) this.cancel('Sharing request expired. Try Share or Who has access again.');
    }, 500);
    this.pending = { mode, shareData: data, nonce: crypto.randomUUID(), sent: false, opened: false, timer };
    this.changed({ status: 'pending', message: mode === 'share' ? 'Open sharing in Sandstorm.' : 'View who has access in Sandstorm.' });
  }
  open() {
    const pending = this.pending;
    if (!pending) return;
    if (pending.popup && !pending.popup.closed) { pending.popup.focus(); return; }
    pending.popup = window.open(this.mainOrigin + '/rust-shell-sharing', '_blank', 'popup,width=900,height=800') || undefined;
    this.changed(pending.popup
      ? { status: 'pending', message: 'Opening sharing in Sandstorm…' }
      : { status: 'blocked', message: 'The browser blocked the sharing window. Allow popups, then try again.' });
  }
  message(event: MessageEvent) {
    const pending = this.pending;
    if (!pending?.popup || event.source !== pending.popup || event.origin !== this.mainOrigin) return;
    const data = record(event.data);
    if (data?.type === 'rust-sharing-ready' && !pending.sent) {
      pending.sent = true;
      pending.popup.postMessage({ type: 'rust-sharing-request', nonce: pending.nonce, sessionId: this.sessionId,
        mode: pending.mode, shareData: pending.shareData }, this.mainOrigin);
    } else if (data?.type === 'rust-sharing-result' && pending.sent && data.nonce === pending.nonce) {
      if (typeof data.error === 'string') this.cancel(data.error.slice(0, 256));
      else if (data.opened === true) {
        pending.opened = true;
        this.changed({ status: 'open', message: 'Sharing is open in Sandstorm.' });
      }
    }
  }
  cancel(message = '') {
    if (this.pending) {
      clearInterval(this.pending.timer);
      this.pending.popup?.close();
      this.pending = undefined;
    }
    this.changed(message ? { status: 'failed', message } : { status: 'idle' });
  }
}

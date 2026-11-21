// Protocol-independent ownership of pending authorizations. Protocol adapters
// retain recognizable IDs after removal; no tombstone collection is required.
export class AuthorizationAttempts {
  #entries = new Map();
  constructor({lifetime = 300000, now = () => Date.now(), onRemove = () => {},
    onDiscard = async () => {}, onError = error => console.error("Authorization cleanup failed", error),
    schedule = setTimeout, unschedule = clearTimeout} = {}) {
    Object.assign(this, {lifetime, now, onRemove, onDiscard, onError, schedule, unschedule});
  }
  set(key, data) {
    if (this.#entries.has(key)) throw new Error("Authorization already exists.");
    const timer = this.schedule(() => { void this.discard(key).catch(this.onError); }, this.lifetime);
    timer.unref?.();
    this.#entries.set(key, {...data, expires:this.now()+this.lifetime, timer});
  }
  get(key) {
    const entry = this.#entries.get(key);
    if (entry && entry.expires <= this.now()) {
      void this.discard(key).catch(this.onError);
      return undefined;
    }
    return entry;
  }
  take(key) {
    const entry = this.get(key);
    if (entry) this.#remove(key, entry);
    return entry;
  }
  #remove(key, entry) {
    this.#entries.delete(key);
    this.unschedule(entry.timer);
    this.onRemove(key, entry);
  }
  async discard(key) {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#remove(key, entry); // Revoke synchronously, before asynchronous cleanup.
    await this.onDiscard(key, entry);
  }
}

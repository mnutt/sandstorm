import { templateRequest } from './protocol';
import { tokenOptions, type TokenOptions } from './template-options';
const prefix = 'rustOfferTemplate:';
// Page/authentication boundaries clear stale credentials even when no grain is
// opened. Individual grain services must only remove their own live offers.
export function clearStoredTemplateOffers() {
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix)) sessionStorage.removeItem(key); }
  catch { /* A template request reports disabled storage without breaking the shell. */ }
}
export class TemplateOffers {
  private keys = new Set<string>();
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private tokens = new Map<string, { since: number; promise: Promise<{token: string; host: string}> }>();
  clear() {
    ++this.generation;
    this.queue = Promise.resolve();
    this.tokens.clear();
    for (const key of this.keys) { try { sessionStorage.removeItem(key); } catch { /* unavailable storage */ } }
    this.keys.clear();
  }
  async render(input: unknown, title: string, issue: (options: TokenOptions) => Promise<{ token: string; host: string }>) {
    const call = templateRequest(input);
    const generation = this.generation;
    const options = tokenOptions(call);
    const key = JSON.stringify(options);
    let cached = this.tokens.get(key);
    if (!cached || Date.now() - cached.since >= 150000) {
      const promise = this.queue.then(() => {
        if (generation !== this.generation) throw new Error('Grain session closed.');
        return issue(options);
      });
      this.queue = promise.catch(() => {});
      cached = { since: Date.now(), promise };
      this.tokens.set(key, cached);
      const entry = cached;
      void promise.catch(() => { if (this.tokens.get(key) === entry) this.tokens.delete(key); });
    }
    const result = await cached.promise;
    if (generation !== this.generation) throw new Error('Grain session closed.');
    const url = new URL('https://' + result.host);
    if (url.host !== result.host || url.username || url.password || !result.token) throw new Error('Invalid API host.');
    const slug = title.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\w-]+/g, '').replace(/--+/g, '-').replace(/^-+|-+$/g, '');
    const renderedTemplate = call.template.replace(/\$API_TOKEN/g, () => result.token)
      .replace(/\$API_HOST/g, () => result.host).replace(/\$GRAIN_TITLE_SLUG/g, () => slug);
    const id = crypto.randomUUID();
    const storageKey = prefix + id;
    sessionStorage.setItem(storageKey, JSON.stringify({ ...result, renderedTemplate, clipboardButton: call.clipboardButton,
      clientapp: call.clientapp?.toLowerCase(), color: call.style?.color, expires: Date.now() + 300000 }));
    this.keys.add(storageKey);
    return location.origin + '/offer-template.html#' + id;
  }
}

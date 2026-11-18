const prefix = 'rustOfferTemplate:';
export class TemplateOffers {
  private keys = new Set<string>();
  private generation = 0;
  private reserved = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private tokens = new Map<string, { since: number; promise: Promise<{token: string; host: string}> }>();
  constructor() {
    try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix)) sessionStorage.removeItem(key); }
    catch { /* A template request reports disabled storage without breaking the shell. */ }
  }
  clear() {
    ++this.generation;
    this.reserved = 0;
    this.queue = Promise.resolve();
    this.tokens.clear();
    for (const key of this.keys) { try { sessionStorage.removeItem(key); } catch { /* unavailable storage */ } }
    this.keys.clear();
  }
  async render(input: unknown, title: string, issue: (options: string) => Promise<{ token: string; host: string }>) {
    if (!input || typeof input !== 'object') throw new Error('Invalid template request.');
    const call = input as Record<string, any>;
    const allowed = ['rpcId', 'template', 'petname', 'roleAssignment', 'forSharing', 'clipboardButton', 'style', 'unauthenticated', 'clientapp'];
    const unsupported = Object.keys(call).filter(key => !allowed.includes(key));
    if (unsupported.length) throw new Error(`Template option ${unsupported.join(', ')} requires the main shell.`);
    if (typeof call.rpcId !== 'string' || call.rpcId.length > 256 || typeof call.template !== 'string' || call.template.length > 32768 ||
        (call.petname !== undefined && (typeof call.petname !== 'string' || call.petname.length > 256)) ||
        (call.clientapp !== undefined && (typeof call.clientapp !== 'string' || !/^[a-zA-Z0-9+.-]{0,128}$/.test(call.clientapp))) ||
        (call.unauthenticated !== undefined && (!call.unauthenticated || typeof call.unauthenticated !== 'object' || Array.isArray(call.unauthenticated))) ||
        (call.forSharing !== undefined && typeof call.forSharing !== 'boolean') ||
        ![undefined, null, 'left', 'right'].includes(call.clipboardButton) ||
        (call.style !== undefined && (!call.style || typeof call.style !== 'object' ||
          Object.keys(call.style).some(key => key !== 'color') ||
          (call.style.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(call.style.color)))) || JSON.stringify(call).length > 65536) {
      throw new Error('Invalid template request.');
    }
    if (this.keys.size + this.reserved >= 32) throw new Error('Too many template requests. Reopen the grain to request more.');
    const generation = this.generation;
    const options = JSON.stringify({ petname: call.petname || 'connected external app',
      roleAssignment: call.roleAssignment || { allAccess: null }, forSharing: call.forSharing || false,
      unauthenticated: call.unauthenticated });
    if (options.length > 6144) throw new Error('Template options too large.');
    ++this.reserved;
    try {
      let cached = this.tokens.get(options);
      if (!cached || Date.now() - cached.since >= 150000) {
        if (!cached && this.tokens.size >= 8) throw new Error('Too many distinct template requests. Reopen the grain to request more.');
        const promise = this.queue.then(() => {
          if (generation !== this.generation) throw new Error('Grain session closed.');
          return issue(options);
        });
        this.queue = promise.catch(() => {});
        cached = { since: Date.now(), promise };
        this.tokens.set(options, cached);
        const entry = cached;
        void promise.catch(() => { if (this.tokens.get(options) === entry) this.tokens.delete(options); });
      }
      const result = await cached.promise;
      if (generation !== this.generation) throw new Error('Grain session closed.');
      const url = new URL('https://' + result.host);
      if (url.host !== result.host || url.username || url.password || !result.token) throw new Error('Invalid API host.');
      const slug = title.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\w-]+/g, '').replace(/--+/g, '-').replace(/^-+|-+$/g, '');
      const renderedTemplate = call.template.replace(/\$API_TOKEN/g, () => result.token)
        .replace(/\$API_HOST/g, () => result.host).replace(/\$GRAIN_TITLE_SLUG/g, () => slug);
      const id = crypto.randomUUID();
      const key = prefix + id;
      sessionStorage.setItem(key, JSON.stringify({ ...result, renderedTemplate, clipboardButton: call.clipboardButton,
        clientapp: call.clientapp?.toLowerCase(), color: call.style?.color, expires: Date.now() + 300000 }));
      this.keys.add(key);
      return location.origin + '/offer-template.html#' + id;
    } finally { if (generation === this.generation) --this.reserved; }
  }
}

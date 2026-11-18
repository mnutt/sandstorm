// This document stays on the trusted shell origin. Never post its text or token
// to the embedding app. Plain text only, even when the app supplies HTML.
/** @typedef {{host: string, token: string, renderedTemplate: string, expires: number,
 * clientapp?: string, color?: string, clipboardButton?: 'left' | 'right' | null}} Offer */

/** @param {unknown} value @returns {value is Offer} */
function isOffer(value) {
  if (!value || typeof value !== 'object') return false;
  const data = /** @type {Record<string, unknown>} */ (value);
  if (typeof data.host !== 'string' || typeof data.token !== 'string' || !data.token ||
      typeof data.renderedTemplate !== 'string' || data.renderedTemplate.length > 131072 ||
      typeof data.expires !== 'number' || !Number.isFinite(data.expires)) return false;
  try {
    const url = new URL('https://' + data.host);
    if (url.host !== data.host || url.username || url.password) return false;
  } catch { return false; }
  return (data.clientapp === undefined || typeof data.clientapp === 'string') &&
    (data.color === undefined || typeof data.color === 'string') &&
    [undefined, null, 'left', 'right'].includes(/** @type {string | null | undefined} */ (data.clipboardButton));
}

function showOffer() {
  const key = 'rustOfferTemplate:' + location.hash.slice(1);
  const text = document.getElementById('text');
  const copy = document.getElementById('copy');
  if (!(text instanceof HTMLElement) || !(copy instanceof HTMLButtonElement) || window.top === window) return;
  /** @type {unknown} */
  let stored;
  try { stored = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return; }
  if (!isOffer(stored) || stored.expires <= Date.now()) return;
  const record = stored;
  let expired = false;
  /** @type {HTMLAnchorElement | undefined} */
  let link;
  const available = () => {
    try { return !expired && record.expires > Date.now() && !!sessionStorage.getItem(key); }
    catch { return false; }
  };
  const expire = () => {
    expired = true;
    clearInterval(timer);
    try { sessionStorage.removeItem(key); } catch { /* Storage may have been disabled. */ }
    copy.hidden = true;
    copy.onclick = null;
    if (link) {
      link.replaceWith(text);
      link.removeAttribute('href');
      link.onclick = null;
      link = undefined;
    }
    text.textContent = 'These instructions expired. Reopen them from the app.';
  };
  text.textContent = record.renderedTemplate;
  if (record.clientapp && /^[a-z0-9+.-]{1,128}$/.test(record.clientapp)) {
    link = document.createElement('a');
    link.id = 'link';
    link.href = `clientapp-${record.clientapp}:${location.protocol}//${record.host}#${record.token}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.onclick = event => { if (!available()) event.preventDefault(); };
    text.replaceWith(link);
    link.appendChild(text);
  }
  if (record.color && /^#[0-9a-fA-F]{6}$/.test(record.color)) document.body.style.color = record.color;
  if (record.clipboardButton === 'left' || record.clipboardButton === 'right') {
    document.body.className = record.clipboardButton;
    copy.hidden = false;
    copy.onclick = async () => {
      if (!available()) { expire(); return; }
      try { await navigator.clipboard.writeText(record.renderedTemplate); copy.textContent = 'Copied'; }
      catch { copy.textContent = 'Select text to copy'; }
    };
  }
  let refreshing = false;
  let lastRefresh = Date.now();
  const timer = setInterval(async () => {
    if (!available()) { expire(); return; }
    if (refreshing || Date.now() - lastRefresh < 60000) return;
    refreshing = true;
    lastRefresh = Date.now();
    try {
      const response = await fetch('https://' + record.host, { method: 'POST', credentials: 'omit',
        headers: { Authorization: 'Bearer ' + record.token, 'X-Sandstorm-Token-Keepalive': '300000' },
        signal: AbortSignal.timeout(10000) });
      // Expiration/removal while this request was in flight must not revive it.
      if (response.ok && available()) {
        record.expires = Date.now() + 300000;
        sessionStorage.setItem(key, JSON.stringify(record));
      } else expire();
    } catch { expire(); }
    finally { refreshing = false; }
  }, 1000);
}
showOffer();

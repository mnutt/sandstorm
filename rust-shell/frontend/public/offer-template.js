// This document stays on the trusted shell origin. Never post its text or token
// to the embedding app. Plain text only, even when the app supplies HTML.
const key = 'rustOfferTemplate:' + location.hash.slice(1);
const text = document.getElementById('text');
const copy = document.getElementById('copy');
let record;
try { record = JSON.parse(sessionStorage.getItem(key)); } catch {}
if (window.top !== window && record && record.expires > Date.now()) {
  text.textContent = record.renderedTemplate;
  if (/^#[0-9a-fA-F]{6}$/.test(record.color)) document.body.style.color = record.color;
  if (['left', 'right'].includes(record.clipboardButton)) {
    document.body.className = record.clipboardButton;
    copy.hidden = false;
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(record.renderedTemplate); copy.textContent = 'Copied'; }
      catch { copy.textContent = 'Select text to copy'; }
    };
  }
  let refreshing = false;
  let lastRefresh = Date.now();
  const timer = setInterval(async () => {
    if (!sessionStorage.getItem(key) || record.expires <= Date.now()) {
      clearInterval(timer); sessionStorage.removeItem(key);
      record = null; copy.hidden = true; copy.onclick = null;
      text.textContent = 'These instructions expired. Reopen them from the app.';
      return;
    }
    if (refreshing || Date.now() - lastRefresh < 60000) return;
    refreshing = true;
    lastRefresh = Date.now();
    try {
      const response = await fetch('https://' + record.host, { method: 'POST', credentials: 'omit',
        headers: { Authorization: 'Bearer ' + record.token, 'X-Sandstorm-Token-Keepalive': '300000' },
        signal: AbortSignal.timeout(10000) });
      if (response.ok && sessionStorage.getItem(key)) {
        record.expires = Date.now() + 300000;
        sessionStorage.setItem(key, JSON.stringify(record));
      } else sessionStorage.removeItem(key);
    } catch { sessionStorage.removeItem(key); }
    finally { refreshing = false; }
  }, 1000);
}

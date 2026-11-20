// OAuth credentials stay server-side. The popup only visits the provider and
// callback; the opener polls with its existing authenticated/flow cookie.
export async function authorizeOAuth<T>(begin: () => Promise<{request:string;url:string}>,
  poll: (request:string) => Promise<T | null>, cancel: (request:string) => Promise<unknown>, lifetime:AbortSignal): Promise<T> {
  const popup = window.open('about:blank','_blank','popup,width=680,height=760');
  if (!popup) throw new Error('Allow popups to authorize GitHub.');
  popup.opener = null;
  const signal = AbortSignal.any([lifetime,AbortSignal.timeout(300000)]);
  let request = '';
  try {
    signal.throwIfAborted();
    const started = await begin(); request = started.request;
    signal.throwIfAborted();
    const url = new URL(started.url);
    if (url.origin !== 'https://github.com' || url.pathname !== '/login/oauth/authorize') throw new Error('Invalid authorization URL.');
    popup.location.href = url.href;
    while (true) {
      signal.throwIfAborted();
      const result = await poll(request);
      signal.throwIfAborted();
      if (result !== null) return result;
      if (popup.closed) throw new Error('Authorization was canceled.');
      await new Promise<void>((resolve,reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort',abort); resolve(); },1000);
        signal.addEventListener('abort',abort,{once:true});
        if (signal.aborted) abort();
      });
    }
  } finally {
    popup.close();
    if (request) void cancel(request).catch(() => {});
  }
}

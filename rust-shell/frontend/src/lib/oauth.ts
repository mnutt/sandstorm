export const oauthProviders = [
  {key:'oidc',label:'OpenID Connect',origin:null,path:null},
  {key:'github',label:'GitHub',origin:'https://github.com',path:'/login/oauth/authorize'},
  {key:'google',label:'Google',origin:'https://accounts.google.com',path:'/o/oauth2/auth'},
] as const;
export type OAuthProviderName = typeof oauthProviders[number]['key'];
export function authorizationUrl(provider: OAuthProviderName, value: string): URL {
  const expected = oauthProviders.find(item => item.key === provider);
  const url = new URL(value);
  if (!expected || !['https:','http:'].includes(url.protocol) || (expected.origin && (url.origin !== expected.origin || url.pathname !== expected.path)) || url.username || url.password || url.hash) throw new Error('Invalid authorization URL.');
  return url;
}

// OAuth credentials stay server-side. The popup only visits the provider and
// callback; the opener polls with its existing authenticated/flow cookie.
export async function authorizeOAuth<T>(begin: () => Promise<{request:string;url:string}>,
  poll: (request:string) => Promise<T | null>, cancel: (request:string) => Promise<unknown>, lifetime:AbortSignal, provider:OAuthProviderName): Promise<T> {
  const popup = window.open('about:blank','_blank','popup,width=680,height=760');
  if (!popup) throw new Error('Allow popups to authorize your account.');
  popup.opener = null;
  const signal = AbortSignal.any([lifetime,AbortSignal.timeout(300000)]);
  let request = '';
  try {
    signal.throwIfAborted();
    const started = await begin(); request = started.request;
    signal.throwIfAborted();
    const url = authorizationUrl(provider, started.url);
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

import { runOperation } from './operations';
export const signInProviders = [
  {key:'saml',label:'SAML',origin:null,path:null},
  {key:'oidc',label:'OpenID Connect',origin:null,path:null},
  {key:'github',label:'GitHub',origin:'https://github.com',path:'/login/oauth/authorize'},
  {key:'google',label:'Google',origin:'https://accounts.google.com',path:'/o/oauth2/auth'},
] as const;
export type SignInProviderName = typeof signInProviders[number]['key'];
export function authorizationUrl(provider: SignInProviderName, value: string): URL {
  const expected = signInProviders.find(item => item.key === provider);
  const url = new URL(value);
  if (!expected || !['https:','http:'].includes(url.protocol) || (expected.origin && (url.origin !== expected.origin || url.pathname !== expected.path)) || url.username || url.password || url.hash) throw new Error('Invalid authorization URL.');
  return url;
}

// Provider-specific wire operations stay out of Svelte components.
export function providerRequest(provider: SignInProviderName, stage: 'Start' | 'Finish' | 'Cancel', request?: string) {
  const prefix = provider === 'saml' ? 'saml' : 'oauth';
  return {
    operation: `${prefix}${stage}` as 'samlStart' | 'samlFinish' | 'samlCancel' | 'oauthStart' | 'oauthFinish' | 'oauthCancel',
    data: {...(provider === 'saml' ? {} : {provider}), ...(request === undefined ? {} : {request})} as Record<string,string>,
  };
}

// OAuth credentials stay server-side. The popup only visits the provider and
// callback; the opener polls with its existing authenticated/flow cookie.
export async function authorizePopup<T>(begin: (signal:AbortSignal) => Promise<{request:string;url:string}>,
  poll: (request:string, signal:AbortSignal) => Promise<T | null>, cancel: (request:string, signal:AbortSignal) => Promise<unknown>, lifetime:AbortSignal, provider:SignInProviderName): Promise<T> {
  const popup = window.open('about:blank','_blank','popup,width=680,height=760');
  if (!popup) throw new Error('Allow popups to authorize your account.');
  popup.opener = null;
  const signal = AbortSignal.any([lifetime,AbortSignal.timeout(300000)]);
  let request = '';
  const close = () => popup.close();
  signal.addEventListener('abort',close,{once:true});
  const cleanup = async (key:string): Promise<void> => {
    try { await cancel(key,AbortSignal.timeout(5000)); } catch { /* Server expiry is the fallback. */ }
  };

  try {
    signal.throwIfAborted();
    const started = await runOperation(begin(signal), 'Start authorization', {
      signal,timeoutMs:300000,onLateResult:value=>cleanup(value.request),
    });
    request = started.request;
    signal.throwIfAborted();
    const url = authorizationUrl(provider, started.url);
    popup.location.href = url.href;
    while (true) {
      signal.throwIfAborted();
      const result = await runOperation(poll(request,signal),'Finish authorization',{signal,timeoutMs:300000});
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
    signal.removeEventListener('abort',close);
    popup.close();
    if (request) void cleanup(request);
  }
}

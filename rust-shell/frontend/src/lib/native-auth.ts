export interface LoginOptions {
  email: boolean; dev: boolean; ldap: boolean; github: boolean; google: boolean; oidc: boolean; saml: boolean;
}

async function responseValue(response: Response) {
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Sign-in unavailable. Please start again.');
  return result;
}

// Reuse the flow identity while refreshing its cookie. Do this immediately
// before beginning a login, not only when the login page was mounted.
export async function refreshLoginFlow(signal: AbortSignal): Promise<LoginOptions> {
  return responseValue(await fetch('/auth/options',{cache:'no-store',signal}));
}

export async function nativeLogin(operation: string, data: Record<string,string>, signal: AbortSignal, cleanup = false) {
  return responseValue(await fetch('/auth/native',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,data}),signal,keepalive:cleanup,
  }));
}

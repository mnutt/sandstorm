<script lang="ts">
  import { authorizeOAuth, oauthProviders, type OAuthProviderName } from './lib/oauth';
  import { onMount } from 'svelte';
  import Panel from './components/ui/Panel.svelte';
  import Button from './components/ui/Button.svelte';
  import TextInput from './components/ui/TextInput.svelte';
  import LoadingStatus from './components/ui/LoadingStatus.svelte';
  let options = $state<{email:boolean;dev:boolean;ldap:boolean;github:boolean;google:boolean}>();
  let pending = $state(false);
  let error = $state('');
  let email = $state('');
  let code = $state('');
  let sent = $state(false);
  let username = $state('');
  let password = $state('');
  const lifetime = new AbortController();
  onMount(() => {
    void (async () => {
      try {
        const response = await fetch('/auth/options',{cache:'no-store',signal:lifetime.signal});
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Sign-in unavailable.');
        options = result;
      } catch (failure) { if (!lifetime.signal.aborted) error = String(failure); }
    })();
    return () => { lifetime.abort(); password = ''; code = ''; };
  });
  async function oauth(provider:OAuthProviderName) {
    pending = true; error = '';
    const call = async (operation:string,data:Record<string,string>={}) => {
      const response = await fetch('/auth/native',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,data}),signal:lifetime.signal});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Authorization failed.');
      return result;
    };
    try {
      await authorizeOAuth(() => call('oauthStart',{provider}), async request => {
        const result = await call('oauthFinish',{provider,request});
        return result.pending ? null : result;
      }, request => call('oauthCancel',{provider,request}), lifetime.signal, provider);
      location.assign('/');
    } catch (failure) { if (!lifetime.signal.aborted) error = String(failure); }
    finally { if (!lifetime.signal.aborted) pending = false; }
  }
  async function signIn(operation: string, data: Record<string,string>) {
    if (pending) return;
    pending = true; error = ''; password = ''; code = '';
    try {
      const response = await fetch('/auth/native',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,data}),signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(25000)])});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Sign-in failed.');
      if (result.signedIn) location.assign('/');
      else if (result.sent) sent = true;
    } catch (failure) { if (!lifetime.signal.aborted) error = String(failure); }
    finally { if (!lifetime.signal.aborted) pending = false; }
  }
</script>
<Panel aria-labelledby="sign-in-title">
  <h2 id="sign-in-title">Sign in to Sandstorm</h2>
  {#if !options && !error}<LoadingStatus label="Loading sign-in methods…" />{/if}
  {#each oauthProviders as provider}
    {#if options?.[provider.key]}<Button disabled={pending} onclick={() => oauth(provider.key)}>Sign in with {provider.label}</Button>{/if}
  {/each}
  {#if options?.dev}
    <h3>Development accounts</h3>
    <div class="dev-accounts">{#each ['Alice','Bob','Carol','Dave'] as name}<Button variant="secondary" disabled={pending} onclick={() => signIn('dev',{name})}>{name}{name === 'Alice' ? ' (admin)' : ''}</Button>{/each}</div>
  {/if}
  {#if options?.email}
    <form onsubmit={event => {event.preventDefault(); void signIn(sent ? 'email' : 'sendEmail',sent ? {email,code} : {email});}}>
      <h3>Email</h3>
      <label for="sign-in-email">Email address</label><TextInput id="sign-in-email" type="email" bind:value={email} required disabled={pending || sent} autocomplete="email" />
      {#if sent}<label for="sign-in-code">One-time code</label><TextInput id="sign-in-code" bind:value={code} required autocomplete="one-time-code" disabled={pending} />{/if}
      <div><Button type="submit" disabled={pending}>{sent ? 'Sign in' : 'Send sign-in code'}</Button>{#if sent}<Button variant="secondary" disabled={pending} onclick={() => {sent=false;code='';}}>Change email</Button>{/if}</div>
    </form>
  {/if}
  {#if options?.ldap}
    <form onsubmit={event => {event.preventDefault(); void signIn('ldap',{username,password});}}>
      <h3>Directory account</h3>
      <label for="directory-username">Username</label><TextInput id="directory-username" bind:value={username} required autocomplete="username" disabled={pending} />
      <label for="directory-password">Password</label><TextInput id="directory-password" type="password" bind:value={password} required autocomplete="current-password" disabled={pending} />
      <Button type="submit" disabled={pending}>Sign in with directory account</Button>
    </form>
  {/if}
  {#if pending}<p role="status">Working…</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  <p><a href="/auth/start">Use main shell sign-in</a> for other providers or an existing session.</p>
</Panel>
<style>
  h2 { font-size: var(--ss-text-title); }
  h3 { font-size: var(--ss-text-small); margin: .75rem 0 .25rem; }
  form { display:grid; gap:.5rem; max-width:28rem; margin-block:1rem; }
  .dev-accounts { display:flex; gap:.5rem; flex-wrap:wrap; }
  [role=alert] { color:var(--ss-danger); }
</style>

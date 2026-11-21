<script lang="ts">
  import { authorizePopup, providerRequest, signInProviders, type SignInProviderName } from './lib/oauth';
  import { refreshLoginFlow, nativeLogin, type LoginOptions } from './lib/native-auth';
  import { onMount } from 'svelte';
  import Panel from './components/ui/Panel.svelte';
  import Button from './components/ui/Button.svelte';
  import TextInput from './components/ui/TextInput.svelte';
  import LoadingStatus from './components/ui/LoadingStatus.svelte';
  let options = $state<LoginOptions>();
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
        options = await refreshLoginFlow(lifetime.signal);
      } catch (failure) { if (!lifetime.signal.aborted) error = String(failure); }
    })();
    return () => { lifetime.abort(); password = ''; code = ''; };
  });
  async function oauth(provider:SignInProviderName) {
    if (pending) return;
    pending = true; error = '';
    const call = (stage:'Start' | 'Finish' | 'Cancel', signal:AbortSignal, request?:string) => {
      const {operation,data} = providerRequest(provider,stage,request);
      return nativeLogin(operation,data,signal,stage === 'Cancel');
    };
    try {
      await authorizePopup(async signal => {
        await refreshLoginFlow(signal);
        return call('Start',signal);
      }, async (request,signal) => {
        const result = await call('Finish',signal,request);
        return result.pending ? null : result;
      }, (request,signal) => call('Cancel',signal,request), lifetime.signal, provider);
      location.assign('/');
    } catch (failure) { if (!lifetime.signal.aborted) error = String(failure); }
    finally { if (!lifetime.signal.aborted) pending = false; }
  }
  async function signIn(operation: string, data: Record<string,string>) {
    if (pending) return;
    pending = true; error = ''; password = ''; code = '';
    try {
      const signal = AbortSignal.any([lifetime.signal,AbortSignal.timeout(25000)]);
      await refreshLoginFlow(signal);
      const result = await nativeLogin(operation,data,signal);
      if (result.signedIn) location.assign('/');
      else if (result.sent) sent = true;
    } catch (failure) { if (!lifetime.signal.aborted) error = String(failure); }
    finally { if (!lifetime.signal.aborted) pending = false; }
  }
</script>
<Panel aria-labelledby="sign-in-title">
  <h2 id="sign-in-title">Sign in to Sandstorm</h2>
  {#if !options && !error}<LoadingStatus label="Loading sign-in methods…" />{/if}
  {#each signInProviders as provider}
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
  <p><a href="/auth/start">Use main shell sign-in</a> to reuse an existing session.</p>
</Panel>
<style>
  h2 { font-size: var(--ss-text-title); }
  h3 { font-size: var(--ss-text-small); margin: .75rem 0 .25rem; }
  form { display:grid; gap:.5rem; max-width:28rem; margin-block:1rem; }
  .dev-accounts { display:flex; gap:.5rem; flex-wrap:wrap; }
  [role=alert] { color:var(--ss-danger); }
</style>

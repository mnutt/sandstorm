<script lang="ts">
  import { onDestroy } from 'svelte';
  import { authorizePopup, providerRequest, signInProviders, type SignInProviderName } from './lib/oauth';
  import type { AccountService, AccountState } from './lib/account';
  import Avatar from './components/ui/Avatar.svelte';
  import Button from './components/ui/Button.svelte';
  import TextInput from './components/ui/TextInput.svelte';
  let {state: model, settings, ready}: {state:AccountState; settings:AccountService; ready:boolean} = $props();
  let email = $state('');
  let code = $state('');
  let allowLogin = $state(true);
  let verifying = $state(false);
  let removing = $state('');
  const loginCount = $derived(model.value?.credentials.filter(item => item.login).length || 0);
  $effect(() => { if (ready) void settings.call(); });
  const lifetime = new AbortController();
  onDestroy(() => lifetime.abort());
  let oauthPending = $state<SignInProviderName | null>(null);
  let oauthError = $state('');
  async function oauth(provider:SignInProviderName) {
    if (oauthPending) return;
    oauthPending=provider; oauthError='';
    const call = (stage:'Start' | 'Finish' | 'Cancel', signal:AbortSignal, request?:string) => {
      const {operation,data} = providerRequest(provider,stage,request);
      return settings.call(operation,data,signal);
    };
    try {
      await authorizePopup(async signal => {
        const result = await call('Start',signal);
        if (!result) throw new Error('Could not start authorization.');
        const oauth = result.authorization;
        if (!oauth?.url) throw new Error('No authorization URL returned.');
        return {request:oauth.request,url:oauth.url};
      }, async (request,signal) => {
        const result = await call('Finish',signal,request);
        if (!result) throw new Error('Could not finish authorization.');
        return result.authorization?.pending ? null : true;
      }, (request,signal) => call('Cancel',signal,request), lifetime.signal, provider);
    } catch (failure) { if (!lifetime.signal.aborted) oauthError=String(failure); }
    finally { if (!lifetime.signal.aborted) oauthPending=null; }
  }
  async function send(event: SubmitEvent) {
    event.preventDefault();
    if (await settings.call('sendEmail', {email, allowLogin})) verifying = true;
  }
  async function verify(event: SubmitEvent) {
    event.preventDefault();
    const submittedCode = code; code = '';
    if (await settings.call('verifyEmail', {email, code:submittedCode, allowLogin})) { verifying = false; email = ''; }
  }
</script>

<section aria-labelledby="login-methods-title">
  <h3 id="login-methods-title">Login methods</h3>
  {#if model.pending && !model.value}<p role="status">Loading login methods…</p>{/if}
  {#if model.value}
    <ul>
      {#each model.value.credentials as credential (credential.id)}
        <li>
          <Avatar src={credential.pictureUrl} name={credential.name} size={28} />
          <div class="identity"><strong>{credential.name}</strong><span>{credential.service}</span></div>
          <label><input type="checkbox" checked={credential.login} disabled={model.pending || credential.login && loginCount < 2}
            onchange={event => { const allowLogin = event.currentTarget.checked; event.currentTarget.checked = credential.login; void settings.call('allowLogin',{id:credential.id,allowLogin}); }} /> Allow login</label>
          {#if removing === credential.id}
            <Button variant="danger" disabled={model.pending} onclick={async () => { if (await settings.call('unlink',{id:credential.id})) removing = ''; }}>Confirm removal</Button>
            <Button variant="secondary" disabled={model.pending} onclick={() => removing = ''}>Cancel</Button>
          {:else}
            <Button variant="secondary" disabled={model.pending || credential.login && loginCount < 2} onclick={() => removing = credential.id}>Remove</Button>
          {/if}
        </li>
      {/each}
    </ul>
    {#each signInProviders as provider}
      {#if model.value[provider.key + 'Enabled' as 'githubEnabled' | 'googleEnabled' | 'oidcEnabled' | 'samlEnabled']}<Button variant="secondary" disabled={model.pending || !!oauthPending} onclick={() => oauth(provider.key)}>Link {provider.label} account</Button>{/if}
    {/each}
    {#if oauthPending}<p role="status">Waiting for {signInProviders.find(provider => provider.key === oauthPending)?.label} authorization…</p>{/if}
    {#if oauthError}<p role="alert">{oauthError}</p>{/if}
    <p class="hint">Keep at least one login method so you can sign in again.</p>
    <h3>Email addresses</h3>
    <ul>
      {#each model.value.emails as item (item.email)}
        <li><span class="identity"><span>{item.email}</span><small>{item.verified ? 'Verified' : 'Unverified'}</small></span>
          {#if item.primary}<span>Primary</span>{:else if item.verified}<Button variant="secondary" disabled={model.pending} onclick={() => settings.call('primary',{email:item.email})}>Make primary</Button>{/if}
        </li>
      {:else}<li>No email addresses linked.</li>{/each}
    </ul>
    {#if model.value.emailEnabled}
      {#if verifying}
        <form onsubmit={verify}>
          <label for="verification-code">Verification code for {email}</label>
          <TextInput id="verification-code" bind:value={code} autocomplete="one-time-code" required disabled={model.pending} />
          <div class="actions"><Button type="submit" disabled={model.pending || !code.trim()}>Verify email</Button><Button variant="secondary" disabled={model.pending} onclick={() => { verifying = false; code = ''; }}>Cancel</Button></div>
        </form>
      {:else}
        <form onsubmit={send}>
          <label for="account-email">Add an email address</label>
          <TextInput id="account-email" type="email" bind:value={email} required disabled={model.pending} />
          <label><input type="checkbox" bind:checked={allowLogin} disabled={model.pending} /> Allow this email to log in</label>
          <Button type="submit" disabled={model.pending || !email.trim()}>Send verification code</Button>
        </form>
      {/if}
    {/if}
  {/if}
  {#if model.error}<div role="alert">{model.error} <Button variant="secondary" disabled={model.pending} onclick={() => settings.call()}>Reload settings</Button></div>{/if}
  {#if model.notice}<p role="status">{model.notice}</p>{/if}
</section>
<style>
  section { margin-top: 1.5rem; }
  h3 { font-size: var(--ss-text-small); margin: 1rem 0 .5rem; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; align-items: center; gap: .75rem; padding: .5rem 0; border-bottom: 1px solid var(--ss-control-border); flex-wrap: wrap; }
  .identity { flex: 1; min-width: 8rem; overflow-wrap: anywhere; display: grid; }
  .identity span, small, .hint { color: var(--ss-muted); font-size: var(--ss-text-small); }
  form { display: grid; gap: .5rem; max-width: 28rem; margin-top: 1rem; }
  .actions { display: flex; gap: .5rem; }
  [role=alert] { color: var(--ss-danger); margin-top: .75rem; }
</style>

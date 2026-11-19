<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from './components/ui/Modal.svelte';
  import Button from './components/ui/Button.svelte';
  import TextInput from './components/ui/TextInput.svelte';
  import NativeSelect from './components/ui/NativeSelect.svelte';
  import GrainIcon from './components/ui/GrainIcon.svelte';
  import LoadingStatus from './components/ui/LoadingStatus.svelte';
  import type { PowerboxRequest } from './lib/protocol';
  import type { PowerboxActions, PowerboxCandidate, PowerboxState } from './lib/powerbox-native';
  let { request, actions, title, finish, legacy }: {request:PowerboxRequest; actions:PowerboxActions; title:string;
    finish:(result:Record<string,unknown>)=>void; legacy:()=>void} = $props();
  let open = $state(true);
  let busy = $state(true);
  let error = $state('');
  let choices = $state<PowerboxCandidate[]>([]);
  let selected = $state<PowerboxCandidate>();
  let provider = $state<Extract<PowerboxState,{status:'provider'}>>();
  let loaded = $state(false);
  let search = $state('');
  let role = $state('all');
  let url = $state('');
  let limited = $state(false);
  let hasLegacy = $state(false);
  let alive = true;
  let completed = false;
  let pollTimer: ReturnType<typeof setTimeout>;
  let expires: ReturnType<typeof setTimeout>;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2,'0')).join('');
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  function done(result:Record<string,unknown>) {
    if (completed || !alive) return;
    completed = true;
    finish({rpcId:request.rpcId,...result});
  }
  $effect(() => { if (!open) done({canceled:true}); });
  async function accept(result:PowerboxState) {
    if (!alive) return;
    if (result.status === 'complete') {
      if (typeof result.token !== 'string' || result.token.length > 16384 ||
        (result.descriptor !== undefined && (typeof result.descriptor !== 'string' || result.descriptor.length > 65536))) throw new Error('Invalid Powerbox result.');
      done({token:result.token,descriptor:result.descriptor});
    } else if (result.status === 'provider') {
      const target = new URL(result.url);
      if (!['http:','https:'].includes(target.protocol) || target.origin !== result.origin || target.username || target.password) throw new Error('Invalid provider origin.');
      provider = result;
      pollTimer = setTimeout(poll,1000);
    } else if (result.status === 'choices') {
      choices = result.candidates; limited = result.limited; hasLegacy = result.legacy;
    } else if (result.status === 'waiting') pollTimer = setTimeout(poll,1000);
  }
  async function poll() {
    if (!alive || completed) return;
    try { await accept(await actions.call(id,'poll')); }
    catch (e) { if (alive) { provider = undefined; error = String(e); } }
  }
  onMount(() => {
    void (async () => {
      try { await accept(await actions.call(id,'begin',{query:request.query || []})); }
      catch (e) { if (alive) error = String(e); }
      finally { if (alive) busy = false; }
    })();
    expires = setTimeout(() => done({canceled:true}),300000);
    return () => {
      alive = false;
      clearTimeout(pollTimer); clearTimeout(expires);
      void actions.call(id,'cancel').catch(() => {});
    };
  });
  async function connect(mode = 'ref') {
    if (!selected || busy || error) return;
    busy = true;
    try { await accept(await actions.call(id,'select',{key:selected.key,mode,role,url})); }
    catch (e) { if (alive) error = `Could not complete the connection. Cancel and request it again. ${String(e)}`; }
    finally { if (alive) busy = false; }
  }
</script>

<Modal bind:open title="Connect an app" description={title + ' is requesting access.'} {returnFocus} wide>
  <div class="powerbox">
    {#if error}<p role="alert">{error}</p>{/if}
    {#if provider}
      <p class="provider-title">Choose what to share from <strong>{provider.title}</strong>.</p>
      <div class="provider">
        <iframe title={'Choose from ' + provider.title} src={provider.url} referrerpolicy="no-referrer" onload={() => { loaded = true; }}></iframe>
        {#if !loaded}<div class="loading"><LoadingStatus label="Loading provider…" /></div>{/if}
      </div>
    {:else if busy}<LoadingStatus label="Loading connection options…" />
    {:else if selected}
      <div class="selected"><GrainIcon src={selected.iconSrc || ''} /><strong>{selected.title}</strong></div>
      {#if selected.uiView}
        <label>Permissions<NativeSelect aria-label="Connection permissions" bind:value={role}>
          {#each selected.roles || [] as item}<option value={item.key}>{item.title}</option>{/each}
          <option value="all">All my permissions</option>
        </NativeSelect></label>
        <p class="hint">This app will receive access to the selected grain. It cannot receive permissions you do not have.</p>
      {/if}
      {#if selected.urlInput}<label>URL<TextInput type="url" bind:value={url} placeholder="https://example.com/" /></label>{/if}
      {#if !selected.uiView && !selected.hostedObject}<p class="hint">Allow this app to use {selected.title}?</p>{/if}
      <div class="actions">
        {#if selected.uiView}<Button disabled={!!error} onclick={() => connect('view')}>Connect grain</Button>{/if}
        {#if selected.hostedObject}<Button disabled={!!error} onclick={() => connect('hosted')}>Choose from app</Button>{/if}
        {#if !selected.uiView && !selected.hostedObject}<Button disabled={!!error || (selected.urlInput && !url.trim())} onclick={() => connect()}>Allow connection</Button>{/if}
        <Button variant="secondary" disabled={!!error} onclick={() => { selected = undefined; }}>Back</Button>
      </div>
    {:else if !error}
      <TextInput aria-label="Search connection options" bind:value={search} placeholder="Search apps and capabilities" />
      <ul class="candidates">
        {#each choices.filter(item => (item.title + ' ' + (item.detail || '')).toLowerCase().includes(search.toLowerCase())) as item (item.key)}
          <li><button class="candidate" onclick={() => { selected = item; role = item.roles?.[0]?.key || 'all'; url = ''; }}>
            <GrainIcon src={item.iconSrc || ''} /><span><strong>{item.title}</strong>{#if item.detail}<small>{item.detail}</small>{/if}</span>
          </button></li>
        {:else}<li class="empty">No matching options.</li>{/each}
      </ul>
      {#if limited}<p class="hint">Showing the first 64 options.</p>{/if}
      {#if hasLegacy}<p class="hint">Some account authorization options are available in the main shell.</p>{/if}
    {/if}
    <div class="footer">
      <Button variant="secondary" onclick={() => { completed = true; legacy(); }}>More options in main shell</Button>
      <Button variant="secondary" onclick={() => done({canceled:true})}>Cancel request</Button>
    </div>
  </div>
</Modal>

<style>
  .powerbox { display: grid; gap: var(--ss-space-3); }
  p { margin: 0; }
  label { display: grid; gap: var(--ss-space-1); font-size: var(--ss-text-small); font-weight: 600; }
  .hint, small, .empty { color: var(--ss-muted); font-size: var(--ss-text-small); }
  .candidates { list-style: none; padding: 0; margin: 0; max-height: 45dvh; overflow: auto; }
  li + li { border-top: 1px solid var(--ss-border); }
  .candidate { display: flex; align-items: center; gap: var(--ss-space-3); width: 100%; border: 0; padding: var(--ss-space-3); text-align: left; background: transparent; color: var(--ss-text); cursor: pointer; font: inherit; }
  .candidate:hover { background: var(--ss-canvas); }
  .candidate:focus-visible { outline: 2px solid var(--ss-focus); outline-offset: -2px; }
  .candidate span { min-width: 0; }
  .candidate strong, small { display: block; overflow-wrap: anywhere; }
  .selected, .actions, .footer { display: flex; align-items: center; gap: var(--ss-space-2); flex-wrap: wrap; }
  .footer { justify-content: flex-end; padding-top: var(--ss-space-3); border-top: 1px solid var(--ss-border); }
  .provider { position: relative; height: 50dvh; }
  iframe { width: 100%; height: 100%; border: 1px solid var(--ss-border); }
  .loading { position: absolute; inset: 0; display: grid; place-items: center; background: var(--ss-surface); }
  [role=alert] { color: var(--ss-danger); overflow-wrap: anywhere; }
</style>

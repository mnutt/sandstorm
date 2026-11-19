<script lang="ts">
  import Modal from './components/ui/Modal.svelte';
  import Button from './components/ui/Button.svelte';
  import TextInput from './components/ui/TextInput.svelte';
  import Panel from './components/ui/Panel.svelte';
  import { appPath } from './lib/router';
  import { onMount, untrack } from 'svelte';
  import { PowerboxChooser } from './lib/powerbox';
  import { SharingWindow, type SharingState } from './lib/sharing';
  import { record, GrainTitleSubscriptions } from './lib/protocol';
  import type { ActiveGrain } from './lib/shell';
  let { grain, close, renderTemplate, pathChanged, rename }: { grain: ActiveGrain; close: () => void; renderTemplate: (input: unknown) => Promise<string>; pathChanged: (path: string) => void; rename: (title: string) => Promise<void> } = $props();
  let frame: HTMLIFrameElement;
  let frameTitle = $state('');
  let path = $state(untrack(() => grain.path));
  let sharingState: SharingState = $state({ status: 'idle' });
  const titles = new GrainTitleSubscriptions(untrack(() => grain.ownerTitle),
    result => frame?.contentWindow?.postMessage(result, grain.origin));
  $effect(() => titles.update(grain.ownerTitle));
  let editing = $state(false);
  let draftTitle = $state('');
  let renaming = $state(false);
  let renameError = $state('');
  async function saveTitle(event: SubmitEvent) {
    event.preventDefault();
    if (renaming || !draftTitle.trim()) return;
    renaming = true;
    renameError = '';
    try { await rename(draftTitle.trim()); editing = false; }
    catch (error) { renameError = `Could not confirm rename. Check the current title before trying again. ${String(error)}`; }
    finally { renaming = false; }
  }
  let choosing = $state(false);
  let chooser: PowerboxChooser;
  let sharing: SharingWindow;
  onMount(() => {
    chooser = new PowerboxChooser(new URL(grain.mainHref).origin, new URL(grain.url).searchParams.get('sessionid') || '',
      result => frame?.contentWindow?.postMessage(result, grain.origin), value => { choosing = value; });
    sharing = new SharingWindow(new URL(grain.mainHref).origin, new URL(grain.url).searchParams.get('sessionid') || '',
      value => { sharingState = value; });
    return () => { titles.clear(); chooser.cancel(); sharing.cancel(); };
  });
  const mainHref = $derived(grain.mainHref + (path === '/' ? '' : path));
  function message(event: MessageEvent) {
    chooser?.message(event);
    sharing?.message(event);
    if (event.origin !== grain.origin || event.source !== frame?.contentWindow) return;
    const data = record(event.data);
    if (!data) return;
    if (typeof data.setTitle === 'string') frameTitle = data.setTitle.slice(0, 160);
    if (typeof data.setPath === 'string') {
      const next = appPath(data.setPath || '/');
      if (next) { path = next; pathChanged(path); }
    }
    if (data.getGrainTitle) titles.request(data.rpcId, data.getGrainTitle, data.subscribe);
    if (data.powerboxRequest) chooser?.request(data.powerboxRequest);
    const template = record(data.renderTemplate);
    if (template && typeof template.rpcId === 'string' && template.rpcId.length <= 256) {
      const source = event.source as Window;
      const rpcId = template.rpcId;
      const origin = grain.origin;
      renderTemplate(template).then(uri => source.postMessage({ rpcId, uri }, origin),
        error => source.postMessage({ rpcId, error: String(error) }, origin));
    }
    if (data.startSharing) sharing?.request('share', data.startSharing);
    if (data.showConnectionGraph) sharing?.request('access');
  }
</script>

<svelte:window onmessage={message} />
<Panel class="grain-view" aria-label="Open grain">
  <div class="toolbar"><h2>{frameTitle || grain.title}</h2><Button variant="secondary" onclick={close}>Close grain</Button></div>
  {#if frameTitle}<p>Grain: {grain.title}</p>{/if}
  <Modal bind:open={editing} title="Rename grain" triggerLabel="Rename grain"
    description="For a shared grain, this changes only your copy’s name." busy={renaming}
    onTrigger={() => { draftTitle = grain.title; renameError = ''; }}>
    <form onsubmit={saveTitle}>
      <label for="rename-grain-title">Grain title</label>
      <TextInput id="rename-grain-title" bind:value={draftTitle} maxlength={160} required disabled={renaming} />
      <div class="dialog-actions">
      <Button type="submit" disabled={renaming || !draftTitle.trim()}>{renaming ? 'Saving title…' : 'Save title'}</Button>
      <Button variant="secondary" type="button" disabled={renaming} onclick={() => { editing = false; renameError = ''; }}>Cancel rename</Button>
      </div>
    </form>
    {#if renameError}<p role="alert">{renameError}</p>{/if}
  </Modal>
  <p><a href={mainHref}>Open in main shell ↗</a>
    <Button onclick={() => { sharing.request('share'); sharing.open(); }}>Share</Button>
    <Button onclick={() => { sharing.request('access'); sharing.open(); }}>Who has access</Button></p>
  {#if sharingState.status !== 'idle'}<div role="status"><p>{sharingState.message}</p>
    {#if sharingState.status !== 'failed'}
      <Button onclick={() => sharing.open()}>Open sharing window</Button>
      <Button onclick={() => sharing.cancel()}>Close sharing window</Button>
    {:else}<Button onclick={() => sharing.cancel()}>Dismiss sharing error</Button>{/if}
  </div>{/if}
  {#if choosing}<div role="status"><p>This app wants you to choose a capability.</p>
    <Button onclick={() => chooser.open()}>Choose in Sandstorm</Button>
    <Button onclick={() => chooser.cancel()}>Cancel request</Button></div>{/if}
  <iframe bind:this={frame} title={grain.title} src={grain.url} referrerpolicy="no-referrer"></iframe>
</Panel>

<style>
  h2 {
    margin: 0 0 var(--ss-space-4);
    font-size: var(--ss-text-title);
    line-height: 1.3;
  }

  a {
    color: var(--ss-brand);
    text-underline-offset: .2em;
  }

  a:focus-visible {
    outline: 3px solid var(--ss-focus);
    outline-offset: 3px;
  }

  p {
    overflow-wrap: anywhere;
  }

  [role=alert] {
    color: var(--ss-danger);
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: var(--ss-space-3);
    margin-bottom: var(--ss-space-4);
  }

  h2 {
    overflow-wrap: anywhere;
  }

  .dialog-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--ss-space-3);
    justify-content: flex-end;
    margin-top: var(--ss-space-3);
  }

  form {
    display: grid;
    gap: var(--ss-space-3);
  }

  iframe {
    width: 100%;
    height: 70vh;
    min-height: 360px;
    border: 1px solid var(--ss-border);
    border-radius: var(--ss-radius-control);
    background: var(--ss-surface);
  }
</style>

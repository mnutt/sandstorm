<script lang="ts">
  import { portal } from './lib/portal';
  import Modal from './components/ui/Modal.svelte';
  import Button from './components/ui/Button.svelte';
  import TextInput from './components/ui/TextInput.svelte';
  import { appPath } from './lib/router';
  import { onMount, untrack } from 'svelte';
  import { PowerboxChooser } from './lib/powerbox';
  import { SharingWindow, type SharingState } from './lib/sharing';
  import { record, GrainTitleSubscriptions } from './lib/protocol';
  import type { ActiveGrain } from './lib/shell';
  let { grain, active, toolbarTarget, close, renderTemplate, pathChanged, rename }: { grain: ActiveGrain; active: boolean; toolbarTarget: HTMLElement; close: () => void; renderTemplate: (input: unknown) => Promise<string>; pathChanged: (path: string) => void; rename: (title: string) => Promise<void> } = $props();
  let frame: HTMLIFrameElement;
  let frameTitle = $state('');
  let path = $state(untrack(() => grain.path));
  let sharingState: SharingState = $state({ status: 'idle' });
  const titles = new GrainTitleSubscriptions(untrack(() => grain.ownerTitle),
    result => frame?.contentWindow?.postMessage(result, grain.origin));
  $effect(() => titles.update(grain.ownerTitle));
  let editing = $state(false);
  $effect(() => { if (!active) editing = false; });
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
<section class="grain-view" aria-label="Open grain" hidden={!active}>
  <div class="toolbar" use:portal={toolbarTarget} hidden={!active}>
    <div class="grain-title"><h2>{frameTitle || grain.title}</h2>
      {#if frameTitle}<p>{grain.title}</p>{/if}
    </div>
    <div class="grain-actions">
  <Modal bind:open={editing} title="Rename grain" triggerLabel="Rename grain" triggerVariant="chrome"
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
  <a href={mainHref}>Main shell ↗</a>
    <Button variant="chrome" onclick={() => { sharing.request('share'); sharing.open(); }}>Share</Button>
    <Button variant="chrome" onclick={() => { sharing.request('access'); sharing.open(); }}>Who has access</Button>
    <Button variant="chrome" onclick={close}>Close grain</Button>
    </div>
  </div>
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
</section>

<style>
  .grain-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .grain-title {
    flex: 1;
    min-width: 0;
  }

  .grain-title p {
    margin: 0;
    color: var(--ss-chrome-muted);
    font-size: var(--ss-text-small);
  }

  .grain-actions {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: var(--ss-space-1);
  }

  .grain-actions a {
    font-size: var(--ss-text-small);
  }

  h2 {
    margin: 0;
    font-size: 1rem;
    line-height: 1.3;
  }

  a {
    color: var(--ss-chrome-text);
    text-underline-offset: .2em;
  }

  a:focus-visible {
    outline: 3px solid var(--ss-chrome-focus);
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
    align-items: center;
    gap: var(--ss-space-3);
    width: 100%;
    min-width: 0;
    color: var(--ss-chrome-text);
  }
  .toolbar[hidden], .grain-view[hidden] { display: none; }
  h2, .grain-title p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .grain-actions { overflow-x: auto; flex-shrink: 0; max-width: 75%; }
  .grain-actions a { white-space: nowrap; padding: var(--ss-space-2); }
  @media (max-width: 1000px) {
    .toolbar { flex-wrap: wrap; gap: 0; }
    .grain-title { flex-basis: 100%; }
    .grain-actions { max-width: 100%; }
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
    flex: 1;
    min-height: 0;
    border: 0;
    border-radius: 0;
    background: var(--ss-surface);
  }
</style>

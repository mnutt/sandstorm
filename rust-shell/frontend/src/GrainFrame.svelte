<script lang="ts">
  import LoadingStatus from './components/ui/LoadingStatus.svelte';
  import { portal } from './lib/portal';
  import GrainIcon from './components/ui/GrainIcon.svelte';
  import ShellIcon from './components/ui/ShellIcon.svelte';
  import Modal from './components/ui/Modal.svelte';
  import Button from './components/ui/Button.svelte';
  import TextInput from './components/ui/TextInput.svelte';
  import { appPath } from './lib/router';
  import { onMount, untrack } from 'svelte';
  import { PowerboxChooser } from './lib/powerbox';
  import { SharingWindow, type SharingState } from './lib/sharing';
  import { record, GrainTitleSubscriptions } from './lib/protocol';
  import type { ActiveGrain } from './lib/shell';
  let { grain, active, toolbarTarget, canManage = true, renderTemplate, pathChanged, rename }: { grain: ActiveGrain; active: boolean; toolbarTarget: HTMLElement; canManage?:boolean; renderTemplate: (input: unknown) => Promise<string>; pathChanged: (path: string) => void; rename: (title: string) => Promise<void> } = $props();
  let frame: HTMLIFrameElement;
  let frameTitle = $state('');
  const frameUrl = $derived(grain.url);
  let frameLoaded = $state(false);
  let slow = $state(false);
  let showFrame = $state(false);
  $effect(() => {
    frameUrl;
    frameLoaded = false;
    slow = false;
    showFrame = false;
    const timer = setTimeout(() => { slow = true; }, 15000);
    return () => clearTimeout(timer);
  });
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
    if (data.powerboxRequest && canManage) chooser?.request(data.powerboxRequest);
    const template = record(data.renderTemplate);
    if (template && typeof template.rpcId === 'string' && template.rpcId.length <= 256) {
      const source = event.source as Window;
      const rpcId = template.rpcId;
      const origin = grain.origin;
      renderTemplate(template).then(uri => source.postMessage({ rpcId, uri }, origin),
        error => source.postMessage({ rpcId, error: String(error) }, origin));
    }
    if (data.startSharing && canManage) sharing?.request('share', data.startSharing);
    if (data.showConnectionGraph && canManage) sharing?.request('access');
  }
</script>

<svelte:window onmessage={message} />
<section class="grain-view" aria-label="Open grain" hidden={!active}>
  <div class="toolbar" use:portal={toolbarTarget} hidden={!active}>
    <div class="grain-title">
      <GrainIcon src={grain.iconSrc} />
      <div class="title-text"><h2 title={frameTitle || grain.title}>{frameTitle || grain.title}</h2>
        {#if frameTitle}<p>{grain.title}</p>{/if}
      </div>
      {#if canManage}<div class="rename-action">
  <Modal bind:open={editing} title="Rename grain" triggerLabel="Rename grain" triggerVariant="chrome"
    description="For a shared grain, this changes only your copy’s name." busy={renaming}
    onTrigger={() => { draftTitle = grain.title; renameError = ''; }}>
    {#snippet triggerContent()}<ShellIcon name="pencil" />{/snippet}
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
      </div>{/if}
    </div>
    {#if canManage}<div class="grain-actions">
      <Button variant="chrome" aria-label="Share" title="Share" onclick={() => { sharing.request('share'); sharing.open(); }}><ShellIcon name="share" /></Button>
      <Button variant="chrome" aria-label="Who has access" title="Who has access" onclick={() => { sharing.request('access'); sharing.open(); }}><ShellIcon name="users" /></Button>
    </div>{/if}
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
  <div class="frame-stage">
    <iframe bind:this={frame} title={grain.title} src={frameUrl} referrerpolicy="no-referrer" aria-busy={!frameLoaded} onload={() => { frameLoaded = true; }}></iframe>
    {#if !frameLoaded && !showFrame}
      <div class="frame-loading">
        <LoadingStatus label={slow ? 'Still loading this app…' : 'Loading app…'} detail={slow ? 'The app is taking longer than usual. You can show its content while it finishes loading.' : grain.title} />
        {#if slow}<Button variant="secondary" onclick={() => { showFrame = true; }}>Show app</Button>{/if}
      </div>
    {/if}
  </div>
</section>

<style>
  .frame-stage { position: relative; display: flex; flex: 1; min-height: 0; }
  .frame-loading { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: var(--ss-space-5); background: var(--ss-surface); }

  .grain-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .grain-title {
    display: flex;
    align-items: center;
    gap: var(--ss-space-2);
    min-width: 0;
    max-width: calc(100% - 6rem);
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

  h2 {
    margin: 0;
    font-size: 1rem;
    line-height: 1.3;
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
  .title-text { min-width: 0; }
  .rename-action { flex: none; opacity: 0; }
  .grain-title:hover .rename-action, .grain-title:focus-within .rename-action { opacity: 1; }
  .grain-actions { margin-left: auto; flex: none; }
  @media (hover: none) { .rename-action { opacity: 1; } }

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

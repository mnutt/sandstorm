<script lang="ts">
  import { appPath } from './lib/router';
  import { onMount, untrack } from 'svelte';
  import { PowerboxChooser } from './lib/powerbox';
  import { SharingWindow } from './lib/sharing';
  import type { ActiveGrain } from './lib/shell';
  let { grain, close, renderTemplate, pathChanged }: { grain: ActiveGrain; close: () => void; renderTemplate: (input: unknown) => Promise<string>; pathChanged: (path: string) => void } = $props();
  let frame: HTMLIFrameElement;
  let frameTitle = $state('');
  let path = $state(untrack(() => grain.path));
  let notice = $state('');
  let choosing = $state(false);
  let chooser: PowerboxChooser;
  let sharing: SharingWindow;
  onMount(() => {
    chooser = new PowerboxChooser(new URL(grain.mainHref).origin, new URL(grain.url).searchParams.get('sessionid') || '',
      result => frame?.contentWindow?.postMessage(result, grain.origin), value => { choosing = value; });
    sharing = new SharingWindow(new URL(grain.mainHref).origin, new URL(grain.url).searchParams.get('sessionid') || '',
      value => { notice = value; });
    return () => { chooser.cancel(); sharing.cancel(); };
  });
  const mainHref = $derived(grain.mainHref + (path === '/' ? '' : path));
  function message(event: MessageEvent) {
    chooser?.message(event);
    sharing?.message(event);
    if (event.origin !== grain.origin || event.source !== frame?.contentWindow ||
        !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
    const data = event.data;
    if (typeof data.setTitle === 'string') frameTitle = data.setTitle.slice(0, 160);
    if (typeof data.setPath === 'string') {
      const next = appPath(data.setPath || '/');
      if (next) { path = next; pathChanged(path); }
    }
    if (data.getGrainTitle && (typeof data.rpcId === 'string' || typeof data.rpcId === 'number')) {
      frame.contentWindow?.postMessage({ rpcId: data.rpcId, grainTitle: grain.title }, grain.origin);
    }
    if (data.powerboxRequest) chooser?.request(data.powerboxRequest);
    if (data.renderTemplate && typeof data.renderTemplate.rpcId === 'string') {
      const source = event.source as Window;
      const rpcId = data.renderTemplate.rpcId;
      renderTemplate(data.renderTemplate).then(uri => source.postMessage({ rpcId, uri }, grain.origin),
        error => source.postMessage({ rpcId, error: String(error) }, grain.origin));
    }
    if (data.startSharing) sharing?.request('share', data.startSharing);
    if (data.showConnectionGraph) sharing?.request('access');
  }
</script>

<svelte:window onmessage={message} />
<section class="grain-view" aria-label="Open grain">
  <div class="toolbar"><h2>{frameTitle || grain.title}</h2><button onclick={close}>Close grain</button></div>
  <p><a href={mainHref}>Open in main shell ↗</a>
    <button onclick={() => { sharing.request('share'); sharing.open(); }}>Share</button>
    <button onclick={() => { sharing.request('access'); sharing.open(); }}>Who has access</button></p>
  {#if notice}<div role="status"><p>{notice}</p>
    <button onclick={() => sharing.open()}>Open sharing window</button>
    <button onclick={() => sharing.cancel()}>Close sharing window</button></div>{/if}
  {#if choosing}<div role="status"><p>This app wants you to choose a capability.</p>
    <button onclick={() => chooser.open()}>Choose in Sandstorm</button>
    <button onclick={() => chooser.cancel()}>Cancel request</button></div>{/if}
  <iframe bind:this={frame} title={grain.title} src={grain.url} referrerpolicy="no-referrer"></iframe>
</section>

<style>
  .grain-view { min-width: 0; background: white; border: 1px solid #ddd; padding: 16px; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  h2 { margin: 0; font-size: 20px; overflow-wrap: anywhere; }
  button { font: inherit; padding: 8px 12px; cursor: pointer; }
  a { color: #633388; }
  iframe { width: 100%; height: 70vh; min-height: 360px; border: 1px solid #ddd; }
</style>

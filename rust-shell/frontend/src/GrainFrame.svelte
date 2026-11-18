<script lang="ts">
  import type { ActiveGrain } from './lib/shell';
  let { grain, close }: { grain: ActiveGrain; close: () => void } = $props();
  let frame: HTMLIFrameElement;
  let frameTitle = $state('');
  let path = $state('/');
  let notice = $state('');
  const mainHref = $derived(grain.mainHref + (path === '/' ? '' : path));
  function message(event: MessageEvent) {
    if (event.origin !== grain.origin || event.source !== frame?.contentWindow ||
        !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
    const data = event.data;
    if (typeof data.setTitle === 'string') frameTitle = data.setTitle.slice(0, 160);
    if (typeof data.setPath === 'string' && data.setPath.length <= 2048 && data.setPath.startsWith('/') && !data.setPath.startsWith('//') && !data.setPath.includes('\\')) {
      const target = new URL(data.setPath, grain.origin);
      if (target.origin === grain.origin) path = target.pathname + target.search + target.hash;
    }
    if (data.getGrainTitle && (typeof data.rpcId === 'string' || typeof data.rpcId === 'number')) {
      frame.contentWindow?.postMessage({ rpcId: data.rpcId, grainTitle: grain.title }, grain.origin);
    }
    const unsupported = data.powerboxRequest || data.renderTemplate;
    if (unsupported && (typeof unsupported.rpcId === 'string' || typeof unsupported.rpcId === 'number')) {
      frame.contentWindow?.postMessage({ rpcId: unsupported.rpcId, error: 'This operation is available in the main Sandstorm shell.' }, grain.origin);
      notice = 'This app requested a feature that is available in the main shell.';
    }
    if (data.startSharing || data.showConnectionGraph) notice = 'Use the main shell to manage sharing.';
  }
</script>

<svelte:window onmessage={message} />
<section class="grain-view" aria-label="Open grain">
  <div class="toolbar"><h2>{frameTitle || grain.title}</h2><button onclick={close}>Close grain</button></div>
  <p><a href={mainHref}>Open in main shell ↗</a></p>
  {#if notice}<p role="status">{notice} <a href={mainHref}>Continue there.</a></p>{/if}
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

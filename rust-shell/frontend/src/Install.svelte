<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { ShellService, ShellState } from './lib/shell';
  import type { InstallState, InstallCatalog } from './lib/install';
  import { installRoute, appRoute, rememberRoute } from './lib/router';
  import Panel from './components/ui/Panel.svelte';
  import Button from './components/ui/Button.svelte';
  import AppIcon from './components/ui/AppIcon.svelte';
  import LoadingStatus from './components/ui/LoadingStatus.svelte';
  let {service, model, packageId, url, navigate}: {service:ShellService;model:ShellState;packageId?:string;url:string;navigate:(path:string)=>void} = $props();
  let pkg = $state<InstallState>();
  let catalog = $state<InstallCatalog>();
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let uploadPercent = $state<number>();
  let alive = true;
  const lifetime = new AbortController();
  const stages: Record<string,string> = {download:'Downloading app…',verify:'Verifying package…',unpack:'Unpacking app…',analyze:'Analyzing app…',delete:'Removing package…'};
  let generation = 0;
  $effect(() => {
    if (model.status !== 'ready' || model.fixture) return;
    const current = ++generation;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = packageId ? await service.installation.state('status',packageId) : await service.installation.catalog();
        if (!alive || current !== generation) return;
        if (packageId) pkg = result as InstallState; else catalog = result as InstallCatalog;
        loading = false;
        if (packageId) timer = setTimeout(load,1500);
      } catch (failure) { if (alive && current === generation) { error = String(failure); loading = false; } }
    };
    void load();
    return () => { ++generation; clearTimeout(timer); };
  });
  onDestroy(() => { alive = false; lifetime.abort(); });
  async function act(operation: string) {
    if (!packageId || busy) return;
    busy = true; error = '';
    try {
      const result = await service.installation.state(operation,packageId,url);
      if (alive) pkg = result;
    } catch (failure) { if (alive) error = `Could not confirm the operation. It was not retried. Check the current status before trying again. ${String(failure)}`; }
    finally { if (alive) busy = false; }
  }
  async function upload(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0]; input.value = '';
    if (!file || busy) return;
    busy = true; error = ''; uploadPercent = 0;
    try {
      const id = await service.installation.upload(file,lifetime.signal,value => { if (alive) uploadPercent = value; });
      if (alive) navigate(installRoute(id));
    } catch (failure) { if (alive) error = String(failure); }
    finally { if (alive) { busy = false; uploadPercent = undefined; } }
  }
  const marketUrl = $derived.by(() => {
    if (!catalog) return '';
    const target = new URL(catalog.marketUrl);
    target.searchParams.set('host',location.origin);
    return target.href;
  });
</script>
<Panel aria-label="App installation">
  {#if model.status === 'signed-out'}<p><a href="/login" onclick={rememberRoute}>Sign in with Sandstorm</a> to install apps.</p>
  {:else if model.status !== 'ready'}<LoadingStatus label="Connecting to Sandstorm…" />
  {:else if model.fixture}<p>App installation requires an installed Sandstorm server.</p>
  {:else if loading}<LoadingStatus label="Loading app details…" />
  {:else if !packageId}
    <div class="install-options"><a class="market" href={marketUrl}>Browse app market</a><label class="upload">Upload an SPK<input type="file" accept=".spk" disabled={busy} onchange={upload} /></label></div>
    {#if uploadPercent !== undefined}<LoadingStatus label={uploadPercent < 100 ? 'Uploading package…' : 'Verifying uploaded package…'} /><progress max="100" value={uploadPercent}></progress>{/if}
    <h2>Available updates</h2>
    {#if catalog?.updates.length}<ul>{#each catalog.updates as update (update.packageId)}<li><div><strong>{update.title}</strong><small>{update.version}</small></div><Button variant="secondary" disabled={busy} onclick={() => navigate(installRoute(update.packageId,update.url))}>Review update</Button></li>{/each}</ul>
    {:else}<p>No updates listed by this server’s app index.</p>{/if}
  {:else if pkg}
    {#if pkg.title}<div class="summary"><AppIcon src={pkg.iconSrc} /><div><h2>{pkg.title}</h2><p>{pkg.description}</p><small>Version {pkg.version}</small></div></div>{/if}
    {#if pkg.status === 'ready'}
      {#if pkg.fingerprint}<p class="fingerprint">Author signing key: {pkg.fingerprint}</p>{/if}
      {#if pkg.newerInstalled}<p>A newer version is already installed. Downgrading is not available.</p>
      {:else if !pkg.installed}<p>Install this app for your account? Existing grains keep their current version until you choose to upgrade them.</p><Button disabled={busy} onclick={() => act('confirm')}>{busy ? 'Installing…' : 'Install app'}</Button>
      {:else}<p>Installed for your account.</p><div class="actions"><Button disabled={busy} onclick={() => navigate(appRoute(pkg!.appId))}>Open app</Button>
        {#if pkg.olderGrains}<Button variant="secondary" disabled={busy} onclick={() => act('upgrade')}>{busy ? 'Upgrading…' : `Upgrade ${pkg.olderGrains} existing ${pkg.olderGrains === 1 ? 'grain' : 'grains'}`}</Button>{/if}</div>
        {#if pkg.olderGrains}<p class="hint">Upgrading restarts your grains using this version. Newer grains are left unchanged.</p>{/if}
      {/if}
    {:else if pkg.status === 'failed'}<p role="alert">{pkg.error || 'Package installation failed.'}</p><Button disabled={busy || !url} onclick={() => act('retry')}>Retry download</Button>
    {:else if pkg.status === 'missing'}<p>Download and verify this package before installing it.</p><p class="source">{url || 'No download URL supplied. Upload the SPK or open a link from the app market.'}</p><Button disabled={busy || !url} onclick={() => act('download')}>{busy ? 'Starting…' : 'Download app'}</Button>
    {:else}<LoadingStatus label={stages[pkg.status] || 'Preparing app…'} />{#if pkg.progress > 0 && pkg.progress <= 1}<progress max="1" value={pkg.progress}></progress>{:else if pkg.progress > 1}<p>{Math.round(pkg.progress / 1024)} KiB downloaded</p>{/if}{/if}
    <div class="back"><Button variant="secondary" disabled={busy} onclick={() => navigate('/install')}>Back to app installation</Button></div>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</Panel>
<style>
  h2 { font-size: 1rem; margin: var(--ss-space-4) 0 var(--ss-space-2); }
  p { overflow-wrap: anywhere; }
  .install-options,.actions,.summary { display:flex; align-items:center; gap:var(--ss-space-3); flex-wrap:wrap; }
  .summary h2 { margin-top:0; }
  .summary p { margin:.35rem 0; }
  .market { color:var(--ss-brand); font-weight:600; }
  .upload { display:flex; align-items:center; gap:var(--ss-space-2); font-size:var(--ss-text-small); }
  input { max-width:18rem; }
  ul { padding:0; margin:0; list-style:none; }
  li { display:flex; align-items:center; justify-content:space-between; gap:var(--ss-space-3); padding:var(--ss-space-3) 0; border-bottom:1px solid var(--ss-border); }
  small { display:block; color:var(--ss-muted); }
  .hint,.fingerprint,.source { color:var(--ss-muted); font-size:var(--ss-text-small); }
  .back { margin-top:var(--ss-space-4); }
  [role=alert] { color:var(--ss-danger); }
  progress { width:100%; max-width:32rem; accent-color:var(--ss-brand); }
</style>

<script lang="ts">
  import Pagination from './components/ui/Pagination.svelte';
  import LoadingStatus from './components/ui/LoadingStatus.svelte';
  import Grains from './Grains.svelte';
  import { isPlainNavigation } from './lib/navigation';
  import AppIcon from './components/ui/AppIcon.svelte';
  import Button from './components/ui/Button.svelte';
  import TextInput from './components/ui/TextInput.svelte';
  import NativeSelect from './components/ui/NativeSelect.svelte';
  import Panel from './components/ui/Panel.svelte';
  import { onDestroy, tick } from 'svelte';
  import { rememberRoute, appRoute } from './lib/router';
  import type { ShellService, ShellState, AppAction } from './lib/shell';
  let { service, model, appId, navigate, created, checkGrains }: { service: ShellService; model: ShellState; appId?: string;
    navigate: (path: string) => void; created: (id: string) => void; checkGrains: () => void } = $props();
  const status = $derived(model.status);
  const fixture = $derived(model.fixture);
  const creation = $derived(model.creation);
  const appGrains = $derived({ ...model, grains: model.grains.filter(grain => grain.appId === appId) });
  function openApp(event: MouseEvent, id: string) {
    if (!isPlainNavigation(event)) return;
    event.preventDefault();
    navigate(appRoute(id));
  }
  $effect(() => { appId; selected = ''; });
  let actions: AppAction[] = $state([]);
  let limited = $state(false);
  let page = $state(0);
  let loading = $state(false);
  const creating = $derived(creation.status === 'pending');
  let error = $state('');
  const uncertain = $derived(creation.status === 'unknown');
  let selected = $state('');
  let title = $state('New grain');
  let search = $state('');
  let createForm = $state<HTMLFormElement>();
  const apps = $derived.by(() => {
    const grouped = new Map<string, { id: string; title: string; description: string; iconSrc: string; grainCount: number; actions: AppAction[] }>();
    for (const action of actions) {
      const id = action.appId || action.key;
      const app = grouped.get(id);
      if (app) app.actions.push(action);
      else grouped.set(id, { id, title: action.appTitle, description: action.shortDescription, iconSrc: action.iconSrc, grainCount: action.grainCount, actions: [action] });
    }
    return [...grouped.values()].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  });
  const visibleApps = $derived(apps.filter(app => app.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  const mostUsedApps = $derived(apps.filter(app => app.grainCount > 0).sort((a, b) => b.grainCount - a.grainCount || a.title.localeCompare(b.title)).slice(0, 6));
  const selectedApp = $derived(apps.find(app => app.id === appId));
  function choose(app: typeof apps[number]) {
    if (creation.status !== 'idle') return;
    selected = app.actions[0].key;
    title = app.actions[0].title || 'New grain';
    void tick().then(() => createForm?.querySelector<HTMLInputElement>('input')?.focus());
  }
  let epoch = 0;
  let alive = true;
  async function load(nextPage = 0) {
    const current = ++epoch;
    loading = true;
    try {
      const result = await service.listApps(nextPage, appId || '');
      if (current !== epoch) return;
      actions = result.actions; limited = result.limited; page = nextPage;
    } catch (failure) { if (current === epoch) error = String(failure); }
    finally { if (current === epoch) loading = false; }
  }
  $effect(() => {
    if (status === 'ready' && !fixture) void load();
    else { ++epoch; actions = []; selected = ''; title = 'New grain'; loading = false; }
  });
  onDestroy(() => { alive = false; ++epoch; });
  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (creation.status !== 'idle' || !selected || !title.trim()) return;
    error = '';
    try {
      const id = await service.createGrain(selected, title);
      if (alive) created(id);
    } catch (failure) {
      // The account-scoped service retains the outcome even after this page unmounts.
    }
  }
</script>
<Panel aria-label="Apps">
  {#if status === 'signed-out'}<p><a href="/login" onclick={rememberRoute}>Sign in with Sandstorm</a> to see your installed apps.</p>
  {:else if status !== 'ready'}<LoadingStatus label="Connecting to Sandstorm…" />
  {:else if fixture}<p>App creation requires an installed Sandstorm server.</p>
  {:else}
    {#if loading}<LoadingStatus label="Loading apps…" />
    {:else}
      {#snippet tiles(items: typeof apps, install = false)}
        <div class="app-grid">
          {#if install}
            <a class="app-tile" href="/install" aria-label="Install from App Market" onclick={event => { if (isPlainNavigation(event)) { event.preventDefault(); navigate('/install'); } }}>
              <span class="install-icon"><svg aria-hidden="true" width="112" height="112" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 5v14M5 12h14" /></svg></span>
              <span class="app-name">Install</span><span class="app-hint">from App Market</span>
            </a>
          {/if}
          {#each items as app (app.id)}
            <a class="app-tile" href={appRoute(app.id)} aria-label={`Open ${app.title}`} onclick={event => openApp(event, app.id)}>
              <AppIcon src={app.iconSrc} /><span class="app-name" title={app.title}>{app.title}</span>
              <span class="app-hint" title={app.description}>{app.description}</span>
            </a>
          {/each}
        </div>
      {/snippet}
      {#if !appId}
      {#if mostUsedApps.length}<section aria-labelledby="most-used-apps-title"><h2 id="most-used-apps-title">Most used</h2>{@render tiles(mostUsedApps)}</section>{/if}
      <section aria-labelledby="installed-apps-title">
        <div class="app-controls"><h2 id="installed-apps-title">All apps <span class="count">{apps.length}</span></h2><div class="search"><label class="sr-only" for="app-search">Search apps</label><TextInput id="app-search" type="search" bind:value={search} placeholder="Search installed apps" /></div></div>
        {@render tiles(visibleApps, true)}
        {#if !visibleApps.length && search.trim()}<p>No apps match your search.</p>{/if}
      </section>
      {:else if selectedApp}
        <div class="app-detail-heading">
          <div class="app-summary"><AppIcon src={selectedApp.iconSrc} /><div><h2>{selectedApp.title}</h2><p>{selectedApp.description}</p></div></div>
          <Button disabled={creation.status !== 'idle'} onclick={() => choose(selectedApp)}>New grain</Button>
        </div>
      {:else}<p>This app is not in the loaded installed-app list.</p><Button variant="secondary" onclick={() => navigate('/apps')}>Back to apps</Button>{/if}
      {#if appId && (selected || uncertain)}
      <form bind:this={createForm} onsubmit={create} aria-label="Create a grain">
        <h2>{selectedApp ? `Create with ${selectedApp.title}` : 'Create a grain'}</h2>
        <label for="app-action">Installed app action</label>
        <NativeSelect id="app-action" bind:value={selected} disabled={creating || uncertain} required>
          <option value="">Choose an action</option>
          {#each selectedApp?.actions || actions as action (action.key)}<option value={action.key}>{action.title}</option>{/each}
        </NativeSelect>
        <label for="new-grain-title">Grain title</label>
        <TextInput id="new-grain-title" bind:value={title} maxlength={160} required disabled={creating || uncertain} />
        <div class="form-actions"><Button type="submit" disabled={creation.status !== 'idle' || !selected || !title.trim()}>{creating ? 'Creating grain…' : 'Create grain'}</Button>
        <Button variant="secondary" disabled={creating || uncertain} onclick={() => { selected = ''; }}>Cancel</Button></div>
      </form>
      {/if}
    {/if}
    {#if appId && selectedApp}<div class="app-grains"><Grains model={appGrains} {service} {navigate} {appId} /></div>{/if}
    <Pagination {page} more={limited} busy={loading} label="Apps" change={load} />
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if creation.status === 'created'}<p>Grain created.</p><Button onclick={() => created(creation.grainId)}>Open created grain</Button><Button onclick={() => service.acknowledgeCreation()}>Create another grain</Button>{/if}
  {#if uncertain}<p role="alert">{creation.status === 'unknown' ? creation.error : ''}</p><p>The request was not retried. Check your grains before creating another.</p><Button onclick={checkGrains}>Check grains</Button><Button onclick={() => service.acknowledgeCreation()}>I checked my grains</Button>{/if}
</Panel>
<style>
  h2 { margin: 0 0 var(--ss-space-3); font-size: .875rem; font-weight: 600; color: var(--ss-muted); }
  a { color: var(--ss-brand); text-underline-offset: .2em; }
  a:focus-visible, .app-tile:focus-visible { outline: 3px solid var(--ss-focus); outline-offset: 3px; }
  p { overflow-wrap: anywhere; }
  [role=alert] { color: var(--ss-danger); }
  .app-controls { display: flex; gap: var(--ss-space-3); align-items: center; margin-bottom: var(--ss-space-4); --ss-control-height: 2.375rem; font-size: var(--ss-text-small); }
  .app-controls h2 { margin: 0; flex: none; }
  .search { flex: 1; max-width: 32rem; margin-left: auto; min-width: 0; }
  section + section { border-top: 1px solid var(--ss-border); padding-top: var(--ss-space-3); margin-top: var(--ss-space-3); }
  .count { font-weight: 400; margin-left: .35rem; font-variant-numeric: tabular-nums; }
  .app-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); gap: var(--ss-space-2); }
  .app-tile { display: flex; flex-direction: column; align-items: center; gap: var(--ss-space-1); padding: var(--ss-space-1); min-width: 0; border: 1px solid transparent; border-radius: var(--ss-radius-panel); background: transparent; color: var(--ss-text); font: inherit; text-decoration: none; cursor: pointer; }
  .app-tile:hover { background: var(--ss-brand-subtle); border-color: var(--ss-border); }
  .install-icon { display: grid; place-items: center; width: 128px; max-width: 100%; height: 128px; flex: none; color: var(--ss-brand); }
  .install-icon svg { max-width: 100%; }
  .app-name { font-size: var(--ss-text-small); font-weight: 600; }
  .app-hint { font-size: .75rem; color: var(--ss-muted); min-height: 1.5em; }
  .app-name, .app-hint { display: block; width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; }
  .app-detail-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--ss-space-4); margin-bottom: var(--ss-space-4); }
  .app-summary { display: flex; align-items: center; gap: var(--ss-space-4); min-width: 0; flex: 1; }
  .app-summary > div { min-width: 0; }
  .app-summary h2 { color: var(--ss-text); font-size: var(--ss-text-title); overflow-wrap: anywhere; }
  .app-summary p { color: var(--ss-muted); margin: 0; font-size: var(--ss-text-small); }
  .app-grains { margin-top: var(--ss-space-4); }
  form { display: grid; gap: var(--ss-space-2); max-width: 32rem; margin-top: var(--ss-space-5); padding-top: var(--ss-space-4); border-top: 1px solid var(--ss-border); }
  form h2 { color: var(--ss-text); font-size: 1rem; }
  .form-actions { display: flex; flex-wrap: wrap; gap: var(--ss-space-2); margin-top: var(--ss-space-2); }
  label { font-weight: 600; font-size: var(--ss-text-small); }
  @media (max-width: 450px) { .app-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>

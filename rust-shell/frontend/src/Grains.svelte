<script lang="ts">
  import GrainIcon from './components/ui/GrainIcon.svelte';
  import Button from './components/ui/Button.svelte';
  import TextInput from './components/ui/TextInput.svelte';
  import NativeSelect from './components/ui/NativeSelect.svelte';
  import Panel from './components/ui/Panel.svelte';
  import type { ShellState, ShellService } from './lib/shell';
  import { rememberRoute, grainRoute } from './lib/router';
  let { model, service, navigate }: { model: ShellState; service: ShellService; navigate: (path: string) => void } = $props();
  let search = $state('');
  let sort = $state('recent');
  let ownership = $state('all');
  const visibleGrains = $derived(model.grains.filter((grain) =>
    (ownership === 'all' || grain.owned === (ownership === 'owned')) &&
    `${grain.title} ${grain.appTitle}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
    .sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) || a.key.localeCompare(b.key)
      : b.lastUsed.localeCompare(a.lastUsed) || a.title.localeCompare(b.title) || a.key.localeCompare(b.key)));
  function openGrain(event: MouseEvent, id: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(grainRoute(id));
  }
  const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
</script>
  <Panel aria-label="Grains" padded={model.status !== 'ready' || model.fixture}>

    {#if model.status === 'signed-out'}
      <p><a href="/auth/start" onclick={rememberRoute}>Sign in with Sandstorm</a> to see your grains.</p>
    {:else if model.status !== 'ready'}
      <p class="empty">{model.status === 'waiting' ? 'Waiting for the main shell… Your login will be checked when it returns.' : model.status === 'reconnecting' ? 'Connection lost. Reconnecting…' : 'Loading your grains…'}</p>
      <Button variant="secondary" onclick={() => service.reconnect()}>Reconnect</Button>
    {:else if model.fixture}
      <p class="empty">Connect to an installed Sandstorm server to see real grains.</p>
    {:else}
      <div class="grain-controls">
      <div class="search"><label class="sr-only" for="grain-search">Filter shown grains</label>
      <TextInput id="grain-search" type="search" bind:value={search} placeholder="Search by title or app" /></div>
        <div><label for="grain-ownership">Show</label><NativeSelect id="grain-ownership" bind:value={ownership}><option value="all">All grains</option><option value="owned">Owned by you</option><option value="shared">Shared with you</option></NativeSelect></div>
        <div><label for="grain-sort">Sort by</label><NativeSelect id="grain-sort" bind:value={sort}><option value="recent">Recent use</option><option value="title">Title</option></NativeSelect></div>
      </div>
      <p class="result-count" role="status">{visibleGrains.length} {visibleGrains.length === 1 ? 'grain' : 'grains'}{search || ownership !== 'all' ? ` matching your filters · ${model.grains.length} loaded` : ''}</p>
      {#if visibleGrains.length === 0}<p class="empty">{model.grains.length ? 'No matching grains.' : 'You have no grains to show.'}</p>{/if}
      {#if visibleGrains.length}
      <div class="table-scroll">
        <table aria-label="Grains">
          <colgroup><col class="name-column" /><col class="app-column" /><col class="access-column" /><col class="date-column" /></colgroup>
          <thead><tr><th scope="col">Name</th><th scope="col">App</th><th scope="col">Access</th><th scope="col" class="last-used">Last used</th></tr></thead>
          <tbody>
            {#each visibleGrains as grain (grain.key)}
              <tr class="grain-item">
                <td><a class="grain-name" href={grainRoute(grain.key)} onclick={event => openGrain(event, grain.key)} title={grain.title}>
                  <GrainIcon src={grain.iconSrc} /><span>{grain.title}</span>
                </a></td>
                <td class="app-name"><span title={grain.appTitle}>{grain.appTitle || 'Unknown app'}</span></td>
                <td><span class="access" class:shared={!grain.owned}>{grain.owned ? 'Owned by you' : 'Shared with you'}</span></td>
                <td class="last-used">{#if grain.lastUsed}<time datetime={grain.lastUsed} title={new Date(grain.lastUsed).toLocaleString()}>{dateFormat.format(new Date(grain.lastUsed))}</time>{:else}<span aria-label="Never used">—</span>{/if}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {/if}
      {#if model.grainsLimited}<p>This is a limited preview of your grains. <a href="/main-shell">View all grains in the main shell.</a></p>{/if}
    {/if}
    {#if model.openingGrain}<p role="status">Opening grain…</p>{/if}
  </Panel>
<style>
  a { color: var(--ss-brand); text-underline-offset: .2em; }
  a:focus-visible { outline: 3px solid var(--ss-focus); outline-offset: 3px; }
  .grain-controls { display: flex; flex-wrap: wrap; align-items: end; gap: var(--ss-space-3); margin: var(--ss-space-3); --ss-control-height: 2.375rem; font-size: var(--ss-text-small); }
  .search { flex: 1 1 15rem; }
  label:not(.sr-only) { display: block; margin-bottom: var(--ss-space-1); color: var(--ss-muted); font-size: .75rem; font-weight: 600; }
  .result-count { margin: var(--ss-space-3); color: var(--ss-muted); font-size: .75rem; }
  p:not(.result-count) { margin-inline: var(--ss-space-3); }
  .empty { color: var(--ss-muted); padding: var(--ss-space-5) 0; }
  /* Keep the heading in the page scroll context, below the shell topbar. */
  .table-scroll { overflow: visible; }
  table { width: 100%; min-width: 0; border-collapse: collapse; table-layout: fixed; font-size: var(--ss-text-small); }
  .name-column { width: 44%; }
  .app-column { width: 22%; }
  .access-column { width: 18%; }
  .date-column { width: 16%; }
  th { position: sticky; top: var(--ss-header-height); z-index: 1; box-shadow: inset 0 1px var(--ss-border), inset 0 -1px var(--ss-border); padding: .5rem .75rem; text-align: left; color: var(--ss-muted); background: var(--ss-canvas); border-block: 1px solid var(--ss-border); font-size: .6875rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
  td { padding: .7rem .75rem; border-bottom: 1px solid color-mix(in srgb, var(--ss-border) 45%, var(--ss-surface)); vertical-align: middle; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover, tbody tr:focus-within { background: var(--ss-brand-subtle); }
  .grain-name { display: flex; align-items: center; gap: .65rem; min-width: 0; color: var(--ss-text); text-decoration: none; font-weight: 600; }
  .grain-name:hover { color: var(--ss-brand); }
  .grain-name:hover span { text-decoration: underline; text-underline-offset: .2em; }
  .grain-name span, .app-name span { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .app-name { color: var(--ss-muted); }
  .access { display: inline-block; font-size: .75rem; color: var(--ss-muted); white-space: nowrap; }
  .access.shared { color: var(--ss-brand); }
  .last-used { text-align: right; white-space: nowrap; }
  td.last-used { color: var(--ss-muted); font-size: .75rem; font-variant-numeric: tabular-nums; }
  @media (max-width: 700px) {
    .search { flex-basis: 100%; }
    th, td { padding-inline: .5rem; }
    .access, .last-used { white-space: normal; overflow-wrap: anywhere; }
    .name-column { width: 38%; }
    .access-column { width: 22%; }
    .date-column { width: 18%; }
  }
</style>

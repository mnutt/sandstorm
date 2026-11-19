<script lang="ts">
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
</script>
  <Panel aria-labelledby="grains-title">
    <div class="heading"><h2 id="grains-title">Grains</h2><span class="status" role="status">{model.status}</span></div>
    {#if model.status === 'signed-out'}
      <p><a href="/auth/start" onclick={rememberRoute}>Sign in with Sandstorm</a> to see your grains.</p>
    {:else if model.status !== 'ready'}
      <p class="empty">{model.status === 'waiting' ? 'Waiting for the main shell… Your login will be checked when it returns.' : model.status === 'reconnecting' ? 'Connection lost. Reconnecting…' : 'Loading your grains…'}</p>
      <Button variant="secondary" onclick={() => service.reconnect()}>Reconnect</Button>
    {:else if model.fixture}
      <p class="empty">Connect to an installed Sandstorm server to see real grains.</p>
    {:else}
      <p>Open a grain here using your Sandstorm identity. Sharing and Powerbox remain in the main shell.</p>
      <label for="grain-search">Filter shown grains</label>
      <TextInput id="grain-search" type="search" bind:value={search} placeholder="Search by title or app" />
      <div class="grain-controls">
        <div><label for="grain-ownership">Show</label><NativeSelect id="grain-ownership" bind:value={ownership}><option value="all">All shown grains</option><option value="owned">Owned by you</option><option value="shared">Shared with you</option></NativeSelect></div>
        <div><label for="grain-sort">Sort by</label><NativeSelect id="grain-sort" bind:value={sort}><option value="recent">Recent use</option><option value="title">Title</option></NativeSelect></div>
        <Button variant="secondary" onclick={() => service.reconnect()}>Refresh</Button>
      </div>
      <p class="result-count">Showing {visibleGrains.length} of {model.grains.length} loaded grains.</p>
      {#if visibleGrains.length === 0}<p class="empty">{model.grains.length ? 'No matching grains.' : 'You have no grains to show.'}</p>{/if}
      <ul>
        {#each visibleGrains as grain (grain.key)}
          <li class="grain-item"><div>
            <h3><a href={grain.href}>{grain.title}</a></h3>
            <p><span>{grain.appTitle || 'Unknown app'}</span> · <span>{grain.owned ? 'Owned by you' : 'Shared with you'}</span></p>
            {#if grain.lastUsed}<time datetime={grain.lastUsed}>Last used {new Date(grain.lastUsed).toLocaleString()}</time>{/if}
          </div><Button disabled={model.openingGrain} onclick={() => navigate(grainRoute(grain.key))} aria-label={`Open ${grain.title} here`}>Open here</Button></li>
        {/each}
      </ul>
      {#if model.grainsLimited}<p>This is a limited preview of your grains. <a href="/main-shell">View all grains in the main shell.</a></p>{/if}
    {/if}
    {#if model.openingGrain}<p role="status">Opening grain…</p>{/if}
  </Panel>
<style>
  h2 {
    margin: 0 0 var(--ss-space-4);
    font-size: var(--ss-text-title);
    line-height: 1.3;
  }

  h3 {
    margin: 0;
    font-size: 1rem;
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

  .heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--ss-space-3);
  }

  .status, .result-count, time {
    color: var(--ss-muted);
    font-size: var(--ss-text-small);
  }

  .grain-controls {
    display: flex;
    flex-wrap: wrap;
    gap: var(--ss-space-3);
    align-items: end;
    margin: var(--ss-space-4) 0;
  }

  ul {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--ss-space-4);
    padding: var(--ss-space-5) 0;
    border-top: 1px solid var(--ss-border);
  }

  li > div {
    flex: 1 1 14rem;
    min-width: 0;
  }

  h3 a {
    overflow-wrap: anywhere;
  }

  li p {
    color: var(--ss-muted);
    margin: var(--ss-space-1) 0;
  }

  label {
    display: block;
    margin-bottom: var(--ss-space-2);
    font-size: var(--ss-text-small);
    font-weight: 600;
  }
</style>

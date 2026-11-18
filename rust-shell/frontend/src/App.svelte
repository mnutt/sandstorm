<script lang="ts">
  import GrainFrame from './GrainFrame.svelte';
  import { onMount } from 'svelte';
  import { ShellService, type ShellState } from './lib/shell';

  let model: ShellState = $state({ status: 'connecting', entries: [], grains: [], grainsLimited: false, activeGrain: null, openingGrain: false, revision: 0, error: '', pending: false, fixture: true, account: null, total: 0 });
  const notifications = new ShellService((next) => { model = next; });
  let view = $state<'notifications' | 'grains'>('notifications');
  let search = $state('');
  let sort = $state('recent');
  let ownership = $state('all');
  const visibleGrains = $derived(model.grains.filter((grain) =>
    (ownership === 'all' || grain.owned === (ownership === 'owned')) &&
    `${grain.title} ${grain.appTitle}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
    .sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) || a.key.localeCompare(b.key)
      : b.lastUsed.localeCompare(a.lastUsed) || a.title.localeCompare(b.title) || a.key.localeCompare(b.key)));
  onMount(() => { notifications.start(); return () => notifications.stop(); });
</script>

<svelte:head><meta name="description" content="Experimental Sandstorm shell running on Rust and Svelte." /></svelte:head>

<header><strong>Sandstorm</strong><span>Rust shell · experimental</span></header>
<main>
  <aside aria-label="About this shell">
    <h1>Shell preview</h1>
    <p>A small first step toward the new architecture.</p>
    <a href="/main-shell">Open the main shell ↗</a>
    <nav aria-label="Shell pages">
      <button class="secondary" aria-current={view === 'notifications' ? 'page' : undefined} onclick={() => { void notifications.closeGrain().catch(() => notifications.reconnect()); view = 'notifications'; }}>Notifications</button>
      <button class="secondary" aria-current={view === 'grains' ? 'page' : undefined} onclick={() => { void notifications.closeGrain().catch(() => notifications.reconnect()); view = 'grains'; }}>Grains</button>
    </nav>
    <hr />
    {#if model.fixture}
      <h2>Fixture mode</h2>
      <p>These notifications are test data, private to this connection. Reconnecting resets them.</p>
    {:else if model.account}
      <h2>Connected as {model.account}</h2>
      <p>Notifications and dismissals are shared with the main shell. Changes appear within a few seconds.</p>
      <p><a href="/auth/start">Switch account</a></p>
      <button class="secondary" onclick={() => notifications.logout()}>Disconnect</button>
    {:else}
      <h2>Your Sandstorm account</h2>
      <p>Sign in through the main shell to see your real notifications.</p>
    {/if}
    <p>Grains can open here. App management and sharing remain in the main shell.</p>
  </aside>
  {#if model.activeGrain}
    {#key model.activeGrain.url}
      <GrainFrame grain={model.activeGrain} close={() => { void notifications.closeGrain().catch(() => notifications.reconnect()); }} />
    {/key}
  {:else if view === 'grains'}
  <section aria-labelledby="grains-title">
    <div class="heading"><h2 id="grains-title">Grains</h2><span class="status" role="status">{model.status}</span></div>
    {#if model.status === 'signed-out'}
      <p><a href="/auth/start">Sign in with Sandstorm</a> to see your grains.</p>
    {:else if model.status !== 'ready'}
      <p class="empty">{model.status === 'waiting' ? 'Waiting for the main shell… Your login will be checked when it returns.' : model.status === 'reconnecting' ? 'Connection lost. Reconnecting…' : 'Loading your grains…'}</p>
      <button class="secondary" onclick={() => notifications.reconnect()}>Reconnect</button>
    {:else if model.fixture}
      <p class="empty">Connect to an installed Sandstorm server to see real grains.</p>
    {:else}
      <p>Open a grain here using your Sandstorm identity. Sharing and Powerbox remain in the main shell.</p>
      <label for="grain-search">Filter shown grains</label>
      <input id="grain-search" type="search" bind:value={search} placeholder="Search by title or app" />
      <div class="grain-controls">
        <div><label for="grain-ownership">Show</label><select id="grain-ownership" bind:value={ownership}><option value="all">All shown grains</option><option value="owned">Owned by you</option><option value="shared">Shared with you</option></select></div>
        <div><label for="grain-sort">Sort by</label><select id="grain-sort" bind:value={sort}><option value="recent">Recent use</option><option value="title">Title</option></select></div>
        <button class="secondary" onclick={() => notifications.reconnect()}>Refresh</button>
      </div>
      <p class="result-count">Showing {visibleGrains.length} of {model.grains.length} loaded grains.</p>
      {#if visibleGrains.length === 0}<p class="empty">{model.grains.length ? 'No matching grains.' : 'You have no grains to show.'}</p>{/if}
      <ul>
        {#each visibleGrains as grain (grain.key)}
          <li class="grain-item"><div>
            <h3><a href={grain.href}>{grain.title}</a></h3>
            <p><span>{grain.appTitle || 'Unknown app'}</span> · <span>{grain.owned ? 'Owned by you' : 'Shared with you'}</span></p>
            {#if grain.lastUsed}<time datetime={grain.lastUsed}>Last used {new Date(grain.lastUsed).toLocaleString()}</time>{/if}
          </div><button disabled={model.openingGrain} onclick={() => notifications.openGrain(grain)} aria-label={`Open ${grain.title} here`}>Open here</button></li>
        {/each}
      </ul>
      {#if model.grainsLimited}<p>This is a limited preview of your grains. <a href="/main-shell">View all grains in the main shell.</a></p>{/if}
    {/if}
    {#if model.openingGrain}<p role="status">Opening grain…</p>{/if}
    {#if model.error}<p class="error" role="alert">{model.error}</p>{/if}
  </section>
  {:else}
  <section aria-labelledby="notifications-title">
    <div class="heading"><h2 id="notifications-title">Notifications</h2><span class="status" role="status">{model.status}</span></div>
    <div class="actions">
      {#if model.status === 'signed-out'}
        <a href="/auth/start">Sign in with Sandstorm</a>
      {:else}
        {#if model.fixture}
          <button onclick={() => notifications.addFixture()} disabled={model.status !== 'ready' || model.pending}>Add test notification</button>
        {:else}
          <button onclick={() => notifications.markRead()} disabled={model.status !== 'ready' || model.pending}>Mark all as read</button>
        {/if}
        <button class="secondary" onclick={() => notifications.reconnect()}>Reconnect</button>
      {/if}
    </div>
    {#if model.error}<p class="error" role="alert">{model.error}</p>{/if}
    {#if model.status === 'signed-out'}
      <p class="empty">Connect your account to load notifications.</p>
    {:else if model.status !== 'ready'}
      <p class="empty">{model.status === 'waiting' ? 'Waiting for the main shell… Your login will be checked when it returns.' : 'Connecting to the Rust shell…'}</p>
    {:else if model.entries.length === 0}
      <p class="empty">You have no notifications.</p>
    {:else}
      <ul>
        {#each model.entries as entry (entry.id)}
          <li class="notification-item">
            <div>
              <h3 class="notification-title">{entry.title} {#if entry.unread}<small>Unread</small>{/if}</h3>
              {#if entry.senderName}<p class="sender">From {entry.senderName}</p>{/if}
              <p>{entry.body}</p>
              {#if entry.ongoing}<p>Cancelling stops this ongoing activity.</p>{/if}
              {#if entry.timestamp}<time datetime={entry.timestamp}>{new Date(entry.timestamp).toLocaleString()}</time>{/if}
              {#if entry.href}<p><a href={entry.href}>Open in main shell ↗</a></p>{/if}
            </div>
            <button class="secondary" disabled={model.pending} aria-label={`${entry.ongoing ? 'Cancel activity for' : 'Dismiss'} ${entry.title}`}
              onclick={() => { if (!entry.ongoing || confirm(`Stop the ongoing activity for ${entry.title}?`)) notifications.dismiss(entry.id); }}>{entry.ongoing ? 'Cancel activity' : 'Dismiss'}</button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if model.total > model.entries.length && model.status === 'ready'}<p>Showing {model.entries.length} of {model.total} notifications. <a href="/main-shell">View all in the main shell.</a></p>{/if}
    <footer>Rust / Axum · Svelte / TypeScript · Cap’n Proto RPC<br />Snapshot revision {model.revision}</footer>
  </section>
  {/if}
</main>

<style>
  :global(body) { margin: 0; background: #f6f6f6; color: #333; font: 15px/1.5 system-ui, sans-serif; }
  :global(*) { box-sizing: border-box; }
  header { background: #542770; color: white; padding: 17px 28px; display: flex; gap: 24px; align-items: center; }
  header strong { font-size: 23px; } header span { opacity: .85; }
  main { max-width: 1100px; margin: 40px auto; padding: 0 24px; display: grid; grid-template-columns: 240px 1fr; gap: 36px; }
  h1 { font-size: 24px; margin-top: 0; } h2 { font-size: 20px; } h3 { font-size: 16px; margin: 0; }
  aside p { color: #666; } aside h2 { font-size: 15px; } a { color: #633388; }
  nav { display: flex; gap: 8px; margin-top: 20px; flex-wrap: wrap; }
  nav [aria-current="page"] { background: #eee4f4; border-color: #633388; }
  .grain-controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin: 12px 0; }
  select { display: block; padding: 8px; font: inherit; max-width: 100%; }
  .result-count { color: #666; font-size: 13px; }
  input { display: block; width: 100%; padding: 8px; margin: 8px 0 20px; font: inherit; border: 1px solid #aaa; border-radius: 3px; }
  .grain-item a { overflow-wrap: anywhere; }
  hr { border: 0; border-top: 1px solid #ddd; margin: 24px 0; }
  section { min-width: 0; background: white; border: 1px solid #ddd; border-radius: 4px; padding: 24px; }
  .heading { display: flex; justify-content: space-between; gap: 12px; align-items: center; } .heading h2 { margin: 0; }
  .status { font-size: 13px; color: #666; } .actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 22px 0; }
  button { background: #633388; color: white; border: 1px solid #633388; border-radius: 3px; padding: 8px 12px; font: inherit; cursor: pointer; }
  button.secondary { color: #542770; background: white; border-color: #ccc; } button:disabled { opacity: .5; cursor: default; }
  button:focus-visible, a:focus-visible { outline: 3px solid #b986dd; outline-offset: 3px; }
  ul { margin: 0; padding: 0; list-style: none; } li { display: flex; justify-content: space-between; align-items: start; gap: 20px; border-top: 1px solid #eee; padding: 20px 0; }
  li p { margin: 6px 0 0; color: #666; } .empty { padding: 28px 0; color: #666; } .error { background: #fff1ec; color: #8c2714; padding: 12px; }
  footer { border-top: 1px solid #eee; padding-top: 18px; color: #777; font-size: 12px; }
  @media (max-width: 700px) { main { grid-template-columns: 1fr; margin-top: 24px; gap: 20px; } header { flex-wrap: wrap; gap: 6px 20px; } li { flex-wrap: wrap; } }
</style>

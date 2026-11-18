<script lang="ts">
  import { onMount } from 'svelte';
  import { NotificationsService, type NotificationState } from './lib/notifications';

  let state: NotificationState = $state({ status: 'connecting', entries: [], revision: 0, error: '', pending: false, fixture: true, account: null, total: 0 });
  const notifications = new NotificationsService((next) => { state = next; });
  onMount(() => { notifications.start(); return () => notifications.stop(); });
</script>

<svelte:head><meta name="description" content="Experimental Sandstorm shell running on Rust and Svelte." /></svelte:head>

<header><strong>Sandstorm</strong><span>Rust shell · experimental</span></header>
<main>
  <aside aria-label="About this shell">
    <h1>Shell preview</h1>
    <p>A small first step toward the new architecture.</p>
    <a href="/main-shell">Open the main shell ↗</a>
    <hr />
    {#if state.fixture}
      <h2>Fixture mode</h2>
      <p>These notifications are test data, private to this connection. Reconnecting resets them.</p>
    {:else if state.account}
      <h2>Connected as {state.account}</h2>
      <p>Notifications and dismissals are shared with the main shell. Changes appear within a few seconds.</p>
      <p><a href="/auth/start">Switch account</a></p>
      <button class="secondary" onclick={() => notifications.logout()}>Disconnect</button>
    {:else}
      <h2>Your Sandstorm account</h2>
      <p>Sign in through the main shell to see your real notifications.</p>
    {/if}
    <p>Apps and grains still open in the main shell.</p>
  </aside>
  <section aria-labelledby="notifications-title">
    <div class="heading"><h2 id="notifications-title">Notifications</h2><span class="status" role="status">{state.status}</span></div>
    <div class="actions">
      {#if state.status === 'signed-out'}
        <a href="/auth/start">Sign in with Sandstorm</a>
      {:else}
        {#if state.fixture}
          <button onclick={() => notifications.addFixture()} disabled={state.status !== 'ready' || state.pending}>Add test notification</button>
        {:else}
          <button onclick={() => notifications.markRead()} disabled={state.status !== 'ready' || state.pending}>Mark all as read</button>
        {/if}
        <button class="secondary" onclick={() => notifications.reconnect()}>Reconnect</button>
      {/if}
    </div>
    {#if state.error}<p class="error" role="alert">{state.error}</p>{/if}
    {#if state.status === 'signed-out'}
      <p class="empty">Connect your account to load notifications.</p>
    {:else if state.status !== 'ready'}
      <p class="empty">Connecting to the Rust shell…</p>
    {:else if state.entries.length === 0}
      <p class="empty">You have no notifications.</p>
    {:else}
      <ul>
        {#each state.entries as entry (entry.id)}
          <li class="notification-item">
            <div>
              <h3 class="notification-title">{entry.title} {#if entry.unread}<small>Unread</small>{/if}</h3><p>{entry.body}</p>
              {#if entry.timestamp}<time datetime={entry.timestamp}>{new Date(entry.timestamp).toLocaleString()}</time>{/if}
              {#if entry.href}<p><a href={entry.href}>Open in main shell ↗</a></p>{/if}
            </div>
            <button class="secondary" disabled={state.pending} aria-label={`${entry.ongoing ? 'Cancel activity for' : 'Dismiss'} ${entry.title}`}
              onclick={() => { if (!entry.ongoing || confirm(`Stop the ongoing activity for ${entry.title}?`)) notifications.dismiss(entry.id); }}>{entry.ongoing ? 'Cancel activity' : 'Dismiss'}</button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if state.total > state.entries.length && state.status === 'ready'}<p>Showing {state.entries.length} of {state.total} notifications. <a href="/main-shell">View all in the main shell.</a></p>{/if}
    <footer>Rust / Axum · Svelte / TypeScript · Cap’n Proto RPC<br />Snapshot revision {state.revision}</footer>
  </section>
</main>

<style>
  :global(body) { margin: 0; background: #f6f6f6; color: #333; font: 15px/1.5 system-ui, sans-serif; }
  :global(*) { box-sizing: border-box; }
  header { background: #542770; color: white; padding: 17px 28px; display: flex; gap: 24px; align-items: center; }
  header strong { font-size: 23px; } header span { opacity: .85; }
  main { max-width: 1100px; margin: 40px auto; padding: 0 24px; display: grid; grid-template-columns: 240px 1fr; gap: 36px; }
  h1 { font-size: 24px; margin-top: 0; } h2 { font-size: 20px; } h3 { font-size: 16px; margin: 0; }
  aside p { color: #666; } aside h2 { font-size: 15px; } a { color: #633388; }
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

<script lang="ts">
  import type { ShellState, ShellService } from './lib/shell';
  import { rememberRoute } from './lib/router';
  let { model, service }: { model: ShellState; service: ShellService } = $props();
</script>
  <section aria-labelledby="notifications-title">
    <div class="heading"><h2 id="notifications-title">Notifications</h2><span class="status" role="status">{model.status}</span></div>
    <div class="actions">
      {#if model.status === 'signed-out'}
        <a href="/auth/start" onclick={rememberRoute}>Sign in with Sandstorm</a>
      {:else}
        {#if model.fixture}
          <button onclick={() => service.addFixture()} disabled={model.status !== 'ready' || model.pending}>Add test notification</button>
        {:else}
          <button onclick={() => service.markRead()} disabled={model.status !== 'ready' || model.pending}>Mark all as read</button>
        {/if}
        <button class="secondary" onclick={() => service.reconnect()}>Reconnect</button>
      {/if}
    </div>
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
              onclick={() => { if (!entry.ongoing || confirm(`Stop the ongoing activity for ${entry.title}?`)) service.dismiss(entry.id); }}>{entry.ongoing ? 'Cancel activity' : 'Dismiss'}</button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if model.total > model.entries.length && model.status === 'ready'}<p>Showing {model.entries.length} of {model.total} notifications. <a href="/main-shell">View all in the main shell.</a></p>{/if}
    <footer>Rust / Axum · Svelte / TypeScript · Cap’n Proto RPC<br />Snapshot revision {model.revision}</footer>
  </section>

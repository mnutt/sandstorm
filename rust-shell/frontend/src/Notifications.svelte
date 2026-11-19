<script lang="ts">
  import Button from './components/ui/Button.svelte';
  import Panel from './components/ui/Panel.svelte';
  import type { ShellState, ShellService } from './lib/shell';
  import { rememberRoute } from './lib/router';
  let { model, service }: { model: ShellState; service: ShellService } = $props();
</script>
  <Panel aria-labelledby="notifications-title">
    <div class="heading"><h2 id="notifications-title">Notifications</h2><span class="status" role="status">{model.status}</span></div>
    <div class="actions">
      {#if model.status === 'signed-out'}
        <a href="/auth/start" onclick={rememberRoute}>Sign in with Sandstorm</a>
      {:else}
        {#if model.fixture}
          <Button onclick={() => service.addFixture()} disabled={model.status !== 'ready' || model.pending}>Add test notification</Button>
        {:else}
          <Button onclick={() => service.markRead()} disabled={model.status !== 'ready' || model.pending}>Mark all as read</Button>
        {/if}
        <Button variant="secondary" onclick={() => service.reconnect()}>Reconnect</Button>
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
            <Button variant="secondary" disabled={model.pending} aria-label={`${entry.ongoing ? 'Cancel activity for' : 'Dismiss'} ${entry.title}`}
              onclick={() => { if (!entry.ongoing || confirm(`Stop the ongoing activity for ${entry.title}?`)) service.dismiss(entry.id); }}>{entry.ongoing ? 'Cancel activity' : 'Dismiss'}</Button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if model.total > model.entries.length && model.status === 'ready'}<p>Showing {model.entries.length} of {model.total} notifications. <a href="/main-shell">View all in the main shell.</a></p>{/if}
    <footer>Rust / Axum · Svelte / TypeScript · Cap’n Proto RPC<br />Snapshot revision {model.revision}</footer>
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
    justify-content: space-between;
    align-items: center;
    gap: var(--ss-space-3);
  }

  .status, time, footer {
    color: var(--ss-muted);
    font-size: var(--ss-text-small);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--ss-space-3);
    margin: var(--ss-space-5) 0;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: start;
    gap: var(--ss-space-4);
    border-top: 1px solid var(--ss-border);
    padding: var(--ss-space-5) 0;
  }

  li > div {
    flex: 1 1 14rem;
    min-width: 0;
  }

  li p {
    margin: var(--ss-space-2) 0;
    color: var(--ss-muted);
  }

  small {
    font-size: .75rem;
    color: var(--ss-brand);
    background: var(--ss-brand-subtle);
    padding: var(--ss-space-1) var(--ss-space-2);
    border-radius: var(--ss-radius-control);
  }

  footer {
    border-top: 1px solid var(--ss-border);
    padding-top: var(--ss-space-4);
  }
</style>

<script lang="ts">
  import Pagination from './components/ui/Pagination.svelte';
  import Avatar from './components/ui/Avatar.svelte';
  import NotificationDialog from './NotificationDialog.svelte';
  import Button from './components/ui/Button.svelte';
  import Panel from './components/ui/Panel.svelte';
  import type { ShellState, ShellService } from './lib/shell';
  import { rememberRoute, notificationDestination } from './lib/router';
  import { isPlainNavigation } from './lib/navigation';
  let { model, service, navigate }: { model: ShellState; service: ShellService; navigate:(path:string)=>void } = $props();
  let selected = $state<{key:string; title:string; account:string|null; trigger:HTMLElement}>();
  $effect(() => { if (selected && (model.accountKey !== selected.account || model.status !== 'ready')) selected = undefined; });
</script>
  <Panel aria-labelledby="notifications-title">
    <div class="heading"><h2 id="notifications-title">Notifications</h2><span class="status" role="status">{model.status}</span>
    <div class="actions">
      {#if model.status === 'signed-out'}
        <a href="/login" onclick={rememberRoute}>Sign in with Sandstorm</a>
      {:else}
        {#if model.fixture}
          <Button onclick={() => service.addFixture()} disabled={model.status !== 'ready' || model.pending}>Add test notification</Button>
        {:else}
          <Button onclick={() => service.markRead()} disabled={model.status !== 'ready' || model.pending}>Mark all as read</Button>
        {/if}

      {/if}
    </div></div>
    {#if model.status === 'signed-out'}
      <p class="empty">Connect your account to load notifications.</p>
    {:else if model.status !== 'ready'}
      <p class="empty">{model.status === 'waiting' ? 'Waiting for the main shell… Your login will be checked when it returns.' : 'Connecting to the Rust shell…'}</p>
    {:else if model.entries.length === 0}
      <p class="empty">You have no notifications.</p>
    {:else}
      <ul>
        {#each model.entries as entry (entry.id)}
          {@const destination = notificationDestination(entry.nativePath)}
          <li class="notification-item">
            <div class="copy">
              <h3 class="notification-title">
                {#if destination}<a href={destination.path} aria-label={destination.label} title={entry.title} onclick={event => { void service.readNotification(entry.id); if (isPlainNavigation(event)) { event.preventDefault(); navigate(destination.path); } }} onauxclick={event => { if (event.button === 1) void service.readNotification(entry.id); }}>{entry.title}</a>
                {:else if entry.nativeAction}<button class="title-action" title={entry.title} onclick={event => { void service.readNotification(entry.id); selected = {key:entry.id,title:entry.title,account:model.accountKey,trigger:event.currentTarget}; }}>{entry.title}</button>
                {:else if entry.href}<a href={entry.href} aria-label="Open in main shell ↗" title={entry.title} onclick={async event => { const plain = isPlainNavigation(event); if (plain) event.preventDefault(); await service.readNotification(entry.id); if (plain) window.location.assign(entry.href); }} onauxclick={event => { if (event.button === 1) void service.readNotification(entry.id); }}>{entry.title} ↗</a>
                {:else}<span title={entry.title}>{entry.title}</span>{/if}
                {#if entry.unread}<small aria-label="Unread" title="Unread">●</small>{/if}
              </h3>
              <p title={`${entry.senderName ? 'From ' + entry.senderName + ': ' : ''}${entry.body}`}>{#if entry.senderName}<span><Avatar name={entry.senderName} src={entry.senderPictureUrl} size={16} /> <span>From {entry.senderName}</span></span> · {/if}{entry.body}</p>
            </div>
            <time datetime={entry.timestamp || undefined} title={entry.timestamp ? new Date(entry.timestamp).toLocaleString() : ''}>{#if entry.timestamp}{new Date(entry.timestamp).toLocaleDateString()}<br />{new Date(entry.timestamp).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}{/if}</time>
            <Button variant="secondary" disabled={model.pending} aria-label={`${entry.ongoing ? 'Cancel activity for' : 'Dismiss'} ${entry.title}`}
              onclick={() => { if (!entry.ongoing || confirm(`Stop the ongoing activity for ${entry.title}?`)) service.dismiss(entry.id); }}>{entry.ongoing ? 'Cancel activity' : 'Dismiss'}</Button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if model.status === 'ready'}<Pagination page={model.notificationPage} more={(model.notificationPage + 1) * 100 < model.total} busy={model.paging} label="Notifications" change={page => service.selectPage('notifications',page)} />{/if}
  </Panel>
{#if selected}
  {#key selected.key}<NotificationDialog notificationKey={selected.key} title={selected.title} {service} returnFocus={selected.trigger} onclose={() => selected = undefined} />{/key}
{/if}
<style>
  h2 { margin: 0; font-size: var(--ss-text-title); }
  .heading { display:flex; align-items:center; flex-wrap:wrap; gap:1rem; margin-bottom:1rem; }
  .actions { margin-left:auto; display:flex; gap:.5rem; }
  .status { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
  ul { display:grid; grid-template-columns:minmax(0,1fr) max-content max-content; column-gap:1rem; list-style:none; margin:0; padding:0; }
  li { display:grid; grid-column:1 / -1; grid-template-columns:subgrid; align-items:center; column-gap:inherit; border-top:1px solid var(--ss-border); padding:.65rem 0; }
  .copy { min-width:0; }
  h3 { display:flex; align-items:center; gap:.4rem; margin:0; font-size:var(--ss-text-small); }
  h3 a, h3 span, .title-action { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  a, .title-action { color:var(--ss-brand); }
  .title-action { border:0; padding:0; background:none; font:inherit; text-align:left; cursor:pointer; }
  a:focus-visible, .title-action:focus-visible { outline:2px solid var(--ss-focus); outline-offset:2px; }
  small { color:var(--ss-brand); font-size:.5rem; flex:none; }
  .copy p { margin:.2rem 0 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ss-muted); font-size:var(--ss-text-small); }
  time { font-size:.75rem; color:var(--ss-muted); text-align:right; }
  @media(max-width:480px) { ul { column-gap:.4rem; } time { font-size:.65rem; } }
</style>

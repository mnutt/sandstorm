<script lang="ts">
  import Avatar from './components/ui/Avatar.svelte';
  import { onMount } from 'svelte';
  import Modal from './components/ui/Modal.svelte';
  import Button from './components/ui/Button.svelte';
  import LoadingStatus from './components/ui/LoadingStatus.svelte';
  import type { ShellService } from './lib/shell';
  import type { NotificationDetails } from './lib/notification-details';
  let { notificationKey, title, service, returnFocus, onclose }: { notificationKey:string; title:string; service:ShellService; returnFocus:HTMLElement; onclose:()=>void } = $props();
  let open = $state(true);
  let details = $state<NotificationDetails>();
  let error = $state('');
  let busy = $state(false);
  let saved = $state(false);
  let alive = true;
  onMount(() => {
    service.notificationDetails(notificationKey).then(value => { if (alive) details = value; }).catch(reason => { if (alive) error = String(reason); });
    return () => { alive = false; };
  });
  $effect(() => { if (!open) onclose(); });
  async function save(enabled:boolean) {
    busy = true; error = '';
    try {
      const result = await service.notificationDetails(notificationKey, 'setStats', enabled);
      if (alive) { details = result; saved = true; }
    } catch (reason) { if (alive) error = `Could not confirm the change. It has not been retried. ${String(reason)}`; }
    finally { if (alive) busy = false; }
  }
</script>
<Modal bind:open {title} description="Notification details" {returnFocus} {busy}>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if !details && !error}<LoadingStatus label="Loading notification…" />{/if}
  {#if details?.kind === 'stats'}
    <p>Choose whether this server shares usage statistics with Sandstorm. Reports include aggregate user and grain activity, app identifiers, plan counts, and server age. They do not include grain document contents.</p>
    <p>Reporting: <strong>{details.enabled === null ? 'Not yet chosen' : details.enabled ? 'Enabled' : 'Disabled'}</strong></p>
    {#if details.sample}<details><summary>Preview collected statistics</summary><pre>{details.sample}</pre></details>
    {:else}<p>{details.sampleLimited ? 'The latest report is too large to preview.' : 'No statistics have been collected yet.'}</p>{/if}
    {#if saved}<p role="status">Reporting preference saved.</p>
    {:else}<div class="actions"><Button disabled={busy} onclick={() => save(true)}>Enable reporting</Button><Button variant="secondary" disabled={busy} onclick={() => save(false)}>Disable reporting</Button></div>{/if}
  {:else if details?.kind === 'referrals'}
    <p>{details.enabled ? 'Share a grain with someone new to Sandstorm. A referral completes when they share a grain and someone else opens it.' : 'The referral program is not enabled on this server.'}</p>
    <h3>Completed referrals</h3>
    {#if details.completed.length}<ul>{#each details.completed as person}<li><Avatar name={person.name} src={person.pictureUrl} /><span>{person.name}</span></li>{/each}</ul>{:else}<p>No completed referrals.</p>{/if}
    <h3>Pending referrals</h3>
    {#if details.pending.length}<ul>{#each details.pending as person}<li><Avatar name={person.name} src={person.pictureUrl} /><span>{person.name}</span></li>{/each}</ul>{:else}<p>No pending referrals.</p>{/if}
    {#if details.limited}<p>Showing up to 100 referrals in each list.</p>{/if}
  {:else if details?.kind === 'identity'}
    <p>Sandstorm updated how login credentials link to accounts. Your account can have multiple sign-in credentials while keeping a consistent identity in your apps.</p>
    <p>No action is required for this notice. You can manage your profile and sign-in credentials from Account in the user menu.</p>
  {/if}
  <div class="actions"><Button variant="secondary" disabled={busy} onclick={() => open = false}>Close</Button></div>
</Modal>
<style>
  li { display:flex; align-items:center; gap:.5rem; margin-block:.5rem; }
  ul { list-style:none; padding:0; }
  p, li { overflow-wrap: anywhere; }
  h3 { font-size: 1rem; margin-bottom: .5rem; }
  pre { overflow: auto; max-height: 16rem; font-size: .75rem; }
  summary { cursor: pointer; }
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .5rem; margin-top: 1rem; }
</style>

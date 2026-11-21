<script lang="ts">
  import Modal from './ui/Modal.svelte';
  import Button from './ui/Button.svelte';
  import ShellIcon from './ui/ShellIcon.svelte';
  import LoadingStatus from './ui/LoadingStatus.svelte';
  import { applicationErrorMessage } from '../lib/results';

  let { title, warning, prepare }: {title: string; warning: string; prepare: () => Promise<string>} = $props();
  let open = $state(false);
  let preparing = $state(false);
  let url = $state('');
  let error = $state('');

  async function createBackup() {
    if (preparing) return;
    preparing = true;
    error = '';
    try { url = await prepare(); }
    catch (cause) { error = applicationErrorMessage(cause, 'Could not prepare the backup. Please try again.'); }
    finally { preparing = false; }
  }
</script>

<Modal bind:open title="Download backup" description={title} triggerLabel="Download backup" triggerVariant="chrome"
  onTrigger={() => { if (!warning && !url && !error) void createBackup(); }}>
  {#snippet triggerContent()}<ShellIcon name="download" toolbar />{/snippet}
  {#if warning}<p>{warning}</p>{/if}
  {#if preparing}<LoadingStatus label="Preparing backup…" />
  {:else if url}
    <a href={url} target="_blank" rel="noreferrer" download onclick={() => { url = ''; open = false; }}>Download ZIP</a>
  {:else}
    {#if error}<p role="alert">{error}</p>{/if}
    <Button onclick={createBackup}>{error ? 'Try again' : 'Prepare backup'}</Button>
  {/if}
  <Button variant="secondary" onclick={() => { open = false; }}>Close</Button>
</Modal>

<style>
  a { display: inline-block; margin-right: var(--ss-space-3); color: var(--ss-brand); font-weight: 600; }
  p { color: var(--ss-muted); }
</style>

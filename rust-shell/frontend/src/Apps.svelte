<script lang="ts">
  import Button from './components/ui/Button.svelte';
  import TextInput from './components/ui/TextInput.svelte';
  import NativeSelect from './components/ui/NativeSelect.svelte';
  import Panel from './components/ui/Panel.svelte';
  import { onDestroy } from 'svelte';
  import type { CreationState } from './lib/apps';
  import { rememberRoute } from './lib/router';
  import type { ShellService, ShellState, AppAction } from './lib/shell';
  let { service, status, fixture, creation, created, checkGrains }: { service: ShellService; status: ShellState['status']; fixture: boolean; creation: CreationState;
    created: (id: string) => void; checkGrains: () => void } = $props();
  let actions: AppAction[] = $state([]);
  let limited = $state(false);
  let loading = $state(false);
  const creating = $derived(creation.status === 'pending');
  let error = $state('');
  const uncertain = $derived(creation.status === 'unknown');
  let selected = $state('');
  let title = $state('New grain');
  let epoch = 0;
  let alive = true;
  async function load() {
    const current = ++epoch;
    loading = true;
    try {
      const result = await service.listApps();
      if (current !== epoch) return;
      actions = result.actions; limited = result.limited;
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
<Panel aria-labelledby="apps-title">
  <h2 id="apps-title">Apps</h2>
  <p>Create a grain using an app installed for your account.</p>
  {#if status === 'signed-out'}<p><a href="/auth/start" onclick={rememberRoute}>Sign in with Sandstorm</a> to see your installed apps.</p>
  {:else if status !== 'ready'}<p>Connecting to Sandstorm…</p>
  {:else if fixture}<p>App creation requires an installed Sandstorm server.</p>
  {:else}
    <Button disabled={creating || loading} onclick={() => { if (!uncertain) error = ''; void load(); }}>Refresh apps</Button>
    {#if loading}<p role="status">Loading apps…</p>
    {:else if !actions.length}<p>No installed app actions to show. Install apps in the main shell.</p>
    {:else}
      <form onsubmit={create}>
        <label for="app-action">Installed app action</label>
        <NativeSelect id="app-action" bind:value={selected} disabled={creating || uncertain} required>
          <option value="">Choose an app</option>
          {#each actions as action (action.key)}<option value={action.key}>{action.appTitle} — {action.title}</option>{/each}
        </NativeSelect>
        <label for="new-grain-title">Grain title</label>
        <TextInput id="new-grain-title" bind:value={title} maxlength={160} required disabled={creating || uncertain} />
        <Button type="submit" disabled={creation.status !== 'idle' || !selected || !title.trim()}>{creating ? 'Creating grain…' : 'Create grain'}</Button>
      </form>
    {/if}
    {#if limited}<p>Showing the first 100 installed actions. Use the main shell for the full list.</p>{/if}
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if creation.status === 'created'}<p>Grain created.</p><Button onclick={() => created(creation.grainId)}>Open created grain</Button><Button onclick={() => service.acknowledgeCreation()}>Create another grain</Button>{/if}
  {#if uncertain}<p role="alert">{creation.status === 'unknown' ? creation.error : ''}</p><p>The request was not retried. Check your grains before creating another.</p><Button onclick={checkGrains}>Check grains</Button><Button onclick={() => service.acknowledgeCreation()}>I checked my grains</Button>{/if}
</Panel>
<style>
  h2 {
    margin: 0 0 var(--ss-space-4);
    font-size: var(--ss-text-title);
    line-height: 1.3;
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

  [role=alert] {
    color: var(--ss-danger);
  }

  form {
    display: grid;
    gap: var(--ss-space-3);
    max-width: 32rem;
    margin-top: var(--ss-space-5);
  }

  label {
    font-weight: 600;
    font-size: var(--ss-text-small);
  }
</style>

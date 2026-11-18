<script lang="ts">
  import { onDestroy } from 'svelte';
  import { rememberRoute } from './lib/router';
  import type { ShellService, ShellState, AppAction } from './lib/shell';
  let { service, status, fixture, created, checkGrains }: { service: ShellService; status: ShellState['status']; fixture: boolean;
    created: (id: string) => void; checkGrains: () => void } = $props();
  let actions: AppAction[] = $state([]);
  let limited = $state(false);
  let loading = $state(false);
  let creating = $state(false);
  let error = $state('');
  let uncertain = $state(false);
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
    if (creating || uncertain || !selected || !title.trim()) return;
    creating = true; error = '';
    try {
      const id = await service.createGrain(selected, title);
      if (alive) created(id);
    } catch (failure) {
      if (alive) { uncertain = true; error = `Could not confirm grain creation. ${String(failure)}`; }
    } finally { if (alive) creating = false; }
  }
</script>
<section aria-labelledby="apps-title">
  <h2 id="apps-title">Apps</h2>
  <p>Create a grain using an app installed for your account.</p>
  {#if status === 'signed-out'}<p><a href="/auth/start" onclick={rememberRoute}>Sign in with Sandstorm</a> to see your installed apps.</p>
  {:else if status !== 'ready'}<p>Connecting to Sandstorm…</p>
  {:else if fixture}<p>App creation requires an installed Sandstorm server.</p>
  {:else}
    <button disabled={creating || loading} onclick={() => { if (!uncertain) error = ''; void load(); }}>Refresh apps</button>
    {#if loading}<p role="status">Loading apps…</p>
    {:else if !actions.length}<p>No installed app actions to show. Install apps in the main shell.</p>
    {:else}
      <form onsubmit={create}>
        <label for="app-action">Installed app action</label>
        <select id="app-action" bind:value={selected} disabled={creating || uncertain} required>
          <option value="">Choose an app</option>
          {#each actions as action (action.key)}<option value={action.key}>{action.appTitle} — {action.title}</option>{/each}
        </select>
        <label for="new-grain-title">Grain title</label>
        <input id="new-grain-title" bind:value={title} maxlength="160" required disabled={creating || uncertain} />
        <button disabled={creating || uncertain || !selected || !title.trim()}>{creating ? 'Creating grain…' : 'Create grain'}</button>
      </form>
    {/if}
    {#if limited}<p>Showing the first 100 installed actions. Use the main shell for the full list.</p>{/if}
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if uncertain}<p>The request was not retried. Check your grains before creating another.</p><button onclick={checkGrains}>Check grains</button>{/if}
</section>
<style>
  section { background:white; padding:24px; border:1px solid #ddd; }
  form { display:grid; gap:12px; max-width:520px; margin-top:20px; }
  button, input, select { font:inherit; padding:8px; }
  [role=alert] { color:#922; }
</style>

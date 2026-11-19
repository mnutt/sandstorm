<script lang="ts">
  import ProfilePicture from './ProfilePicture.svelte';
  import Button from './components/ui/Button.svelte';
  import TextInput from './components/ui/TextInput.svelte';
  import NativeSelect from './components/ui/NativeSelect.svelte';
  import Panel from './components/ui/Panel.svelte';
  import { rememberRoute } from './lib/router';
  import type { ShellService, ShellState } from './lib/shell';
  let { model, service }: { model: ShellState; service: ShellService } = $props();
  let name = $state('');
  let handle = $state('');
  let pronoun = $state('neutral');
  let dirty = $state(false);
  const profile = $derived(model.profile);
  const status = $derived(model.status);
  const fixture = $derived(model.fixture);
  $effect(() => {
    if (status === 'ready' && !fixture) void service.loadProfile();
  });
  $effect(() => {
    if (!profile.value) {
      name = ''; handle = ''; pronoun = 'neutral'; dirty = false;
    } else if (!dirty) {
      name = profile.value.name;
      handle = profile.value.handle;
      pronoun = profile.value.pronoun;
    }
  });
  async function save(event: SubmitEvent) {
    event.preventDefault();
    await service.saveProfile({ name, handle, pronoun });
    // Failed saves keep the draft visible; no automatic retries.
    if (!profile.error) dirty = false;
  }
</script>

<Panel aria-labelledby="account-title">
  <h2 id="account-title">Account</h2>
  {#if model.status === 'signed-out'}
    <p><a href="/auth/start" onclick={rememberRoute}>Sign in with Sandstorm</a> to edit your profile.</p>
  {:else if model.fixture}
    <p>Profile settings require an installed Sandstorm account.</p>
  {:else if model.status !== 'ready'}
    <p role="status">Connecting to Sandstorm…</p>
  {:else}
    <p>Your profile is shared with the main shell and apps.</p>
    {#if profile.stale}<div class="profile-update" role="status"><span>The profile was updated by someone else.</span><Button variant="secondary" disabled={profile.loading || profile.saving} onclick={() => { dirty = false; void service.loadProfile(); }}>Refresh</Button></div>{/if}
    {#if profile.loading}<p role="status">Loading profile…</p>{/if}
    {#if profile.value}
      {#key model.accountKey}
        <ProfilePicture {profile} upload={image => service.uploadProfilePicture(image)} />
      {/key}
      <form onsubmit={save} oninput={() => { dirty = true; }}>
        <label for="profile-name">Display name</label>
        <TextInput id="profile-name" bind:value={name} maxlength={160} required disabled={profile.saving} />
        <label for="profile-handle">Handle</label>
        <TextInput id="profile-handle" bind:value={handle} pattern="[a-z_][a-z0-9_]*" maxlength={64} required disabled={profile.saving} aria-describedby="handle-help" />
        <p id="handle-help">Start with a lowercase letter or underscore. Use lowercase letters, numbers, and underscores.</p>
        <label for="profile-pronoun">Pronouns</label>
        <NativeSelect id="profile-pronoun" bind:value={pronoun} disabled={profile.saving}>
          <option value="male">He / him</option><option value="female">She / her</option>
          <option value="neutral">They / them</option><option value="robot">It / its</option>
        </NativeSelect>
        <Button type="submit" disabled={profile.saving || !dirty || !name.trim()}>{profile.saving ? 'Saving profile…' : 'Save profile'}</Button>
      </form>
      <p><a href={profile.value.mainHref}>Manage login methods and email in the main shell ↗</a></p>
    {/if}
  {/if}
  {#if profile.error}<p class="error" role="alert">{profile.error}</p>{/if}
  {#if profile.notice}<p role="status">{profile.notice}</p>{/if}
</Panel>
<style>
  .profile-update { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.75rem; background:var(--ss-brand-subtle); margin-block:1rem; }
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

  #handle-help {
    color: var(--ss-muted);
    font-size: var(--ss-text-small);
    margin: 0 0 var(--ss-space-3);
  }
</style>

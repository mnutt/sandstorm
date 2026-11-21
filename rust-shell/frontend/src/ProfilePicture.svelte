<script lang="ts">
  import Avatar from './components/ui/Avatar.svelte';
  import { onDestroy } from 'svelte';
  import Button from './components/ui/Button.svelte';
  import { previewProfilePicture } from './lib/profile-picture';
  import type { ProfileState } from './lib/profile';

  let { profile, upload }: { profile: ProfileState; upload: (image: Blob) => Promise<void> } = $props();
  type Selection =
    | { status: 'empty' }
    | { status: 'preparing' }
    | { status: 'ready'; image: Blob; url: string }
    | { status: 'error'; message: string };
  let selection = $state<Selection>({ status: 'empty' });
  let input = $state<HTMLInputElement>();
  let showUploadFeedback = $state(true);
  let generation = 0;
  const error = $derived(selection.status === 'error' ? selection.message : showUploadFeedback ? profile.pictureError : '');

  // Replacing a file, leaving the page, or switching accounts invalidates late preparation results.
  onDestroy(() => { ++generation; });
  function clear() {
    ++generation;
    selection = { status: 'empty' };
    if (input) input.value = '';
  }
  async function choose(file?: File) {
    const current = ++generation;
    showUploadFeedback = false;
    selection = { status: file ? 'preparing' : 'empty' };
    if (!file) return;
    try {
      const preview = await previewProfilePicture(file);
      if (current === generation) selection = { status: 'ready', ...preview };
    } catch (reason) {
      if (current === generation) selection = { status: 'error', message: reason instanceof Error ? reason.message : String(reason) };
    }
  }
  async function save() {
    if (selection.status !== 'ready') return;
    const current = generation;
    showUploadFeedback = true;
    await upload(selection.image);
    if (current === generation && !profile.pictureError) clear();
  }
</script>

<section class="picture" aria-labelledby="picture-title">
  <h3 id="picture-title">Profile picture</h3>
  {#if selection.status === 'ready'}
    <figure><img src={selection.url} alt="New avatar preview" width="96" height="96" /><figcaption>Preview</figcaption></figure>
  {:else if profile.value?.pictureUrl}
    <img src={profile.value.pictureUrl} alt="Current avatar" width="64" height="64" referrerpolicy="no-referrer" />
  {:else}<Avatar name={profile.value?.name} size={64} />
  {/if}
  <div>
    <label for="profile-picture">Choose an image</label>
    <input bind:this={input} id="profile-picture" type="file" accept="image/png,image/jpeg" disabled={profile.saving}
      aria-describedby={error ? 'picture-help picture-error' : 'picture-help'} onchange={event => void choose(event.currentTarget.files?.[0])} />
    <p id="picture-help">PNG or JPEG. We center-crop to 512 × 512 and compress it automatically. Your picture is visible to people you interact with.</p>
    {#if selection.status === 'preparing'}<p role="status">Preparing preview…</p>{/if}
    <div class="actions">
      <Button disabled={selection.status !== 'ready' || profile.saving} onclick={save}>{profile.pictureSaving ? 'Uploading…' : 'Upload picture'}</Button>
      {#if selection.status === 'ready' || selection.status === 'preparing'}
        <Button variant="secondary" disabled={profile.saving} onclick={() => { clear(); showUploadFeedback = false; }}>Cancel</Button>
      {/if}
    </div>
    {#if error}<p id="picture-error" role="alert">{error}</p>{/if}
    {#if showUploadFeedback && profile.pictureNotice}<p role="status">{profile.pictureNotice}</p>{/if}
  </div>
</section>

<style>
  .picture { display: flex; align-items: start; flex-wrap: wrap; gap: 1rem; margin-block: 1rem; }
  h3 { flex-basis: 100%; font-size: var(--ss-text-small); margin: 0; }
  figure { margin: 0; flex: none; }
  figcaption { text-align: center; color: var(--ss-muted); font-size: .75rem; }
  img { object-fit: cover; border-radius: 2px; }
  label { display: block; margin-bottom: .5rem; font-weight: 600; font-size: var(--ss-text-small); }
  input { max-width: 100%; }
  p { overflow-wrap: anywhere; }
  #picture-help { color: var(--ss-muted); font-size: .75rem; }
  [role=alert] { color: var(--ss-danger); }
  .actions { display: flex; gap: .5rem; }
</style>

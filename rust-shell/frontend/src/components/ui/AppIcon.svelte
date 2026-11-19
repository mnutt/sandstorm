<script lang="ts">
  import ShellIcon from './ShellIcon.svelte';
  let { src }: { src: string } = $props();
  let failed = $state(false);
  $effect(() => { src; failed = false; });
</script>
<span class="app-icon">
  {#if src && !failed}<img {src} alt="" width="128" height="128" referrerpolicy="no-referrer" onerror={() => { failed = true; }} />
  {:else}<ShellIcon name="apps" />{/if}
</span>
<style>
  .app-icon { display: grid; place-items: center; width: 128px; max-width: 100%; height: 128px; flex: none; color: var(--ss-brand); }
  img { width: 100%; height: 100%; object-fit: contain; }
  .app-icon > :global(svg) { width: 112px; max-width: 100%; height: 112px; }
</style>

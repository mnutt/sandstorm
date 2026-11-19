<script lang="ts">
  import ShellIcon from './ShellIcon.svelte';
  let { src }: { src: string } = $props();
  let failed = $state(false);
  $effect(() => { src; failed = false; });
</script>
{#if src && !failed}<img {src} alt="" width="24" height="24" referrerpolicy="no-referrer" onerror={() => { failed = true; }} />
{:else}<ShellIcon name="grains" />{/if}
<style>img { flex: none; object-fit: contain; }</style>

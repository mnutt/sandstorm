<script lang="ts">
  let { name }: { name: 'apps' | 'grains' | 'external' | 'sidebar' } = $props();
</script>
<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter">
  {#if name === 'apps'}
    <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />
  {:else if name === 'grains'}
    <path d="M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6" />
  {:else if name === 'external'}
    <path d="M14 3h7v7M21 3l-11 11M10 5H3v16h16v-7" />
  {:else}
    <path d="M3 4h18v16H3zM9 4v16" />
  {/if}
</svg>
<style>
  svg { flex: none; }
</style>

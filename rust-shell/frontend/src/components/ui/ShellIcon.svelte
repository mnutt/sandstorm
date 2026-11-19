<script lang="ts">
  let { name }: { name: 'apps' | 'grains' | 'external' | 'sidebar' | 'pencil' | 'close' | 'share' | 'users' } = $props();
</script>
<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="miter">
  {#if name === 'apps'}
    <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />
  {:else if name === 'grains'}
    <path d="M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6" />
  {:else if name === 'external'}
    <path d="M14 3h7v7M21 3l-11 11M10 5H3v16h16v-7" />
  {:else if name === 'pencil'}
    <path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14z" />
  {:else if name === 'close'}
    <path d="m6 6 12 12M18 6 6 18" />
  {:else if name === 'share'}
    <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m9 10 6-3M9 14l6 3" />
  {:else if name === 'users'}
    <circle cx="9" cy="7" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 13a5 5 0 0 1 3 5v3" />
  {:else}
    <path d="M3 4h18v16H3zM9 4v16" />
  {/if}
</svg>
<style>
  svg { flex: none; }
</style>

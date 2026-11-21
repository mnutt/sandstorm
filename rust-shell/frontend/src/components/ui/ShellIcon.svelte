<script lang="ts">
  let { name, toolbar = false }: { toolbar?: boolean; name: 'trash' | 'apps' | 'grains' | 'external' | 'sidebar' | 'pencil' | 'close' | 'share' | 'users' | 'bell' } = $props();
</script>
<svg aria-hidden="true" width={toolbar ? 18 : 20} height={toolbar ? 18 : 20} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={toolbar ? 1.8 : 1.6} stroke-linecap={toolbar ? 'round' : 'square'} stroke-linejoin={toolbar ? 'round' : 'miter'}>
  {#if name === 'apps'}
    <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />
  {:else if name === 'grains'}
    <path d="M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6" />
  {:else if name === 'trash'}
    <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
  {:else if name === 'external'}
    <path d="M14 3h7v7M21 3l-11 11M10 5H3v16h16v-7" />
  {:else if name === 'pencil'}
    <path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14z" />
  {:else if name === 'close'}
    <path d="m6 6 12 12M18 6 6 18" />
  {:else if name === 'share'}
    <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m9 10 6-3M9 14l6 3" />
  {:else if name === 'bell'}
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
  {:else if name === 'users'}
    <circle cx="9" cy="7" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 13a5 5 0 0 1 3 5v3" />
  {:else}
    <path d="M3 4h18v16H3zM9 4v16" />
  {/if}
</svg>
<style>
  svg { flex: none; }
</style>

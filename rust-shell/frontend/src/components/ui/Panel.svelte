<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  import type { Snippet } from 'svelte';
  let { children, padded = true, ...rest }: HTMLAttributes<HTMLElement> & { children: Snippet; padded?: boolean } = $props();
</script>
<section {...rest} class:flush={!padded}>{@render children()}</section>
<style>
  .flush { padding: 0; }
  section {
    min-width: 0;
    padding: var(--ss-space-4);
    background: var(--ss-surface);
    border: 1px solid var(--ss-border);
    border-radius: var(--ss-radius-control);
  }
</style>

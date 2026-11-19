<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  import type { Snippet } from 'svelte';
  let { children, ...rest }: HTMLAttributes<HTMLElement> & { children: Snippet } = $props();
</script>
<section {...rest}>{@render children()}</section>
<style>
  section {
    min-width: 0;
    padding: var(--ss-space-4);
    background: var(--ss-surface);
    border: 1px solid var(--ss-border);
    border-radius: var(--ss-radius-control);
  }
</style>

<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  import type { Snippet } from 'svelte';
  let { children, ...rest }: HTMLAttributes<HTMLElement> & { children: Snippet } = $props();
</script>
<section {...rest}>{@render children()}</section>
<style>
  section {
    min-width: 0;
    padding: clamp(var(--ss-space-4), 3vw, var(--ss-space-6));
    background: var(--ss-surface);
    border: 1px solid var(--ss-border);
    border-radius: var(--ss-radius-panel);
    box-shadow: var(--ss-shadow-panel);
  }
</style>

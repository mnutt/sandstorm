<script lang="ts">
  import type { HTMLSelectAttributes } from 'svelte/elements';
  import type { Snippet } from 'svelte';
  let { value = $bindable(''), children, ...rest }: Omit<HTMLSelectAttributes, 'value' | 'multiple'> & { value?: string; children: Snippet } = $props();
</script>
<select {...rest} bind:value>{@render children()}</select>
<style>
  select {
    display: block;
    width: 100%;
    min-width: 0;
    min-height: var(--ss-control-height);
    padding: var(--ss-space-2) var(--ss-space-3);
    border: 1px solid var(--ss-control-border);
    border-radius: var(--ss-radius-control);
    background: var(--ss-surface);
    color: var(--ss-text);
    font: inherit;
  }

  select:focus-visible {
    outline: 3px solid var(--ss-focus);
    outline-offset: 2px;
  }

  select:disabled {
    opacity: .6;
  }
</style>

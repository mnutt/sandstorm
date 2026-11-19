<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  let { value = $bindable(''), ...rest }: Omit<HTMLInputAttributes, 'value'> & { value?: string } = $props();
</script>
<input {...rest} bind:value />
<style>
  input {
    display: block;
    width: 100%;
    min-width: 0;
    min-height: var(--ss-control-height);
    padding: var(--ss-space-2) var(--ss-space-3);
    border: 1px solid var(--ss-control-border);
    border-radius: var(--ss-radius-control);
    color: var(--ss-text);
    background: var(--ss-surface);
    font: inherit;
  }

  input:focus-visible {
    outline: 3px solid var(--ss-focus);
    outline-offset: 2px;
  }

  input:disabled {
    opacity: .6;
  }

  input[aria-invalid=true] {
    border-color: var(--ss-danger);
  }
</style>

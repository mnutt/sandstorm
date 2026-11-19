<script lang="ts">
  import { Button as BitsButton } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  let { variant = 'primary', children, class: className = '', type = 'button', ...rest }:
    HTMLButtonAttributes & { variant?: 'primary' | 'secondary' | 'danger'; children?: Snippet } = $props();
</script>

<span class="scope">
  <BitsButton.Root {...rest} {type} class={['button', variant, className]}>{@render children?.()}</BitsButton.Root>
</span>

<style>
  .scope {
    display: inline-flex;
    max-width: 100%;
    vertical-align: middle;
  }

  .scope > :global(.button) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--ss-space-2);
    min-height: var(--ss-control-height);
    padding: var(--ss-space-2) var(--ss-space-4);
    border: 1px solid transparent;
    border-radius: var(--ss-radius-control);
    background: var(--ss-brand);
    color: white;
    font: 600 var(--ss-text-small)/1.35 var(--ss-font);
    text-align: center;
    cursor: pointer;
  }

  .scope > :global(.button:hover:not(:disabled)) {
    background: var(--ss-brand-hover);
  }

  .scope > :global(.secondary) {
    background: var(--ss-surface);
    color: var(--ss-brand-hover);
    border-color: var(--ss-control-border);
  }

  .scope > :global(.secondary:hover:not(:disabled)) {
    background: var(--ss-brand-subtle);
  }

  .scope > :global(.danger) {
    background: var(--ss-danger);
  }

  .scope > :global(.button:focus-visible) {
    outline: 3px solid var(--ss-focus);
    outline-offset: 3px;
  }

  .scope > :global(.button:disabled) {
    opacity: .5;
    cursor: not-allowed;
  }

  @media (forced-colors: active) {
    .scope > :global(.button) {
      border-color: ButtonText;
    }
  }
</style>

<script lang="ts">
  import { Dialog } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import Button from './Button.svelte';
  let { open = $bindable(false), title, description, triggerLabel, triggerVariant = 'secondary', triggerContent, onTrigger, busy = false, children }:
    { open?: boolean; title: string; description: string; triggerLabel: string; triggerContent?: Snippet; triggerVariant?: 'secondary' | 'chrome'; onTrigger?: () => void; busy?: boolean; children: Snippet } = $props();
</script>

<Dialog.Root bind:open>
  <Dialog.Trigger onclick={onTrigger}>
    {#snippet child({ props })}<Button {...props} variant={triggerVariant} aria-label={triggerLabel} title={triggerContent ? triggerLabel : undefined}>{#if triggerContent}{@render triggerContent()}{:else}{triggerLabel}{/if}</Button>{/snippet}
  </Dialog.Trigger>
  <Dialog.Portal>
    <Dialog.Overlay>
      {#snippet child({ props })}<div {...props} class="overlay"></div>{/snippet}
    </Dialog.Overlay>
    <Dialog.Content escapeKeydownBehavior={busy ? 'ignore' : 'close'} interactOutsideBehavior={busy ? 'ignore' : 'close'}>
      {#snippet child({ props })}
        <div {...props} class="dialog">
          <Dialog.Title>{#snippet child({ props })}<h2 {...props}>{title}</h2>{/snippet}</Dialog.Title>
          <Dialog.Description>{#snippet child({ props })}<p {...props}>{description}</p>{/snippet}</Dialog.Description>
          {@render children()}
        </div>
      {/snippet}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: var(--ss-layer-overlay);
    background: #21132c80;
  }

  .dialog {
    position: fixed;
    z-index: var(--ss-layer-dialog);
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(32rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    overflow: auto;
    padding: var(--ss-space-6);
    border: 1px solid var(--ss-border);
    border-radius: var(--ss-radius-panel);
    background: var(--ss-surface);
    color: var(--ss-text);
    box-shadow: var(--ss-shadow-dialog);
  }

  h2 {
    margin: 0 0 var(--ss-space-3);
    font-size: var(--ss-text-title);
    line-height: 1.3;
  }

  p {
    color: var(--ss-muted);
    margin: 0 0 var(--ss-space-5);
  }
</style>

<script lang="ts">
  import { Popover } from 'bits-ui';
  import Button from './components/ui/Button.svelte';
  import { isPlainNavigation } from './lib/navigation';
  import { rememberRoute } from './lib/router';
  import type { ShellState } from './lib/shell';
  let { model, navigate, disconnect }: {
    model: ShellState;
    navigate: (event: MouseEvent, path: string) => void;
    disconnect: () => void;
  } = $props();
  let open = $state(false);
  let navigating = false;
  const label = $derived(model.account || (model.fixture ? 'Fixture mode' : 'Account'));
</script>

<Popover.Root bind:open>
  <Popover.Trigger aria-label={`Account: ${label}`}>
    {#snippet child({ props })}
      <button {...props} class="trigger"><span>{label}</span><span aria-hidden="true">▾</span></button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content align="end" sideOffset={6} onCloseAutoFocus={event => {
      if (navigating) { event.preventDefault(); navigating = false; }
    }}>
      {#snippet child({ props, wrapperProps })}
      <div {...wrapperProps}>
        <div {...props} class="account-menu" aria-label="Account controls">
          <strong>{model.account ? `Connected as ${model.account}` : label}</strong>
          <a href="/account" onclick={event => { navigating = isPlainNavigation(event); navigate(event, '/account'); open = false; }}>Account</a>
          {#if model.account}
            <a href="/auth/start" onclick={rememberRoute}>Switch account</a>
            <Button variant="secondary" onclick={() => { open = false; disconnect(); }}>Disconnect</Button>
          {:else if !model.fixture}
            <a href="/auth/start" onclick={rememberRoute}>Sign in with Sandstorm</a>
          {:else}
            <p>Test data, private to this connection.</p>
          {/if}
        </div>
      </div>
      {/snippet}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

<style>
  .trigger {
    display: flex;
    align-items: center;
    gap: var(--ss-space-2);
    min-height: var(--ss-control-height);
    max-width: 13rem;
    padding: var(--ss-space-2) var(--ss-space-3);
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .trigger span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .trigger:hover, .trigger[data-state=open] {
    background: #ffffff18;
  }

  .trigger:focus-visible, a:focus-visible {
    outline: 3px solid var(--ss-focus);
    outline-offset: -3px;
  }

  .trigger:focus-visible {
    outline-color: white;
  }

  .account-menu {
    display: grid;
    gap: var(--ss-space-2);
    width: min(17rem, calc(100vw - 1rem));
    max-height: var(--bits-popover-content-available-height);
    overflow: auto;
    padding: var(--ss-space-3);
    border: 1px solid var(--ss-border);
    border-radius: var(--ss-radius-control);
    background: var(--ss-surface);
    color: var(--ss-text);
    box-shadow: var(--ss-shadow-dialog);
    z-index: var(--ss-layer-dialog);
  }

  strong {
    font-size: var(--ss-text-small);
    overflow-wrap: anywhere;
  }

  a {
    display: flex;
    align-items: center;
    min-height: var(--ss-control-height);
    color: var(--ss-brand);
    text-decoration: none;
    padding: 0 var(--ss-space-2);
    border-radius: var(--ss-radius-control);
  }

  a:hover {
    background: var(--ss-brand-subtle);
  }

  p {
    margin: 0;
    color: var(--ss-muted);
    font-size: var(--ss-text-small);
  }

  @media (max-width: 600px) {
    .trigger {
      max-width: 7rem;
    }
  }
</style>

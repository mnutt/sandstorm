<script lang="ts">
  import Button from './components/ui/Button.svelte';
  import Panel from './components/ui/Panel.svelte';
  import { onMount, tick } from 'svelte';
  import { grainRoute, rememberRoute } from './lib/router';
  import { NavigationController } from './lib/navigation';
  import { ShellService, initialShellState, type ShellState } from './lib/shell';
  import GrainFrame from './GrainFrame.svelte';
  import Apps from './Apps.svelte';
  import Account from './Account.svelte';
  import Grains from './Grains.svelte';
  import Notifications from './Notifications.svelte';
  import './styles.css';

  let model: ShellState = $state(initialShellState());
  const service = new ShellService(next => { model = next; });
  let content: HTMLDivElement;
  let focusVersion = 0;
  const navigation = new NavigationController({
    close: () => service.closeGrain(),
    open: (id, path) => service.openGrain(id, path),
    changed: (next, focus) => {
      route = next;
      if (focus) {
        const version = ++focusVersion;
        void tick().then(() => { if (version === focusVersion) content?.focus(); });
      }
    },
  });
  let route = $state(navigation.route);
  const view = $derived(route.page === 'grain' ? 'grains' : route.page);
  const pageTitle = $derived(model.activeGrain?.title || ({notifications:'Notifications', grains:'Grains', apps:'Apps', account:'Account', grain:'Grain', missing:'Page not found'}[route.page]));
  $effect(() => { route; navigation.sync(model); });
  const navigate = (path: string) => navigation.navigate(path);
  onMount(() => { service.start(); return () => service.stop(); });
</script>

<svelte:window onpopstate={() => navigation.navigate(location.pathname + location.search + location.hash, true)} />
<svelte:head><title>{pageTitle} · Sandstorm</title><meta name="description" content="Experimental Sandstorm shell running on Rust and Svelte." /></svelte:head>

<header><strong>Sandstorm</strong><span>Rust shell · experimental</span></header>
<main class="shell-layout">
  <aside aria-label="About this shell">
    <h1>Shell preview</h1>
    <p>A small first step toward the new architecture.</p>
    <a href="/main-shell">Open the main shell ↗</a>
    <nav aria-label="Shell pages">
      <a href="/notifications" aria-current={view === 'notifications' ? 'page' : undefined} onclick={event => navigation.link(event, '/notifications')}>Notifications</a>
      <a href="/grains" aria-current={view === 'grains' ? 'page' : undefined} onclick={event => navigation.link(event, '/grains')}>Grains</a>
      <a href="/apps" aria-current={view === 'apps' ? 'page' : undefined} onclick={event => navigation.link(event, '/apps')}>Apps</a>
      <a href="/account" aria-current={view === 'account' ? 'page' : undefined} onclick={event => navigation.link(event, '/account')}>Account</a>
    </nav>
    <hr />
    {#if model.fixture}
      <h2>Fixture mode</h2>
      <p>These notifications are test data, private to this connection. Reconnecting resets them.</p>
    {:else if model.account}
      <h2>Connected as {model.account}</h2>
      <p>Notifications and dismissals are shared with the main shell. Changes appear within a few seconds.</p>
      <p><a href="/auth/start" onclick={rememberRoute}>Switch account</a></p>
      <Button variant="secondary" onclick={() => service.logout()}>Disconnect</Button>
    {:else}
      <h2>Your Sandstorm account</h2>
      <p>Sign in through the main shell to see your real notifications.</p>
    {/if}
    <p>Create and open grains here. Installation and sharing management use the main shell.</p>
  </aside>
  <div class="route-content" bind:this={content} tabindex="-1">
  <p class="sr-only" aria-live="polite" aria-atomic="true">{pageTitle}</p>
  {#if model.connectionError}<p class="error" role="alert">{model.connectionError}</p>{/if}
  {#if model.notificationError || model.grainError}
    <div class="error" role="alert"><p>{model.notificationError}</p><p>{model.grainError}</p>
      <Button onclick={() => service.clearErrors()}>Dismiss message</Button></div>
  {/if}
  {#if model.activeGrain}
    {#key model.activeGrain.url}
      <GrainFrame pathChanged={path => navigation.updatePath(model.activeGrain?.grainId, path)} rename={title => service.renameGrain(title)} renderTemplate={(input) => service.renderTemplate(input)} grain={model.activeGrain} close={() => navigate('/grains')} />
    {/key}
  {:else if route.page === 'missing'}
    <Panel><h2>Page not found</h2><Button onclick={() => navigate('/grains')}>Go to grains</Button></Panel>
  {:else if route.page === 'grain'}
    <Panel aria-label="Grain route">
      <h2>Grain</h2>
      {#if model.status === 'signed-out'}
        <p><a href="/auth/start" onclick={rememberRoute}>Sign in with Sandstorm</a> to open this grain.</p>
      {:else if model.status === 'waiting'}
        <p>Waiting for the main shell… Your login will be checked when it returns.</p>
      {:else if model.status !== 'ready' || model.openingGrain}<p role="status">Opening grain…</p>
      {:else}<Button onclick={() => navigation.reopen()}>Reopen grain</Button>{/if}
      <Button variant="secondary" onclick={() => navigate('/grains')}>Back to grains</Button>
    </Panel>
  {:else if view === 'account'}
    <Account {model} {service} />
  {:else if view === 'apps'}
    <Apps service={service} status={model.status} fixture={model.fixture} creation={model.creation}
      created={id => navigate(grainRoute(id))} checkGrains={() => navigate('/grains')} />
  {:else if view === 'grains'}
    <Grains {model} {service} {navigate} />
  {:else}
    <Notifications {model} {service} />
  {/if}
  </div>
</main>

<style>
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--ss-space-3);
    padding: var(--ss-space-4) clamp(var(--ss-space-4), 4vw, var(--ss-space-7));
    background: var(--ss-brand-hover);
    color: white;
  }

  header strong {
    font-size: 1.5rem;
    letter-spacing: -.03em;
  }

  header span {
    font-size: var(--ss-text-small);
    color: #e8dcef;
  }

  .shell-layout {
    display: grid;
    grid-template-columns: 15rem minmax(0, 1fr);
    gap: var(--ss-space-6);
    max-width: 80rem;
    margin: var(--ss-space-7) auto;
    padding: 0 var(--ss-space-5);
  }

  aside {
    min-width: 0;
  }

  h1 {
    font-size: var(--ss-text-title);
    margin: 0 0 var(--ss-space-3);
  }

  h2 {
    font-size: 1rem;
    overflow-wrap: anywhere;
  }

  aside p {
    color: var(--ss-muted);
    font-size: var(--ss-text-small);
  }

  a {
    color: var(--ss-brand);
    text-underline-offset: .2em;
  }

  a:focus-visible {
    outline: 3px solid var(--ss-focus);
    outline-offset: 3px;
  }

  nav {
    display: grid;
    gap: var(--ss-space-2);
    margin: var(--ss-space-5) 0;
  }

  nav a {
    min-height: var(--ss-control-height);
    padding: var(--ss-space-2) var(--ss-space-3);
    display: flex;
    align-items: center;
    border: 1px solid transparent;
    border-radius: var(--ss-radius-control);
    text-decoration: none;
    color: var(--ss-muted);
    font-weight: 600;
  }

  nav a:hover {
    background: var(--ss-surface);
  }

  nav a[aria-current=page] {
    color: var(--ss-brand-hover);
    background: var(--ss-brand-subtle);
    border-color: var(--ss-border);
    box-shadow: inset 3px 0 var(--ss-brand);
  }

  hr {
    border: 0;
    border-top: 1px solid var(--ss-border);
    margin: var(--ss-space-5) 0;
  }

  .route-content {
    min-width: 0;
  }

  .error {
    padding: var(--ss-space-4);
    margin-bottom: var(--ss-space-4);
    color: var(--ss-danger);
    background: var(--ss-danger-subtle);
    border-radius: var(--ss-radius-control);
  }

  @media (max-width: 760px) {
    .shell-layout {
      grid-template-columns: minmax(0, 1fr);
      margin: var(--ss-space-5) auto;
      padding: 0 var(--ss-space-4);
    }
    nav {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>

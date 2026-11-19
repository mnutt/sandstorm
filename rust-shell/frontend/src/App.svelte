<script lang="ts">
  import { readSidebarCollapsed, saveSidebarCollapsed } from './lib/preferences';
  import ShellIcon from './components/ui/ShellIcon.svelte';
  import Button from './components/ui/Button.svelte';
  import Panel from './components/ui/Panel.svelte';
  import { onMount, tick } from 'svelte';
  import { grainRoute, rememberRoute } from './lib/router';
  import { NavigationController } from './lib/navigation';
  import { ShellService, initialShellState, type ShellState } from './lib/shell';
  import GrainFrame from './GrainFrame.svelte';
  import Apps from './Apps.svelte';
  import Account from './Account.svelte';
  import AccountMenu from './AccountMenu.svelte';
  import Grains from './Grains.svelte';
  import Notifications from './Notifications.svelte';
  import './styles.css';

  let model: ShellState = $state(initialShellState());
  const service = new ShellService(next => { model = next; });
  let content: HTMLDivElement;
  let focusVersion = 0;
  let sidebarCollapsed = $state(readSidebarCollapsed());
  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    saveSidebarCollapsed(sidebarCollapsed);
  }
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

<header>
  <div class="brand-group">
    <Button variant="chrome" onclick={toggleSidebar} aria-controls="shell-sidebar" aria-expanded={!sidebarCollapsed}
      aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
      <ShellIcon name="sidebar" />
    </Button>
  <a class="brand" href="/grains" onclick={event => navigation.link(event, '/grains')}>Sandstorm</a>
  </div>
  <div class="topbar-actions">
    <a class="notifications" href="/notifications" aria-label="Notifications" aria-current={view === 'notifications' ? 'page' : undefined}
      onclick={event => navigation.link(event, '/notifications')}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
      <span>Notifications</span>
      {#if model.entries.some(entry => entry.unread)}<span class="unread" aria-label="Unread notifications"></span>{/if}
    </a>
    <AccountMenu {model} navigate={(event, path) => navigation.link(event, path)} disconnect={() => service.logout()} />
  </div>
</header>
<main class="shell-layout" class:collapsed={sidebarCollapsed}>
  <aside id="shell-sidebar" aria-label="Shell navigation">
    <nav aria-label="Shell pages">
      <a href="/apps" aria-label="Apps" title={sidebarCollapsed ? 'Apps' : undefined} aria-current={view === 'apps' ? 'page' : undefined} onclick={event => navigation.link(event, '/apps')}><ShellIcon name="apps" /><span>Apps</span></a>
      <a href="/grains" aria-label="Grains" title={sidebarCollapsed ? 'Grains' : undefined} aria-current={view === 'grains' ? 'page' : undefined} onclick={event => navigation.link(event, '/grains')}><ShellIcon name="grains" /><span>Grains</span></a>
    </nav>
    <div class="shell-links"><a href="/main-shell" aria-label="Main shell" title="Main shell"><ShellIcon name="external" /><span>Main shell</span></a><small>Preview</small></div>
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
    position: sticky;
    top: 0;
    z-index: var(--ss-layer-chrome);
    height: var(--ss-header-height);
    display: flex;
    justify-content: space-between;
    align-items: center;
    min-height: 3rem;
    padding: 0 var(--ss-space-3);
    background: var(--ss-chrome-header);
    color: var(--ss-chrome-text);
  }

  .brand-group {
    display: flex;
    align-items: center;
    gap: var(--ss-space-2);
    min-width: 0;
  }

  .brand {
    font-size: 1.25rem;
    font-weight: 700;
    letter-spacing: -.03em;
    color: inherit;
    text-decoration: none;
  }

  .topbar-actions {
    display: flex;
    align-items: center;
    gap: var(--ss-space-1);
    min-width: 0;
  }

  .notifications {
    display: flex;
    align-items: center;
    gap: var(--ss-space-2);
    min-height: var(--ss-control-height);
    padding: 0 var(--ss-space-3);
    color: inherit;
    text-decoration: none;
    font-size: var(--ss-text-small);
  }

  .notifications:hover, .notifications[aria-current=page] {
    background: #ffffff18;
  }

  .unread {
    width: .5rem;
    height: .5rem;
    border-radius: 50%;
    background: white;
  }

  .shell-layout {
    display: grid;
    grid-template-columns: 11rem minmax(0, 1fr);
    min-height: calc(100dvh - 3rem);
    --ss-workspace-height: calc(100dvh - 4.5rem);
  }

  .shell-layout.collapsed {
    grid-template-columns: 3.5rem minmax(0, 1fr);
  }

  aside {
    position: sticky;
    top: var(--ss-header-height);
    height: calc(100dvh - var(--ss-header-height));
    overflow-y: auto;
    align-self: start;
    scrollbar-width: thin;
    color-scheme: dark;
    min-width: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--ss-chrome-border);
    background: var(--ss-chrome);
    color: var(--ss-chrome-text);
    padding: var(--ss-space-2) 0;
  }

  nav {
    display: grid;
    gap: 0;
  }

  nav a {
    display: flex;
    align-items: center;
    min-height: var(--ss-control-height);
    padding: 0 var(--ss-space-3);
    gap: var(--ss-space-3);
    border-radius: 0;
    color: var(--ss-chrome-muted);
    text-decoration: none;
    font-weight: 600;
  }

  nav a:hover {
    background: var(--ss-chrome-hover);
  }

  nav a[aria-current=page] {
    color: var(--ss-chrome-text);
    background: var(--ss-chrome-selected);
  }

  .shell-links {
    display: grid;
    gap: var(--ss-space-1);
    margin-top: auto;
    padding: var(--ss-space-2) 0;
    font-size: var(--ss-text-small);
  }

  .shell-links a {
    display: flex;
    align-items: center;
    gap: var(--ss-space-3);
    min-height: var(--ss-control-height);
    padding: 0 var(--ss-space-3);
    color: var(--ss-chrome-muted);
    text-decoration: none;
  }

  .shell-links a:hover {
    background: var(--ss-chrome-hover);
    color: var(--ss-chrome-text);
  }

  small {
    color: var(--ss-chrome-muted);
    padding: 0 var(--ss-space-3);
  }

  .collapsed nav a, .collapsed .shell-links a {
    justify-content: center;
    padding: 0;
  }

  .collapsed aside span, .collapsed aside small {
    display: none;
  }

  aside a:focus-visible {
    outline-color: var(--ss-chrome-focus);
  }

  a {
    color: var(--ss-brand);
    text-underline-offset: .2em;
  }

  a:focus-visible {
    outline: 3px solid var(--ss-focus);
    outline-offset: -3px;
  }

  header a:focus-visible {
    outline-color: white;
  }

  h2 {
    font-size: var(--ss-text-title);
  }

  .route-content {
    min-width: 0;
    padding: var(--ss-space-3);
  }

  .route-content:focus {
    outline: none;
  }

  .error {
    padding: var(--ss-space-3);
    margin: 0 0 var(--ss-space-3);
    color: var(--ss-danger);
    background: var(--ss-danger-subtle);
    border-radius: var(--ss-radius-control);
  }

  @media (max-width: 600px) {
    .shell-layout, .shell-layout.collapsed {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto 1fr;
      --ss-workspace-height: calc(100dvh - 8rem);
    }
    .shell-layout.collapsed {
      grid-template-rows: 1fr;
      --ss-workspace-height: calc(100dvh - 4rem);
    }
    .collapsed aside {
      display: none;
    }
    aside {
      height: auto;
      max-height: calc(100dvh - var(--ss-header-height));
      z-index: var(--ss-layer-chrome);
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      border-right: 0;
      border-bottom: 1px solid var(--ss-chrome-border);
      padding: var(--ss-space-1) var(--ss-space-2);
    }
    nav {
      display: flex;
    }
    .shell-links {
      margin: 0;
      padding: 0 var(--ss-space-2);
    }
    .shell-links span, .shell-links small {
      display: none;
    }
    header {
      padding: 0 var(--ss-space-2);
    }
    .brand {
      font-size: 1.125rem;
    }
    .brand-group {
      gap: var(--ss-space-1);
    }
    .notifications > span:not(.unread) {
      display: none;
    }
    .notifications {
      padding: 0 var(--ss-space-2);
    }
    .route-content {
      padding: var(--ss-space-2);
    }
  }
</style>

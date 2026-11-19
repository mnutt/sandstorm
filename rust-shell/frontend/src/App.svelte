<script lang="ts">
  import { readSidebarCollapsed, saveSidebarCollapsed } from './lib/preferences';
  import LoadingStatus from './components/ui/LoadingStatus.svelte';
  import GrainIcon from './components/ui/GrainIcon.svelte';
  import ShellIcon from './components/ui/ShellIcon.svelte';
  import Button from './components/ui/Button.svelte';
  import Panel from './components/ui/Panel.svelte';
  import { onMount, tick } from 'svelte';
  import { grainRoute, sharedRoute, rememberRoute } from './lib/router';
  import { NavigationController } from './lib/navigation';
  import { ShellService, initialShellState, type ShellState } from './lib/shell';
  import SharedGrain from './SharedGrain.svelte';
  import GrainFrame from './GrainFrame.svelte';
  import Apps from './Apps.svelte';
  import Install from './Install.svelte';
  import Account from './Account.svelte';
  import AccountMenu from './AccountMenu.svelte';
  import Grains from './Grains.svelte';
  import Notifications from './Notifications.svelte';
  import './styles.css';

  let model: ShellState = $state(initialShellState());
  const service = new ShellService(next => { model = next; });
  let content: HTMLDivElement;
  let header: HTMLElement;
  let toolbarTarget = $state<HTMLDivElement>();
  let headerHeight = $state(44);
  let focusVersion = 0;
  let sharedTabs = $state<{webkey:string;path:string;title:string;iconSrc:string}[]>([]);
  $effect(() => {
    const current = route;
    if (current.page === 'shared' && (model.status === 'ready' || model.status === 'signed-out') && !sharedTabs.some(tab=>tab.webkey===current.webkey)) {
      if (sharedTabs.length < 8) sharedTabs = [...sharedTabs,{webkey:current.webkey,path:current.path,title:'Shared grain',iconSrc:''}];
    }
  });
  function sharedPathChanged(webkey:string,path:string) {
    sharedTabs = sharedTabs.map(tab=>tab.webkey===webkey?{...tab,path}:tab);
    if (route.page === 'shared' && route.webkey === webkey) {
      history.replaceState(null,'',sharedRoute(webkey,path));
      navigation.navigate(sharedRoute(webkey,path),true);
    }
  }
  function closeShared(webkey:string) {
    sharedTabs=sharedTabs.filter(tab=>tab.webkey!==webkey);
    if (route.page==='shared' && route.webkey===webkey) navigate('/grains');
  }
  let sidebarCollapsed = $state(readSidebarCollapsed());
  function toggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    saveSidebarCollapsed(sidebarCollapsed);
  }
  const navigation = new NavigationController({
    close: () => service.selectGrain(null),
    open: (id, path) => service.openGrain(id, path),
    changed: (next, focus) => {
      route = next;
      service.selectGrain(next.page === 'grain' ? next.grainId : null);
      if (focus) {
        const version = ++focusVersion;
        void tick().then(() => { if (version === focusVersion) content?.focus(); });
      }
    },
  });
  let route = $state(navigation.route);
  const connecting = $derived(!model.activeGrain && !['shared', 'missing'].includes(route.page) && ['connecting', 'reconnecting', 'waiting'].includes(model.status));
  const view = $derived(route.page === 'grain' ? 'grains' : route.page);
  const pageTitle = $derived(model.activeGrain?.title || ({install:'Install app', notifications:'Notifications', grains:'Grains', apps:'Apps', account:'Account', grain:'Grain', shared:'Shared grain', missing:'Page not found'}[route.page]));
  $effect(() => { route; navigation.sync(model); });
  const navigate = (path: string) => navigation.navigate(path);
  onMount(() => {
    const observer = new ResizeObserver(() => { headerHeight = header.getBoundingClientRect().height; });
    observer.observe(header);
    service.start();
    return () => { observer.disconnect(); service.stop(); };
  });
  function closeTab(id: string) {
    service.closeGrain(id);
    if (route.page === 'grain' && route.grainId === id) navigate('/grains');
  }
  function pathChanged(id: string, path: string) {
    service.grainPathChanged(id, path);
    navigation.updatePath(id, path);
  }
</script>

<svelte:window onpopstate={() => navigation.navigate(location.pathname + location.search + location.hash, true)} />
<svelte:head><title>{pageTitle} · Sandstorm</title><meta name="description" content="Experimental Sandstorm shell running on Rust and Svelte." /></svelte:head>

<div class="shell" style:--ss-header-height={`${headerHeight}px`}>
<header bind:this={header} class:has-grain={!!model.activeGrain}>
  <div class="brand-group">
    <a class="brand" href="/grains" onclick={event => navigation.link(event, '/grains')}><img src="/sandstorm-logo.svg" width="28" height="30" alt="" /><span>Sandstorm</span></a>
  </div>
  <div class="grain-toolbar" bind:this={toolbarTarget}>{#if route.page === 'apps' || route.page === 'grains' || route.page === 'install'}<h1 class="page-title">{pageTitle}</h1>{/if}</div>
  <div class="topbar-actions">
    <a class="notifications" href="/notifications" aria-label="Notifications" title="Notifications" aria-current={view === 'notifications' ? 'page' : undefined}
      onclick={event => navigation.link(event, '/notifications')}>
      <ShellIcon name="bell" toolbar />
      {#if model.entries.some(entry => entry.unread)}<span class="unread" aria-label="Unread notifications"></span>{/if}
    </a>
    <AccountMenu {model} navigate={(event, path) => navigation.link(event, path)} disconnect={() => service.logout()} />
  </div>
</header>
<main class="shell-layout" class:collapsed={sidebarCollapsed}>
  <aside id="shell-sidebar" aria-label="Shell navigation">
    <nav aria-label="Shell pages">
      <a href="/apps" aria-label="Apps" title={sidebarCollapsed ? 'Apps' : undefined} aria-current={view === 'apps' || view === 'install' ? 'page' : undefined} onclick={event => navigation.link(event, '/apps')}><ShellIcon name="apps" /><span>Apps</span></a>
      <a href="/grains" aria-label="Grains" title={sidebarCollapsed ? 'Grains' : undefined} aria-current={route.page === 'grains' ? 'page' : undefined} onclick={event => navigation.link(event, '/grains')}><ShellIcon name="grains" /><span>Grains</span></a>
      <ul class="open-grains" aria-label="Open grains">
        {#each model.openGrains as grain (grain.url)}
          <li class:current={model.activeGrain?.grainId === grain.grainId}><a href={grainRoute(grain.grainId, grain.path)} aria-label={`Switch to ${grain.title}`} title={grain.title}
            aria-current={model.activeGrain?.grainId === grain.grainId ? 'page' : undefined}
            onclick={event => navigation.link(event, grainRoute(grain.grainId, grain.path))}>
            <GrainIcon src={grain.iconSrc} /><span>{grain.title}</span>
          </a><div class="close-grain"><Button variant="chrome" aria-label={`Close ${grain.title}`} title={`Close ${grain.title}`} onclick={() => closeTab(grain.grainId)}><ShellIcon name="close" /></Button></div></li>
        {/each}
        {#each sharedTabs as tab (tab.webkey)}
          <li class:current={route.page === 'shared' && route.webkey === tab.webkey}>
            <a href={sharedRoute(tab.webkey,tab.path)} aria-label={`Switch to ${tab.title}`} title={tab.title}
              aria-current={route.page==='shared' && route.webkey===tab.webkey?'page':undefined}
              onclick={event=>navigation.link(event,sharedRoute(tab.webkey,tab.path))}><GrainIcon src={tab.iconSrc} /><span>{tab.title}</span></a>
            <div class="close-grain"><Button variant="chrome" aria-label={`Close ${tab.title}`} title={`Close ${tab.title}`} onclick={()=>closeShared(tab.webkey)}><ShellIcon name="close" /></Button></div>
          </li>
        {/each}
      </ul>
    </nav>
    <div class="shell-links"><a href="/main-shell" aria-label="Main shell" title="Main shell"><ShellIcon name="external" /><span>Main shell</span></a><div class="sidebar-toggle"><Button variant="chrome" onclick={toggleSidebar} aria-controls="shell-sidebar" aria-expanded={!sidebarCollapsed}
      aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}><ShellIcon name="sidebar" /></Button></div></div>
  </aside>
  <div class="route-content" class:connecting class:workspace={!!model.activeGrain || route.page === 'shared'} bind:this={content} tabindex="-1">
  <p class="sr-only" aria-live="polite" aria-atomic="true">{pageTitle}</p>
  {#if model.connectionError}<p class="error" role="alert">{model.connectionError}</p>{/if}
  {#if model.notificationError || model.grainError}
    <div class="error" role="alert"><p>{model.notificationError}</p><p>{model.grainError}</p>
      <Button onclick={() => service.clearErrors()}>Dismiss message</Button></div>
  {/if}
  {#if toolbarTarget}
    {#each sharedTabs as tab (tab.webkey)}
      <SharedGrain webkey={tab.webkey} path={tab.path} active={route.page==='shared' && route.webkey===tab.webkey}
        {toolbarTarget} accountKey={model.accountKey} pathChanged={path=>sharedPathChanged(tab.webkey,path)}
        metadataChanged={(title,iconSrc)=>{sharedTabs=sharedTabs.map(item=>item.webkey===tab.webkey?{...item,title,iconSrc}:item);}} />
    {/each}
    {#each model.openGrains as grain (grain.url)}
      <GrainFrame {toolbarTarget} active={model.activeGrain?.grainId === grain.grainId}
        pathChanged={path => pathChanged(grain.grainId, path)} rename={title => service.renameGrain(grain.grainId, title)}
        powerboxActions={service.powerbox(grain.grainId)} sharingActions={service.sharing(grain.grainId)} renderTemplate={input => service.renderTemplate(grain.grainId, input)} {grain} />
    {/each}
  {/if}
  {#if !model.activeGrain}
  {#if connecting}
    <div class="connection-loading"><LoadingStatus
      label={model.status === 'waiting' ? 'Waiting for Sandstorm…' : model.status === 'reconnecting' ? 'Reconnecting to Sandstorm…' : 'Connecting to Sandstorm…'}
      detail={model.status === 'waiting' ? 'Your login will be checked when the server returns.' : ''} /></div>
  {/if}
  <div class="route-page" hidden={connecting}>
  {#if route.page === 'missing'}
    <Panel><h2>Page not found</h2><Button onclick={() => navigate('/grains')}>Go to grains</Button></Panel>
  {:else if route.page === 'install'}
    {#key (route.packageId || '') + route.url + model.accountKey}<Install {service} {model} {navigate} packageId={route.packageId} url={route.url} />{/key}
  {:else if route.page === 'shared'}
    {@const webkey = route.webkey}
    {#if !sharedTabs.some(tab=>tab.webkey===webkey)}<Panel>{#if sharedTabs.length>=8}<p>Close a shared grain before opening another.</p>{:else}<LoadingStatus label="Connecting…" />{/if}</Panel>{/if}
  {:else if route.page === 'grain'}
    <Panel aria-label="Grain route">
      <h2>Grain</h2>
      {#if model.status === 'signed-out'}
        <p><a href="/auth/start" onclick={rememberRoute}>Sign in with Sandstorm</a> to open this grain.</p>
      {:else if model.status === 'waiting'}
        <LoadingStatus label="Waiting for Sandstorm…" detail="Your login will be checked when the server returns." />
      {:else if model.status !== 'ready' || model.openingGrain}<LoadingStatus label="Opening grain…" detail="Starting the app and establishing its session." />
      {:else}<Button onclick={() => navigation.reopen()}>Reopen grain</Button>{/if}
      <Button variant="secondary" onclick={() => navigate('/grains')}>Back to grains</Button>
    </Panel>
  {:else if view === 'account'}
    <Account {model} {service} />
  {:else if view === 'apps'}
    <Apps {service} {model} {navigate} appId={route.page === 'apps' ? route.appId : undefined}
      created={id => navigate(grainRoute(id))} checkGrains={() => navigate('/grains')} />
  {:else if view === 'grains'}
    <Grains {model} {service} {navigate} />
  {:else}
    <Notifications {model} {service} />
  {/if}
  </div>
  {/if}
  </div>
</main>
</div>

<style>
  .page-title { margin: 0; font-size: 1rem; font-weight: 600; color: var(--ss-chrome-text); }
  header {
    position: sticky;
    top: 0;
    z-index: var(--ss-layer-chrome);

    display: flex;
    justify-content: space-between;
    align-items: center;
    min-height: 2.75rem;
    --ss-control-height: 2.25rem;
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

  .brand img { filter: brightness(0) invert(1); }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--ss-space-2);
    font-size: 1.125rem;
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
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.125rem;
    min-height: 2.125rem;
    padding: var(--ss-space-1);
    border: 1px solid transparent;
    border-radius: var(--ss-radius-control);
    color: inherit;
    text-decoration: none;
  }

  .notifications:hover, .notifications[aria-current=page] {
    background: var(--ss-chrome-hover);
  }

  .unread {
    position: absolute;
    top: .2rem;
    right: .2rem;
    width: .5rem;
    height: .5rem;
    border-radius: 50%;
    background: white;
  }

  .shell-layout {
    display: grid;
    grid-template-columns: 12rem minmax(0, 1fr);
    min-height: calc(100dvh - var(--ss-header-height));

  }

  .shell-layout.collapsed {
    grid-template-columns: 3.5rem minmax(0, 1fr);
  }

  aside {
    position: sticky;
    top: var(--ss-header-height);
    height: calc(100dvh - var(--ss-header-height));
    overflow: clip;
    align-self: start;
    scrollbar-width: thin;
    color-scheme: dark;
    min-width: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--ss-chrome-border);
    background: linear-gradient(12deg, transparent 35%, #ffffff08) top / 100% 5rem no-repeat var(--ss-chrome);
    color: var(--ss-chrome-text);
    padding: var(--ss-space-2) 0;
  }

  nav {
    grid-template-columns: minmax(0, 1fr);
    overflow-y: auto;
    min-height: 0;
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
    flex-shrink: 0;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: space-between;
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

  .sidebar-toggle { margin-left: auto; }
  .collapsed .sidebar-toggle { margin: auto; }
  .collapsed .shell-links { flex-direction: column; align-items: center; }

  .collapsed nav a, .collapsed .shell-links a {
    justify-content: center;
    padding: 0;
  }

  .collapsed aside span {
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
    grid-column: 2;
    min-width: 0;
    padding: var(--ss-space-3);
  }

  .route-content.connecting { display: flex; flex-direction: column; }
  .connection-loading { flex: 1; display: grid; place-items: center; min-width: 0; }
  .route-page { display: contents; }
  .route-page[hidden] { display: none; }

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

  .grain-toolbar { flex: 1; min-width: 0; padding: 0 var(--ss-space-3); }
  .brand-group { flex: 0 0 11.25rem; }
  .workspace { padding: 0; height: calc(100dvh - var(--ss-header-height)); display: flex; flex-direction: column; }
  .workspace > :global(.grain-view:not([hidden])), .workspace > :global(.shared-view:not([hidden])) { flex: 1; min-height: 0; }
  .open-grains { list-style: none; padding: 0; margin: 0; }
  .open-grains li { display: flex; align-items: center; min-width: 0; position: relative; }
  .open-grains li.current { background: var(--ss-chrome-selected); }
  .open-grains a { flex: 1; min-width: 0; font-weight: 400; font-size: .8125rem; padding-left: var(--ss-space-3); padding-right: 0; }
  .close-grain { flex: none; opacity: 0; }
  .open-grains li:hover .close-grain, .open-grains li:focus-within .close-grain { opacity: 1; }
  .collapsed .open-grains li { flex-wrap: wrap; }
  .collapsed .open-grains a { flex-basis: 100%; }
  .collapsed .close-grain { display: none; margin: auto; }
  .collapsed .open-grains li:hover .close-grain, .collapsed .open-grains li:focus-within .close-grain { display: block; }
  @media (hover: none) {
    .close-grain { opacity: 1; }
    .collapsed .open-grains li { flex-wrap: wrap; }
    .collapsed .open-grains a { flex-basis: 100%; }
    .collapsed .close-grain { display: block; }
  }
  .open-grains span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 1000px) {
    header.has-grain { flex-wrap: wrap; }
    .has-grain .grain-toolbar { order: 3; flex-basis: 100%; padding: var(--ss-space-2) 0; }
  }
  @media (max-width: 600px) {
    .shell-layout, .shell-layout.collapsed { grid-template-columns: 3.5rem minmax(0, 1fr); }
    aside { z-index: var(--ss-layer-chrome); }
    .shell-layout:not(.collapsed) aside { position: fixed; width: 13rem; bottom: 0; }
    header { padding: 0 var(--ss-space-2); }
    .brand-group { flex-basis: auto; }
    .brand { font-size: 1rem; }
    .route-content:not(.workspace) { padding: var(--ss-space-2); }
  }
</style>

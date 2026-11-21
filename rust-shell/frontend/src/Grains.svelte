<script lang="ts">
  import { onDestroy } from 'svelte';
  let alive=true;
  onDestroy(()=>{alive=false;});
  import Modal from './components/ui/Modal.svelte';
  import { applicationErrorMessage } from './lib/results';
  import type { GrainOperation } from './lib/grain-management';
  import type { Grain } from './lib/model';
  import Pagination from './components/ui/Pagination.svelte';
  import LoadingStatus from './components/ui/LoadingStatus.svelte';
  import GrainIcon from './components/ui/GrainIcon.svelte';
  import Button from './components/ui/Button.svelte';
  import TextInput from './components/ui/TextInput.svelte';
  import NativeSelect from './components/ui/NativeSelect.svelte';
  import Panel from './components/ui/Panel.svelte';
  import type { ShellState, ShellService } from './lib/shell';
  import { rememberRoute, grainRoute } from './lib/router';
  let { model: base, service, navigate, appId='', trash=false }: { model: ShellState; service: ShellService; navigate: (path: string) => void; appId?:string; trash?:boolean } = $props();
  let selected = $state<string[]>([]);
  let working = $state(false);
  let actionError = $state('');
  let notice = $state('');
  let confirming = $state(false);
  let deletion = $state<Grain[]>([]);
  let deletionAccount = $state<string | null>(null);
  let deleteTrigger=$state<HTMLElement>();
  function toggle(id:string,checked:boolean) { selected=checked?[...selected,id]:selected.filter(key=>key!==id); }
  async function change(operation:GrainOperation, ids=selected.slice(), account=accountKey) {
    if (working || !ids.length) return;
    working=true;actionError='';notice='';
    let completed=0;
    try {
      for (const id of ids) {
        if (!alive || account !== base.accountKey || base.status !== 'ready') throw new Error('Connection or account changed. Remaining grains were not changed.');
        await service.manageGrain(id,operation);
        completed++;
        if (account === base.accountKey) selected=selected.filter(key=>key!==id);
      }
    } catch (error) {
      if (account === base.accountKey) actionError=applicationErrorMessage(error,'Could not confirm the action. Check the list before trying again.');
    } finally {
      working=false;confirming=false;
      if (account === base.accountKey && completed) notice=`${completed} ${completed===1?'grain':'grains'} ${operation==='trash'?'moved to Trash':operation==='restore'?'restored':'permanently removed'}.`;
    }
  }
  let search = $state('');
  let sort = $state('recent');
  let ownership = $state('all');
  const accountKey=$derived(base.accountKey);
  const status=$derived(base.status);
  const fixture=$derived(base.fixture);
  let page=$state(0);
  let rows=$state<Grain[]|null>(null);
  let more=$state(false);
  let pending=$state(false);
  let queryError=$state('');
  const model=$derived({...base,grains:rows ?? (trash ? [] : base.grains),grainPage:page,grainsLimited:rows===null?base.grainsLimited:more,paging:pending});
  $effect(()=>{search;sort;ownership;appId;trash;accountKey;page=0;selected=[];confirming=false;actionError='';notice='';});
  $effect(()=>{
    if(status!=='ready' || fixture){rows=null;return;}
    const query={page,search,appId,trash,sort:sort==='title'?'title' as const:'recent' as const,ownership:ownership==='owned'?'owned' as const:ownership==='shared'?'shared' as const:'all' as const};
    let active=true;pending=true;rows=[];queryError='';
    const stop=service.watchGrains(query,(grains,limited)=>{if(active){rows=grains;more=limited;pending=false;}},(error)=>{if(active){pending=false;queryError=error instanceof Error ? error.message : 'Could not update the grain list. Please reconnect.';}});
    return ()=>{active=false;stop();};
  });
  const visibleGrains = $derived(model.grains.filter((grain) =>
    (ownership === 'all' || grain.owned === (ownership === 'owned')) &&
    `${grain.title} ${grain.appTitle}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
    .sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) || a.key.localeCompare(b.key)
      : b.lastUsed.localeCompare(a.lastUsed) || a.title.localeCompare(b.title) || a.key.localeCompare(b.key)));
  function openGrain(event: MouseEvent, id: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(grainRoute(id));
  }
  const allSelected=$derived(visibleGrains.length>0 && visibleGrains.every(grain=>selected.includes(grain.key)));
  const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  $effect(()=>{page;selected=[];});
</script>
  <Panel aria-label={trash ? "Trash" : "Grains"} padded={model.status !== 'ready' || model.fixture}>

    {#if model.status === 'signed-out'}
      <p><a href="/login" onclick={rememberRoute}>Sign in with Sandstorm</a> to see your grains.</p>
    {:else if model.status !== 'ready'}
      {#if model.status === 'stopped'}<p>Disconnected from Sandstorm.</p>
      {:else}
        <LoadingStatus label={model.status === 'waiting' ? 'Waiting for Sandstorm…' : model.status === 'reconnecting' ? 'Reconnecting…' : 'Loading your grains…'}
          detail={model.status === 'waiting' ? 'Your login and grain list will be checked when the server returns.' : ''} />
        <div class="grain-skeleton" aria-hidden="true">{#each [0, 1, 2, 3, 4] as row}<div class="skeleton-row"><span class="skeleton-icon"></span><span class="skeleton-title" style:width={`${48 - row * 5}%`}></span><span class="skeleton-meta"></span></div>{/each}</div>
      {/if}
      {#if model.status !== 'connecting'}<Button variant="secondary" onclick={() => service.reconnect()}>Reconnect</Button>{/if}
    {:else if model.fixture}
      <p class="empty">Connect to an installed Sandstorm server to see real grains.</p>
    {:else}
      {#if queryError}<p role="alert">{queryError}</p>{/if}
      <div class="grain-controls">
      <div class="search"><label class="sr-only" for="grain-search">Filter shown grains</label>
      <TextInput id="grain-search" type="search" bind:value={search} placeholder="Search by title or app" /></div>
        <div><label for="grain-ownership">Show</label><NativeSelect id="grain-ownership" bind:value={ownership}><option value="all">All grains</option><option value="owned">Owned by you</option><option value="shared">Shared with you</option></NativeSelect></div>
        <div><label for="grain-sort">Sort by</label><NativeSelect id="grain-sort" bind:value={sort}><option value="recent">Recent use</option><option value="title">Title</option></NativeSelect></div>
      </div>
      <div class="bulk-actions">
        <span>{selected.length} selected</span>
        {#if trash}
          <Button variant="secondary" disabled={working || !selected.length} onclick={() => change('restore')}>Restore</Button>
          <Button variant="danger" disabled={working || !selected.length} onclick={event => {deleteTrigger=event.currentTarget;deletionAccount=accountKey;deletion=visibleGrains.filter(grain=>selected.includes(grain.key));confirming=true;}}>Delete permanently</Button>
        {:else}<Button variant="secondary" disabled={working || !selected.length} onclick={() => change('trash')}>Move to Trash</Button>{/if}
        {#if working}<span role="status">Updating grains…</span>{/if}
      </div>
      {#if actionError}<p role="alert">{actionError}</p>{/if}
      {#if notice}<p role="status">{notice}</p>{/if}
      {#if trash}<p class="trash-help">Deleting owned grains permanently removes their data. Deleting shared grains only forgets your access.</p>{/if}
      <p class="result-count" role="status">{visibleGrains.length} {visibleGrains.length === 1 ? 'grain' : 'grains'}{search || ownership !== 'all' ? ` matching your filters · ${model.grains.length} loaded` : ''}</p>
      {#if pending && !visibleGrains.length}<LoadingStatus label={trash ? 'Loading Trash…' : 'Loading grains…'} />{/if}
      {#if !pending && visibleGrains.length === 0}<p class="empty">{search || ownership !== 'all' ? 'No matching grains.' : trash ? 'Trash is empty.' : 'You have no grains to show.'}</p>{/if}
      {#if visibleGrains.length}
      <div class="table-scroll">
        <table aria-label="Grains">
          <colgroup><col class="select-column" /><col class="name-column" /><col class="app-column" /><col class="access-column" /><col class="date-column" /></colgroup>
          <thead><tr><th scope="col"><input type="checkbox" aria-label="Select all shown grains" checked={allSelected} disabled={working} onchange={event=>{selected=event.currentTarget.checked?visibleGrains.map(grain=>grain.key):[];}} /></th><th scope="col">Name</th><th scope="col">App</th><th scope="col">Access</th><th scope="col" class="last-used">Last used</th></tr></thead>
          <tbody>
            {#each visibleGrains as grain (grain.key)}
              <tr class="grain-item">
                <td><input type="checkbox" aria-label={`Select ${grain.title}`} checked={selected.includes(grain.key)} disabled={working} onchange={event=>toggle(grain.key,event.currentTarget.checked)} /></td>
                <td>{#if trash}<span class="grain-name"><GrainIcon src={grain.iconSrc} /><span>{grain.title}</span></span>{:else}<a class="grain-name" href={grainRoute(grain.key)} onclick={event => openGrain(event, grain.key)} title={grain.title}>
                  <GrainIcon src={grain.iconSrc} /><span>{grain.title}</span>
                </a>{/if}</td>
                <td class="app-name"><span title={grain.appTitle}>{grain.appTitle || 'Unknown app'}</span></td>
                <td><span class="access" class:shared={!grain.owned}>{grain.owned ? 'Owned by you' : 'Shared with you'}</span></td>
                <td class="last-used">{#if grain.lastUsed}<time datetime={grain.lastUsed} title={new Date(grain.lastUsed).toLocaleString()}>{dateFormat.format(new Date(grain.lastUsed))}</time>{:else}<span aria-label="Never used">—</span>{/if}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {/if}
      <Pagination page={model.grainPage} more={model.grainsLimited} busy={model.paging} label="Grains" change={value => page=value} />
    {/if}
    {#if model.openingGrain}<p role="status">Opening grain…</p>{/if}
  </Panel>
{#if confirming}
  <Modal bind:open={confirming} title="Delete permanently?" description="This cannot be undone. Owned grains and their data will be deleted. Shared grains will be removed from your list; their owner's data is kept." returnFocus={deleteTrigger} busy={working}>
    <ul>{#each deletion as grain (grain.key)}<li>{grain.title} — {grain.owned ? 'Delete data' : 'Forget access'}</li>{/each}</ul>
    <div class="bulk-actions"><Button variant="danger" disabled={working || !deletion.length} onclick={()=>change('remove',deletion.map(grain=>grain.key),deletionAccount)}>Confirm permanent deletion</Button><Button variant="secondary" disabled={working} onclick={()=>confirming=false}>Cancel</Button></div>
  </Modal>
{/if}
<style>
  .bulk-actions { display:flex; align-items:center; gap:var(--ss-space-2); margin:var(--ss-space-3); font-size:var(--ss-text-small); }
  .select-column { width:2.75rem; }
  input[type=checkbox] { accent-color:var(--ss-brand); }
  .trash-help { color:var(--ss-muted); font-size:var(--ss-text-small); }
  .grain-skeleton { margin-bottom: var(--ss-space-4); }
  .skeleton-row { display: flex; align-items: center; gap: var(--ss-space-3); height: 2.875rem; border-top: 1px solid var(--ss-canvas); }
  .skeleton-row span { height: .65rem; background: var(--ss-canvas); border-radius: var(--ss-radius-control); }
  .skeleton-row .skeleton-icon { width: 1.25rem; height: 1.25rem; }
  .skeleton-meta { width: 18%; margin-left: auto; }

  a { color: var(--ss-brand); text-underline-offset: .2em; }
  a:focus-visible { outline: 3px solid var(--ss-focus); outline-offset: 3px; }
  .grain-controls { display: flex; flex-wrap: wrap; align-items: end; gap: var(--ss-space-3); margin: var(--ss-space-3); --ss-control-height: 2.375rem; font-size: var(--ss-text-small); }
  .search { flex: 1 1 15rem; }
  label:not(.sr-only) { display: block; margin-bottom: var(--ss-space-1); color: var(--ss-muted); font-size: .75rem; font-weight: 600; }
  .result-count { margin: var(--ss-space-3); color: var(--ss-muted); font-size: .75rem; }
  p:not(.result-count) { margin-inline: var(--ss-space-3); }
  .empty { color: var(--ss-muted); padding: var(--ss-space-5) 0; }
  /* Keep the heading in the page scroll context, below the shell topbar. */
  .table-scroll { overflow: visible; }
  table { width: 100%; min-width: 0; border-collapse: collapse; table-layout: fixed; font-size: var(--ss-text-small); }
  .name-column { width: calc(44% - 2.75rem); }
  .app-column { width: 22%; }
  .access-column { width: 18%; }
  .date-column { width: 16%; }
  th { position: sticky; top: var(--ss-header-height); z-index: 1; box-shadow: inset 0 1px var(--ss-border), inset 0 -1px var(--ss-border); padding: .5rem .75rem; text-align: left; color: var(--ss-muted); background: var(--ss-canvas); border-block: 1px solid var(--ss-border); font-size: .6875rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
  td { padding: .7rem .75rem; border-bottom: 1px solid color-mix(in srgb, var(--ss-border) 45%, var(--ss-surface)); vertical-align: middle; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover, tbody tr:focus-within { background: var(--ss-brand-subtle); }
  .grain-name { display: flex; align-items: center; gap: .65rem; min-width: 0; color: var(--ss-text); text-decoration: none; font-weight: 600; }
  .grain-name:hover { color: var(--ss-brand); }
  .grain-name:hover span { text-decoration: underline; text-underline-offset: .2em; }
  .grain-name span, .app-name span { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .app-name { color: var(--ss-muted); }
  .access { display: inline-block; font-size: .75rem; color: var(--ss-muted); white-space: nowrap; }
  .access.shared { color: var(--ss-brand); }
  .last-used { text-align: right; white-space: nowrap; }
  td.last-used { color: var(--ss-muted); font-size: .75rem; font-variant-numeric: tabular-nums; }
  @media (max-width: 700px) {
    .search { flex-basis: 100%; }
    th, td { padding-inline: .5rem; }
    .access, .last-used { white-space: normal; overflow-wrap: anywhere; }
    .name-column { width: calc(38% - 2.75rem); }
    .access-column { width: 22%; }
    .date-column { width: 18%; }
  }
</style>

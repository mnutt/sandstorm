<script lang="ts">
  import Avatar from './components/ui/Avatar.svelte';
  import { onMount, untrack } from 'svelte';
  import { Conn } from 'capnp-es';
  import { SharedShell, type SharedShell$Client, type SharedSession$Client } from './generated/shell';
  import { WebSocketTransport } from './lib/transport';
  import { runOperation, errorMessage } from './lib/operations';
  import type { ActiveGrain } from './lib/model';
  import { rememberRoute } from './lib/router';
  import LoadingStatus from './components/ui/LoadingStatus.svelte';
  import GrainFrame from './GrainFrame.svelte';
  import Panel from './components/ui/Panel.svelte';
  import Button from './components/ui/Button.svelte';
  let { webkey, path, active, toolbarTarget, accountKey, pathChanged, metadataChanged }:
    {webkey:string;path:string;active:boolean;toolbarTarget:HTMLElement;accountKey:string|null;
      pathChanged:(path:string)=>void;metadataChanged:(title:string,iconSrc:string)=>void} = $props();
  let phase = $state<'loading'|'choice'|'opening'|'open'|'error'>('loading');
  let info = $state({title:'Shared grain',signedIn:false,guestsAllowed:false,accountName:'',accountPictureUrl:''});
  let grain = $state<ActiveGrain|null>(null);
  let error = $state('');
  let connection: Conn | undefined;
  let socket: WebSocket | undefined;
  let client: SharedShell$Client | undefined;
  let session: SharedSession$Client | undefined;
  let lifetime = new AbortController();
  let generation = 0;
  let selectedAccount = untrack(() => accountKey);
  $effect(() => {
    if (accountKey !== selectedAccount) {
      selectedAccount = accountKey;
      fail('The signed-in account changed. Reopen this sharing link to choose how to view it.');
    }
  });
  function clear() {
    ++generation;
    lifetime.abort();
    lifetime = new AbortController();
    grain = null;
    try { session?.client.close(); } catch { /* disconnected */ }
    session = undefined; client = undefined;
    connection?.shutdown(); connection = undefined;
    if (socket) { socket.onopen = socket.onerror = socket.onclose = null; socket.close(); socket = undefined; }
  }
  function fail(message: string) { clear(); error = message; phase = 'error'; }
  async function start() {
    clear(); phase = 'loading'; error = '';
    const current = generation;
    const url = new URL('/shared-rpc',location.href); url.protocol = 'wss:';
    const ws = socket = new WebSocket(url);
    const failed = () => { if (generation === current) fail('Shared session ended or access was revoked. Reopen to check access again.'); };
    ws.onerror = ws.onclose = failed;
    try {
      await runOperation(new Promise<void>((resolve,reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('Unable to connect to the shared viewer.'));
      }), 'Connect shared viewer', {signal:lifetime.signal});
      if (current !== generation) return;
      connection = new Conn(new WebSocketTransport(ws,failed));
      connection.onError = failed;
      client = connection.bootstrap(SharedShell);
      const result = await runOperation(client.inspect(params => {params.webkey=webkey;}).promise(), 'Check sharing link', {signal:lifetime.signal});
      if (current !== generation) return;
      info = {title:result.info.title,signedIn:result.info.signedIn,guestsAllowed:result.info.guestsAllowed,accountName:result.info.accountName,accountPictureUrl:result.info.accountPictureUrl};
      metadataChanged(info.title, '');
      phase = 'choice';
      if (!info.signedIn && info.guestsAllowed) await open(false);
    } catch (err) { if (current === generation) fail(errorMessage(err)); }
  }
  async function open(revealIdentity:boolean) {
    if (phase !== 'choice' || !client) return;
    phase = 'opening';
    const current = generation;
    try {
      const result = await runOperation(client.open(params => {params.webkey=webkey;params.revealIdentity=revealIdentity;}).promise(),
        'Open shared grain', {signal:lifetime.signal,onLateResult:result => {result.session.client.close();}});
      if (current !== generation) {result.session.client.close();return;}
      session = result.session;
      const url = new URL(result.view.url);
      if (url.origin !== result.view.origin || url.protocol !== 'https:' || url.username || url.password || url.origin === location.origin) throw new Error('Invalid shared grain origin.');
      url.searchParams.set('path',path);
      grain = {grainId:result.view.grainId,path,url:url.href,origin:result.view.origin,title:result.view.title || info.title,
        ownerTitle:result.view.ownerTitle,iconSrc:result.view.iconSrc,mainHref:result.view.mainHref};
      metadataChanged(grain.title, grain.iconSrc);
      phase = 'open';
    } catch (err) {if (current === generation) fail(errorMessage(err));}
  }
  onMount(() => {void start();return clear;});
</script>
<div class="shared-view" hidden={!active}>
  {#if grain}
    <GrainFrame {grain} {active} {toolbarTarget} {pathChanged} canManage={false}
      rename={async () => {throw new Error('Shared-link views cannot rename grains.');}}
      renderTemplate={async () => {throw new Error('API templates are not available in shared-link views.');}} />
  {:else}
    <div class="shared-message"><Panel>
      <h2>{info.title}</h2>
      {#if phase === 'loading' || phase === 'opening'}<LoadingStatus label={phase === 'loading' ? 'Checking sharing link…' : 'Opening shared grain…'} />
      {:else if phase === 'error'}<p role="alert">{error}</p><Button onclick={start}>Reopen sharing link</Button>
      {:else}
        {#if info.signedIn}
          <p>Choose whether this app can see your Sandstorm identity. Access remains limited to this sharing link.</p>
          <div class="choices"><Button onclick={() => open(true)}><Avatar name={info.accountName} src={info.accountPictureUrl} /> Open as {info.accountName}</Button>
            {#if info.guestsAllowed}<Button variant="secondary" onclick={() => open(false)}>Open anonymously</Button>{/if}</div>
        {:else}<p>This server requires you to sign in before viewing shared grains.</p><a href="/login" onclick={rememberRoute}>Sign in with Sandstorm</a>{/if}
      {/if}
    </Panel></div>
  {/if}
</div>
<style>
  .shared-view { height:100%; min-height:0; display:flex; flex-direction:column; }
  .shared-view[hidden] {display:none;}
  .shared-view > :global(.grain-view) {flex:1;min-height:0;}
  .shared-message {padding:var(--ss-space-3);}
  .choices {display:flex;gap:var(--ss-space-3);flex-wrap:wrap;}
  h2 {margin:0;font-size:var(--ss-text-title);}
  a {color:var(--ss-brand);}
</style>

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { get } from 'node:https';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { httpsProxy } from './https-harness.mjs';
import { start, stop, availablePort } from './harness.mjs';

test('HTTPS dev proxy preserves RPC, strips credentials, and hot-reloads Svelte without losing state', {timeout:60000}, async () => {
  const directory = await mkdtemp(join(tmpdir(),'rust-shell-dev-'));
  const root = fileURLToPath(new URL('..',import.meta.url));
  const fixture = await mkdtemp(join(root,'src','.hmr-test-'));
  const route = '/src/'+fixture.split('/').pop();
  let vite, proxy, rust, browser;
  let receivedHeaders;
  try {
    await writeFile(join(fixture,'index.html'),'<div id="app"></div><script type="module" src="./main.ts"></script>');
    await writeFile(join(fixture,'main.ts'),"import { mount } from 'svelte'; import Counter from './Counter.svelte'; mount(Counter,{target:document.getElementById('app')!});");
    const component = color => `<script>let count = $state(0);</script><button onclick={() => count++}>Count {count}</button><style>button {color:${color}}</style>`;
    await writeFile(join(fixture,'Counter.svelte'),component('rgb(255, 0, 0)'));
    vite = await createServer({root,configFile:join(root,'vite.config.ts'),logLevel:'silent',server:{host:'127.0.0.1',port:await availablePort()},
      plugins:[{name:'proxy-test',configureServer(server) { server.middlewares.use((req,res,next)=> {
        if (req.url === '/src/proxy-headers') { receivedHeaders=req.headers;res.end('headers checked');return; }
        next();
      }); }}]});
    await vite.listen();
    const port=vite.httpServer.address().port;
    proxy=await httpsProxy(directory,join(directory,'rust.sock'));
    rust=(await start('debug/sandstorm-rust-shell',[],{
      RUST_SHELL_SOCKET:join(directory,'rust.sock'),RUST_SHELL_ORIGIN:proxy.origin,
      RUST_SHELL_BRIDGE_SOCKET:'',RUST_SHELL_DEV_PORT:String(port),
    },/Rust shell: (https:\/\/\S+)/)).child;
    browser=await chromium.launch({executablePath:process.env.CHROMIUM || '/usr/bin/chromium',
      args:[`--ignore-certificate-errors-spki-list=${proxy.pin}`]});
    const context=await browser.newContext({ignoreHTTPSErrors:true});
    const page=await context.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const hmr=page.waitForEvent('websocket',socket=>socket.url().includes('/__vite_hmr'));
    await page.goto(proxy.origin+route+'/index.html');
    const hmrSocket = await hmr;
    await page.getByRole('button',{name:'Count 0'}).click();
    await expect(page.getByRole('button',{name:'Count 1'})).toHaveCSS('color','rgb(255, 0, 0)');
    await page.evaluate(()=>window.testDocument=crypto.randomUUID());
    const documentId=await page.evaluate(()=>window.testDocument);
    await writeFile(join(fixture,'Counter.svelte'),component('rgb(0, 0, 255)'));
    await expect(page.getByRole('button',{name:'Count 1'})).toHaveCSS('color','rgb(0, 0, 255)');
    assert.equal(await page.evaluate(()=>window.testDocument),documentId,'HMR must not reload the document');
    const headersResponse=await page.request.get(proxy.origin+'/src/proxy-headers',{headers:{Cookie:'private=do-not-forward',Authorization:'Bearer do-not-forward'}});
    assert.equal(headersResponse.status(),200);
    assert.equal(receivedHeaders.cookie,undefined); assert.equal(receivedHeaders.authorization,undefined);
    assert.equal(receivedHeaders.host,`127.0.0.1:${port}`);
    assert.deepEqual(await (await page.request.get(proxy.origin+'/auth/session')).json(),{fixture:true,account:null});
    assert.equal((await page.request.get(proxy.origin+'/__open-in-editor?file=/etc/passwd')).status(),404);
    assert.equal((await page.request.post(proxy.origin+'/src/proxy-headers')).status(),405);
    // Use raw HTTP paths: browser URL parsing would remove these dot segments first.
    for (const path of ['/src/../__open-in-editor', '/src/%2e%2e/__open-in-editor']) {
      const status = await new Promise((resolve, reject) => {
        const request = get(proxy.origin, {path, rejectUnauthorized:false}, response => {
          response.resume();
          resolve(response.statusCode);
        });
        request.on('error', reject);
      });
      assert.equal(status,404,`Reject normalized path: ${path}`);
    }
    assert.equal((await page.request.get(proxy.origin+'/@fs/etc/passwd')).status(),403);
    const template=await (await page.request.get(proxy.origin+'/offer-template.html')).text();
    assert.ok(!template.includes('/@vite/client'),'Isolated template remains unmodified');
    const rejected=await page.evaluate(async origin=>await new Promise(resolve=>{
      const ws=new WebSocket(origin.replace('https:','wss:')+'/__vite_hmr?token=invalid','vite-hmr');
      ws.onerror=()=>resolve(true);ws.onopen=()=>{ws.close();resolve(false);};
    }),proxy.origin);
    assert.equal(rejected,true,'Vite token checks remain active');
    const foreign = await context.newPage();
    await foreign.route('https://foreign.test/**',route=>route.fulfill({contentType:'text/html',body:'Foreign origin'}));
    await foreign.goto('https://foreign.test/');
    assert.equal(await foreign.evaluate(url=>new Promise(resolve=>{
      const ws=new WebSocket(url,'vite-hmr');
      ws.onerror=()=>resolve(true); ws.onopen=()=>{ws.close();resolve(false);};
    }),hmrSocket.url()),true,'Foreign origins cannot use even a valid Vite token');
    await foreign.close();
    assert.equal((await page.request.get(proxy.origin+'/src/proxy-headers',{headers:{Host:'foreign.test'}})).status(),403);
    // Load the actual shell through Vite and exercise the unchanged Rust RPC route.
    await page.goto(proxy.origin+'/notifications');
    await page.getByRole('heading',{name:'Welcome to the Rust shell'}).waitFor();
    await page.getByRole('button',{name:'Add test notification'}).click();
    await page.getByRole('heading',{name:'Test notification 2'}).waitFor();
    assert.deepEqual(errors,[]);
    await vite.close();vite=null;
    assert.equal((await page.request.get(proxy.origin+'/apps')).status(),503);
    assert.equal((await page.request.get(proxy.origin+'/auth/session')).status(),200);
    const recovered = page.waitForEvent('framenavigated',frame=>frame===page.mainFrame());
    vite=await createServer({root,configFile:join(root,'vite.config.ts'),logLevel:'silent',server:{host:'127.0.0.1',port}});
    await vite.listen();
    await recovered;
    await page.getByRole('heading',{name:'Welcome to the Rust shell'}).waitFor();
    assert.deepEqual(errors,[]);

  } finally {
    await browser?.close(); await stop(rust); await proxy?.close(); await vite?.close();
    await rm(fixture,{recursive:true,force:true});await rm(directory,{recursive:true,force:true});
  }
});

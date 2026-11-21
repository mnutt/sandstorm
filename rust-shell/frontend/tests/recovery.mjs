// Installed-server recovery gate. Called only by tests/tests/rust-recovery.js.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, appendFile, realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash, X509Certificate} from 'node:crypto';
import {chromium, expect} from '@playwright/test';
const exec = promisify(execFile);
const mainOrigin = 'https://local.sandstorm.io:9443';
const origin = 'https://local.sandstorm.io:9444';

async function isolated(directory) {
  assert.equal(process.env.RUN_RUST_RECOVERY, '1');
  assert.equal(await realpath(directory), fileURLToPath(new URL('../../../tests/tmp-sandstorm',import.meta.url)));
  assert.match(await readFile(join(directory,'sandstorm.conf'),'utf8'), /^IS_TESTING=true$/m);
}
export async function prepareRecovery(directory) {
  await isolated(directory);
  const key = join(directory,'recovery-key.pem'), cert = join(directory,'recovery-cert.pem');
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=local.sandstorm.io',
    '-addext','subjectAltName=DNS:local.sandstorm.io,DNS:*.local.sandstorm.io','-keyout',key,'-out',cert]);
  return {key:await readFile(key,'utf8'),certChain:await readFile(cert,'utf8')};
}
export async function runRecovery(directory, bundle, grainId, meteorToken, keys) {
  await isolated(directory);
  assert.ok(bundle && grainId && meteorToken);
  const control = (...args) => exec(join(directory,'sandstorm'),args,{timeout:120000});
  await appendFile(join(directory,'sandstorm.conf'),`\nHTTPS_PORT=9443\nBASE_URL=${mainOrigin}\nWILDCARD_HOST=*.local.sandstorm.io:9443\nRUST_SHELL_PORT=9444\nRUST_SHELL_BIND_IP=127.0.0.1\n`);
  await control('restart');
  const pin=createHash('sha256').update(new X509Certificate(keys.certChain).publicKey.export({type:'spki',format:'der'})).digest('base64');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM || '/usr/bin/chromium',headless:true,args:['--no-sandbox',`--ignore-certificate-errors-spki-list=${pin}`,
    '--host-resolver-rules=MAP local.sandstorm.io 127.0.0.1,MAP *.local.sandstorm.io 127.0.0.1']});
  let page;
  try {
    const context=await browser.newContext({ignoreHTTPSErrors:true});
    const ready=async()=>expect.poll(async()=>{
      try {return (await context.request.get(origin+'/auth/options',{timeout:2000})).status();} catch {return 0;}
    },{timeout:90000,intervals:[500,1000]}).toBe(200);
    await ready();
    page=await context.newPage();
    await page.goto(origin+'/login');
    await page.getByRole('button',{name:'Alice (admin)',exact:true}).click();
    await expect(page.locator('.account-name')).toHaveText(/Alice/,{timeout:30000});
    const cookie=()=>context.cookies().then(cookies=>cookies.find(c=>c.name==='__Host-sandstorm-rust-session')?.value);
    const login=await cookie();assert.ok(login);
    await page.goto(origin+'/grain/'+grainId);
    const app=()=>page.frameLocator('iframe').locator('#do-test-system-api');
    await app().waitFor({timeout:30000});
    await page.getByRole('button',{name:'Download backup',exact:true}).click();
    const backupDialog=page.getByRole('dialog',{name:'Download backup',exact:true});
    const downloadLink=backupDialog.getByRole('link',{name:'Download ZIP',exact:true});
    await downloadLink.waitFor({timeout:90000});
    const downloadUrl=new URL(await downloadLink.getAttribute('href'),origin).href;
    assert.equal(new URL(downloadUrl).origin,origin);
    const downloadEvent=page.waitForEvent('download');
    await downloadLink.click();
    const download=await downloadEvent;
    const archive=await readFile(await download.path());
    assert.equal(archive.subarray(0,2).toString(),'PK');
    assert.match(download.suggestedFilename(),/\.zip$/);
    assert.equal((await context.request.get(downloadUrl)).status(),404);
    await app().waitFor();
    console.log('Verified installed Rust backup endpoint: ZIP download, one-use token, app session preserved');
    const legacy=await context.newPage();
    await legacy.goto(mainOrigin);
    await legacy.waitForFunction(()=>globalThis.Meteor?.loginWithToken);
    await legacy.evaluate(token=>new Promise((resolve,reject)=>Meteor.loginWithToken(token,error=>error?reject(error):resolve())),meteorToken);
    for (const action of ['restart','update']) {
      const previous=await page.locator('iframe').getAttribute('src');
      await control(...(action==='update'?['update',bundle]:['restart']));
      await expect(page.locator('iframe')).toHaveCount(0,{timeout:30000});
      await ready();
      await page.getByRole('button',{name:'Reopen grain',exact:true}).waitFor({timeout:90000});
      assert.equal(await cookie(),login,action+' preserves the login cookie');
      assert.equal(new URL(page.url()).pathname,'/grain/'+grainId);
      await expect(page.locator('iframe')).toHaveCount(0);
      await page.getByRole('button',{name:'Reopen grain',exact:true}).click();
      await app().waitFor({timeout:30000});
      assert.notEqual(await page.locator('iframe').getAttribute('src'),previous,'reopen creates a fresh lease');
      // A live legacy write proves the restarted Mongo observer reached the
      // existing Rust browser, rather than merely rendering a cached snapshot.
      await legacy.waitForFunction(()=>Meteor.status().connected && Meteor.userId(),{},{timeout:90000});
      const title='Recovered after '+action;
      await legacy.evaluate(({grainId,title})=>Meteor.callAsync('updateGrainTitle',grainId,title),{grainId,title});
      await expect(page.locator('.grain-title h2')).toHaveText(title);
      await page.getByRole('link',{name:'Grains',exact:true}).click();
      await expect(page.locator('.grain-name').filter({hasText:title})).toBeVisible();
      await page.locator('.grain-name').filter({hasText:title}).click();
      await app().waitFor();
      await page.reload();
      await app().waitFor({timeout:30000});
      assert.equal(await cookie(),login,'reload after '+action+' preserves login');
      console.log('Verified installed '+action+': login, fresh grain lease, live list/title updates, reload');
    }
  } catch (error) {
    if (page) console.error('Recovery page:',await page.locator('body').innerText().catch(()=>'(unavailable)'));
    throw error;
  } finally {await browser.close();}
}

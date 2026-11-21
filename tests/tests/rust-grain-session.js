"use strict";
const utils = require('../utils');

function operation(browser, action, embed, path = '/') {
  browser.frame(null).executeAsync(function (action, embed, path, done) {
    const grainId = window.location.pathname.split('/')[2];
    Meteor.call('testRustGrainSession', action, grainId, function (error, result) {
      if (!error && embed) {
        document.getElementById('rust-session-test')?.remove();
        const frame = document.createElement('iframe');
        frame.id = 'rust-session-test';
        const target = new URL(result.url); target.searchParams.set('path', path);
        frame.src = target.href;
        frame.style = 'position:fixed;inset:0;width:100%;height:100%;z-index:99999;background:white';
        document.body.appendChild(frame);
      }
      done({ error: error?.message, ok: !!result });
    });
  }, [action, embed, path], function (result) {
    browser.assert.equal(result.value.error, null, action + ' UI session succeeded');
    browser.assert.equal(result.value.ok, true);
  });
}

module.exports['Real grain iframe session, close/reopen, shared access and revocation'] = function (browser) {
  browser.loginDevAccount().uploadTestApp().timeouts('script', 30000).grainFrame()
    .waitForElementPresent('#do-test-system-api', utils.medium_wait).frame(null);
  operation(browser, 'open', true, '/?restored=1#section');
  browser.frameSelector('#rust-session-test').waitForElementPresent('body', utils.medium_wait);
  browser.execute(function () { return location.search + location.hash; }, [], result => {
    browser.assert.equal(result.value, '?restored=1#section', 'gateway restores the requested app query and fragment');
  });
  // The test app deliberately serves only the literal root path, without a query.
  browser.execute(function () { location.replace('/'); })
    .waitForElementPresent('#do-test-system-api', utils.medium_wait);
  operation(browser, 'restart');
  browser.execute(function () {
    const frame = document.getElementById('rust-session-test');
    const target = new URL(frame.src); target.searchParams.set('path', '/');
    frame.src = target.href;
  }).frameSelector('#rust-session-test').waitForElementPresent('#do-test-system-api', utils.medium_wait).frame(null);
  // Exercise the actual Meteor chooser against the leased session. This isolated
  // server uses the main origin as the simulated Rust opener; the HTTPS browser
  // suite separately verifies the cross-origin handoff.
  operation(browser, 'enablePowerbox');
  browser.execute(function () {
    const frame = document.getElementById('rust-session-test');
    const sessionId = new URL(frame.src).searchParams.get('sessionid');
    window.rustPowerboxTestListener = event => {
      if (event.source === frame.contentWindow && event.data.powerboxRequest) {
        window.rustPowerboxTestRequest = event.data.powerboxRequest;
      }
      const popup = window.rustPowerboxTestPopup;
      if (!popup || event.source !== popup || event.origin !== location.origin) return;
      if (event.data.type === 'rust-powerbox-ready') {
        popup.postMessage({type:'rust-powerbox-request', nonce:'test-nonce', sessionId,
          request:window.rustPowerboxTestRequest}, location.origin);
      } else if (event.data.type === 'rust-powerbox-result') {
        window.rustPowerboxTestResult = event.data.result;
        frame.contentWindow.postMessage(event.data.result, new URL(frame.src).origin);
      }
    };
    addEventListener('message', window.rustPowerboxTestListener);
  }).frameSelector('#rust-session-test').click('#do-powerbox-request').frame(null)
    .executeAsync(function (done) {
      const deadline = Date.now() + 10000;
      const timer = setInterval(() => {
        if (window.rustPowerboxTestRequest || Date.now() > deadline) {
          clearInterval(timer); done(!!window.rustPowerboxTestRequest);
        }
      }, 50);
    }, [], result => browser.assert.equal(result.value, true, 'received app Powerbox request'))
    .execute(function () { window.rustPowerboxTestPopup = window.open('/apps', '_blank'); })
    .windowHandles(windows => browser.switchWindow(windows.value[1]))
    .waitForElementPresent('.main-content', utils.medium_wait)
    .execute(function () {
      Meteor.settings.public.rustShellOrigin = location.origin;
      Router.go('/rust-shell-powerbox');
    })
    .waitForElementVisible('.candidate-cards .card-button', utils.medium_wait)
    .click('.candidate-cards .card-button')
    .waitForElementVisible('.powerbox-iframe-mount iframe', utils.medium_wait)
    .frameSelector('.powerbox-iframe-mount iframe')
    .waitForElementVisible('#cap-text', utils.medium_wait)
    .setValue('#cap-text', 'Rust shell capability round trip')
    .click('#do-fulfill').frame(null)
    .windowHandles(windows => browser.switchWindow(windows.value[0]))
    .frameSelector('#rust-session-test')
    .waitForElementVisible('#result-text', utils.medium_wait)
    .assert.textContains('#result-text', 'Rust shell capability round trip')
    .frame(null)
    .execute(function () {
      window.rustPowerboxTestPopup.close();
      removeEventListener('message', window.rustPowerboxTestListener);
    });
  browser.executeAsync(async function (done) {
    const sessionId = new URL(document.getElementById('rust-session-test').src).searchParams.get('sessionid');
    const invalid = [['not-a-session','share',{}], [sessionId,'unknown',{}],
      [sessionId,'share',{pathname:'/%2e%2e/escape'}], [sessionId,'share',{hash:42}]];
    const rejected = await Promise.all(invalid.map(async args => {
      try { await Meteor.callAsync('rustShellSharingContext', ...args); return false; }
      catch { return true; }
    }));
    done(rejected.every(Boolean));
  }, [], result => browser.assert.equal(result.value, true, 'invalid sharing contexts and paths are rejected'));
  // Reuse the real sharing dialog, including app-supplied deep-link metadata.
  browser.execute(function () {
    const sessionId = new URL(document.getElementById('rust-session-test').src).searchParams.get('sessionid');
    window.rustSharingTestListener = event => {
      const popup = window.rustSharingTestPopup;
      if (!popup || event.source !== popup || event.origin !== location.origin) return;
      if (event.data.type === 'rust-sharing-ready') popup.postMessage({type:'rust-sharing-request',
        nonce:'share-test',sessionId,mode:'share',shareData:{pathname:'/folder',hash:'#document'}}, location.origin);
      if (event.data.type === 'rust-sharing-result') window.rustSharingTestResult = event.data;
    };
    addEventListener('message', window.rustSharingTestListener);
    window.rustSharingTestPopup = window.open('/apps', '_blank');
  }).windowHandles(windows => browser.switchWindow(windows.value[1]))
    .waitForElementPresent('.main-content', utils.medium_wait)
    .execute(function () {
      Meteor.settings.public.rustShellOrigin = location.origin;
      Router.go('/rust-shell-sharing');
    })
    .waitForElementVisible('#shareable-link-tab-header', utils.medium_wait)
    .click('#shareable-link-tab-header')
    .waitForElementVisible('.new-share-token', utils.medium_wait)
    .submitForm('.new-share-token')
    .waitForElementVisible('.topbar-popup.share .copy-me', utils.medium_wait)
    .assert.textContains('.topbar-popup.share .copy-me', '/folder#document')
    .click('button.who-has-access')
    .waitForElementVisible('.topbar-popup.who-has-access', utils.medium_wait)
    .windowHandles(windows => browser.switchWindow(windows.value[0]))
    .execute(function () {
      const result = window.rustSharingTestResult;
      removeEventListener('message', window.rustSharingTestListener);
      return result;
    }, [], result => {
      browser.assert.equal(result.value.opened, true, 'sharing handoff opened the canonical dialog');
      browser.assert.equal(Object.keys(result.value).sort().join(','), 'nonce,opened,type', 'no sharing token is returned to the opener');
    });
  operation(browser, 'template');
  operation(browser, 'keep');
  operation(browser, 'close');
  browser.executeAsync(function (done) {
    const deadline = Date.now() + 10000;
    const timer = setInterval(() => {
      if (window.rustSharingTestPopup.closed || Date.now() > deadline) {
        clearInterval(timer); done(window.rustSharingTestPopup.closed);
      }
    }, 50);
  }, [], result => browser.assert.equal(result.value, true, 'sharing window closes when the Rust lease ends'));
  operation(browser, 'shared', true);
  browser.frameSelector('#rust-session-test').waitForElementPresent('#do-test-system-api', utils.medium_wait);
  operation(browser, 'revoke');
  // Existing UI session requests are rejected after revocation, not merely hidden.
  browser.frameSelector('#rust-session-test').executeAsync(function (done) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/publicId'); xhr.timeout = 15000;
    xhr.onload = () => done(xhr.status >= 400);
    xhr.onerror = xhr.ontimeout = () => done(true);
    xhr.send();
  }, [], function (result) { browser.assert.equal(result.value, true, 'revoked iframe cannot keep using the gateway'); });
  operation(browser, 'close');
  operation(browser, 'open', true);
  browser.frameSelector('#rust-session-test').waitForElementPresent('#do-test-system-api', utils.medium_wait);
  operation(browser, 'close');
  for (const mode of ['webkey-anonymous', 'webkey-identity']) {
    operation(browser, mode, true);
    browser.frameSelector('#rust-session-test').waitForElementPresent('#do-test-system-api', utils.medium_wait);
    operation(browser, 'close');
  }
  browser.frame(null).executeAsync(function (done) {
    Meteor.call('testRustNativeSharing', location.pathname.split('/')[2], (error, ok) => done({error:error?.message,ok}));
  }, [], result => {
    browser.assert.equal(result.value.error, null, 'native sharing preserves roles, ownership, grain scope and revocation');
    browser.assert.equal(result.value.ok, true, 'native links work anonymously and with identity');
  });
  // Exercise the native bridge against a real provider and redeem its capability
  // in the requesting app. No Meteor chooser or popup participates in this path.
  browser.frame(null).executeAsync(async function (done) {
    try {
      window.nativePowerboxGrain = location.pathname.split('/')[2];
      const view = await Meteor.callAsync('testRustNativePowerbox','open',window.nativePowerboxGrain);
      const frame = document.createElement('iframe'); frame.id = 'native-powerbox-requester'; frame.src = view.url;
      frame.style = 'position:fixed;inset:0;width:100%;height:100%;z-index:99999;background:white';
      document.body.appendChild(frame);
      window.nativePowerboxListener = event => {
        if (event.source === frame.contentWindow && event.data.powerboxRequest) window.nativePowerboxRequest = event.data.powerboxRequest;
      };
      addEventListener('message',window.nativePowerboxListener);
      done({ok:true});
    } catch (e) { done({error:e.message}); }
  }, [], result => browser.assert.equal(result.value.ok,true,'native requesting session opened'))
    .frameSelector('#native-powerbox-requester').waitForElementVisible('#do-powerbox-request',utils.medium_wait)
    .click('#do-powerbox-request').frame(null)
    .executeAsync(async function (done) {
      try {
        const deadline = Date.now()+10000;
        while (!window.nativePowerboxRequest && Date.now()<deadline) await new Promise(resolve => setTimeout(resolve,50));
        const state = await Meteor.callAsync('testRustNativePowerbox','begin',window.nativePowerboxGrain,{query:window.nativePowerboxRequest.query});
        const candidate = state.candidates.find(row => row.hostedObject);
        if (!candidate) throw new Error('Real provider missing from native query');
        const selected = await Meteor.callAsync('testRustNativePowerbox','select',window.nativePowerboxGrain,{key:candidate.key,mode:'hosted'});
        await Meteor.callAsync('testRustNativePowerbox','checkNested',window.nativePowerboxGrain);
        const frame = document.createElement('iframe'); frame.id = 'native-powerbox-provider'; frame.src = selected.url;
        frame.style = 'position:fixed;inset:0;width:100%;height:100%;z-index:100000;background:white';
        document.body.appendChild(frame);
        done({ok:selected.status === 'provider'});
      } catch (e) { done({error:e.message}); }
    }, [], result => { browser.assert.equal(result.value.error,null,'native matcher and provider selection succeeded'); browser.assert.equal(result.value.ok,true); })
    .frameSelector('#native-powerbox-provider').waitForElementVisible('#cap-text',utils.medium_wait)
    .setValue('#cap-text','Native Powerbox capability round trip').click('#do-fulfill').frame(null)
    .executeAsync(async function (done) {
      try {
        const deadline = Date.now()+10000;
        let result;
        do {
          result = await Meteor.callAsync('testRustNativePowerbox','poll',window.nativePowerboxGrain);
          if (result.status !== 'complete') await new Promise(resolve => setTimeout(resolve,100));
        } while (result.status !== 'complete' && Date.now()<deadline);
        if (result.status !== 'complete') throw new Error('Provider did not fulfill');
        const requester = document.getElementById('native-powerbox-requester');
        requester.contentWindow.postMessage({rpcId:window.nativePowerboxRequest.rpcId,token:result.token,descriptor:result.descriptor},new URL(requester.src).origin);
        await Meteor.callAsync('testRustNativePowerbox','cancel',window.nativePowerboxGrain);
        await Meteor.callAsync('testRustNativePowerbox','verifyProviderClosed',window.nativePowerboxGrain);
        document.getElementById('native-powerbox-provider').remove();
        done({ok:true});
      } catch (e) { done({error:e.message}); }
    }, [], result => { browser.assert.equal(result.value.error,null,'native fulfillment and provider cleanup succeeded'); browser.assert.equal(result.value.ok,true); })
    .frameSelector('#native-powerbox-requester').waitForElementVisible('#result-text',utils.medium_wait)
    .assert.textContains('#result-text','Native Powerbox capability round trip').frame(null)
    .executeAsync(async function (done) {
      try {
        await Meteor.callAsync('testRustNativePowerbox','checkBuiltins',window.nativePowerboxGrain);
        await Meteor.callAsync('testRustNativePowerbox','checkOAuth',window.nativePowerboxGrain);
        await Meteor.callAsync('testRustNativePowerbox','close',window.nativePowerboxGrain);
        document.getElementById('native-powerbox-requester').remove();
        removeEventListener('message',window.nativePowerboxListener);
        done(true);
      } catch (e) { done(e.message); }
    }, [], result => browser.assert.equal(result.value,true,'native UiView, URL, pasted webkey authorization and cleanup succeeded'));
  utils.callMeteorTestMethod(browser, "testRegressionRustShellPersistence");
  utils.callMeteorTestMethod(browser, "testRustNativeLogin");
  utils.callMeteorTestMethod(browser, "testRustEmailDeliveryFailure");
  utils.callMeteorTestMethod(browser, "testRustDevAccountIdentity");
  utils.callMeteorTestMethod(browser, "testRustOAuth");
  utils.callMeteorTestMethod(browser, "testRustSaml");
  utils.callMeteorTestMethod(browser, "testRustProfile");
  utils.callMeteorTestMethod(browser, "testRustGrainManagement");
  utils.callMeteorTestMethod(browser, "testRegressionEmailCredentialLinkAwaitsFailure");
  browser.frame(null).executeAsync(function (done) {
    Meteor.call('testRustRenameGrain', location.pathname.split('/')[2], (error, ok) => done({error:error?.message,ok}));
  }, [], result => {
    browser.assert.equal(result.value.error, null, 'owner and recipient renames preserve canonical title semantics');
    browser.assert.equal(result.value.ok, true, 'revoked recipients cannot rename');
  });
  browser.frame(null).executeAsync(function (done) {
    Meteor.call('testRustInstall', location.pathname.split('/')[2], (error,ok) => done({error:error?.message,ok}));
  }, [], result => {
    browser.assert.equal(result.value.error, null, 'native installation and account-scoped upgrade completed');
    browser.assert.equal(result.value.ok, true, 'native installation rejects invalid packages, downgrade and revoked login');
  });
  browser.frame(null).executeAsync(function (done) {
    Meteor.call('testRustCreateGrain', location.pathname.split('/')[2], (error, grainId) => {
      if (!error) Router.go('/grain/' + grainId);
      done({error:error?.message,grainId});
    });
  }, [], result => {
    browser.assert.equal(result.value.error, null, 'installed app creation respects ownership and persists the grain');
    browser.assert.ok(result.value.grainId, 'created grain ID returned');
  }).grainFrame().waitForElementPresent('#do-test-system-api', utils.medium_wait);
  browser.end();
};

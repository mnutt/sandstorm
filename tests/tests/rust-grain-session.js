"use strict";
const utils = require('../utils');

function operation(browser, action, embed) {
  browser.frame(null).executeAsync(function (action, embed, done) {
    const grainId = window.location.pathname.split('/')[2];
    Meteor.call('testRustGrainSession', action, grainId, function (error, result) {
      if (!error && embed) {
        document.getElementById('rust-session-test')?.remove();
        const frame = document.createElement('iframe');
        frame.id = 'rust-session-test'; frame.src = result.url;
        frame.style = 'position:fixed;inset:0;width:100%;height:100%;z-index:99999;background:white';
        document.body.appendChild(frame);
      }
      done({ error: error?.message, ok: !!result });
    });
  }, [action, embed], function (result) {
    browser.assert.equal(result.value.error, null, action + ' UI session succeeded');
    browser.assert.equal(result.value.ok, true);
  });
}

module.exports['Real grain iframe session, close/reopen, shared access and revocation'] = function (browser) {
  browser.loginDevAccount().uploadTestApp().timeouts('script', 30000).grainFrame()
    .waitForElementPresent('#do-test-system-api', utils.medium_wait).frame(null);
  operation(browser, 'open', true);
  browser.frameSelector('#rust-session-test').waitForElementPresent('#do-test-system-api', utils.medium_wait);
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
  operation(browser, 'keep');
  operation(browser, 'close');
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
  utils.callMeteorTestMethod(browser, "testRegressionRustShellPersistence");
  browser.end();
};

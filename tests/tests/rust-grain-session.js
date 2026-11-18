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
  browser.end();
};

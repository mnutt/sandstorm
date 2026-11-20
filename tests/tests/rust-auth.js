"use strict";
const utils = require('../utils');
module.exports['Native Rust authentication and account settings'] = function (browser) {
  browser.loginDevAccount().timeouts('script', 30000);
  utils.callMeteorTestMethod(browser, 'testRustNativeLogin');
  utils.callMeteorTestMethod(browser, "testRustEmailDeliveryFailure");
  utils.callMeteorTestMethod(browser, "testRustDevAccountIdentity");
  utils.callMeteorTestMethod(browser, 'testRustGithub');
  utils.callMeteorTestMethod(browser, 'testRustProfile');
  utils.callMeteorTestMethod(browser, 'testRegressionEmailCredentialLinkAwaitsFailure');
  browser.end();
};

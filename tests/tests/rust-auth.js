"use strict";
const utils = require('../utils');
module.exports['Native Rust authentication and account settings'] = function (browser) {
  browser.loginDevAccount().timeouts('script', 30000);
  utils.callMeteorTestMethod(browser, 'testRustNativeLogin');
  utils.callMeteorTestMethod(browser, "testRustEmailDeliveryFailure");
  utils.callMeteorTestMethod(browser, "testRustDevAccountIdentity");
  utils.callMeteorTestMethod(browser, 'testRustOAuth');
  utils.callMeteorTestMethod(browser, "testRustSaml");
  utils.callMeteorTestMethod(browser, 'testRegressionOidcSigninAndIndexMigration');
  utils.callMeteorTestMethod(browser, 'testRustProfile');
  utils.callMeteorTestMethod(browser, 'testRegressionEmailCredentialLinkAwaitsFailure');
  utils.callMeteorTestMethod(browser, 'testRustGrainQueries');
  utils.callMeteorTestMethod(browser, 'testRustGrainReadiness');
  utils.callMeteorTestMethod(browser, 'testRustInstallPermissions');
  browser.end();
};

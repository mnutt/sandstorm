// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

"use strict";

var utils = require("../utils"),
    medium_wait = utils.medium_wait;

module.exports["Test outbound HTTP session"] = function (browser) {
  browser
    .url(browser.launch_url + "/")
    .timeouts("script", medium_wait);

  utils.callMeteorTestMethod(browser, "testRegressionOutboundHttpSession");

  browser.end();
};

["bearer", "queryKey", "sigV4"].forEach(function (kind) {
module.exports["Test managed outbound Powerbox form save restore and revoke " + kind] = function (browser) {
  browser.url(browser.launch_url + "/").timeouts("script", medium_wait);
  browser.executeAsync(function (kind, done) {
    Meteor.call("testPrepareManagedOutboundHttp", kind, function (error, fixture) {
      if (error) { done({ error: error.message }); return; }
      var Blaze = Package.blaze.Blaze;
      var Template = Package.templating.Template;
      var container = document.createElement("div");
      document.body.appendChild(container);
      var view;
      var data = { option: fixture.option, powerboxRequest: {
        completeNewFrontendRef: function (payload) {
          Meteor.call("newFrontendRef", fixture.sessionId, payload, function (saveError, saved) {
            if (saveError) { done({ error: saveError.message }); return; }
            var cleared = Array.from(container.querySelectorAll("input.secret")).every(function (input) {
              return input.value === "";
            });
            Meteor.call("testVerifyManagedOutboundHttp", fixture.sessionId, saved.sturdyRef,
              function (verifyError, result) {
                Blaze.remove(view); container.remove();
                done({ error: verifyError && verifyError.message, cleared: cleared, result: result });
              });
          });
        },
      } };
      view = Blaze.renderWithData(Template.outboundHttpCredentialsConfiguration, data, container);
      Tracker.flush();
      Array.from(container.querySelectorAll("input.secret")).forEach(function (secret) {
        secret.value = "browser-test-key";
        secret.dispatchEvent(new Event("input", { bubbles: true }));
      });
      container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }, [kind], function (result) {
    browser.assert.ok(!result.value.error, JSON.stringify(result.value));
    browser.assert.equal(result.value.cleared, true);
    browser.assert.equal(result.value.result && result.value.result.revoked, true);
  }).end();
};
});

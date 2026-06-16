// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
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

// This file implements the common shell components such as the top bar.
// It also covers the root page.

import { Meteor } from "meteor/meteor";
import { Mongo } from "meteor/mongo";
import { Template } from "meteor/templating";
import { Tracker } from "meteor/tracker";
import { ReactiveVar } from "meteor/reactive-var";
import { Accounts } from "meteor/accounts-base";
import { Session } from "meteor/session";
import { Router } from "meteor/vlasky:galvanized-iron-router";
import { TAPi18n } from "/imports/tapi18n";

import getBuildInfo from "/imports/client/build-info";
import SandstormAccountSettingsUi from "/imports/client/accounts/account-settings-ui";
import { isStandalone } from "/imports/client/standalone";
import { globalSubs } from "/imports/client/global-subs";
import { globalAccountsUi, globalGrains, globalTopbar } from "/imports/client/shell-state";
import { registerTestApi } from "/imports/client/test-api";
import { SandstormDb } from "/imports/sandstorm-db/db";
import { globalDb, Grains, isDemoUser, isUserOverQuota, makeWildcardHost } from "/imports/db-deprecated";
import { coerceTemplateText } from "/imports/shared/template-values";

export { globalSubs };
export { prettySize } from "/imports/client/shell/formatting";

if (Meteor.isClient) {
  Meteor.startup(function () {
    Session.set("showLoadingIndicator", true);

    const langMap = TAPi18n.getLanguages();
    let bestLang = null;

    if (navigator.languages) {
      navigator.languages.forEach(lang => {
        if (!bestLang) {
          if (lang in langMap) {
            bestLang = lang;
          } else if (lang.indexOf('-') > 0) {
            var prefix = lang.split('-')[0];
            if (prefix in langMap) {
              bestLang = prefix;
            }
          }
        }
      });
    } else {
      bestLang = navigator.language || navigator.userLanguage ||
                 navigator.browserLanguage || navigator.systemLanguage;
    }

    if (!bestLang) bestLang = "en";

    TAPi18n.setLanguage(bestLang)
      .done(function () {
        Session.set("showLoadingIndicator", false);
      })
      .fail(function (errorMessage) {
        // Handle the situation
        console.log(errorMessage);
      });
  });
}

Tracker.autorun(function () {
  const me = Meteor.user();
  if (me) {
    if (me.type === "credential") {
      Meteor.subscribe("credentialDetails", me._id);
    }

    if (me.loginCredentials) {
      me.loginCredentials.forEach(function (credential) {
        Meteor.subscribe("credentialDetails", credential.id);
      });
    }

    if (me.nonloginCredentials) {
      me.nonloginCredentials.forEach(function (credential) {
        Meteor.subscribe("credentialDetails", credential.id);
      });
    }
  }
});

// export: called by sandstorm-accounts-ui/login_buttons.js
//               and grain-client.js
export const logoutSandstorm = function () {
  const logoutHelper = function () {
    sessionStorage.removeItem("linkingIdentityLoginToken");
    Accounts._loginButtonsSession.closeDropdown();
    globalTopbar.closePopup();
    if (!isStandalone()) {
      globalGrains.clear();
    }
  };

  if (globalDb.userHasSamlLoginCredential()) {
    Meteor.call("generateSamlLogout", function (err, url) {
      Meteor.logout(function () {
        logoutHelper();
        if (err) {
          console.error(err);
        } else {
          window.location = url;
        }
      });
    });
  } else {
    Meteor.logout(function () {
      logoutHelper();
      if (!isStandalone()) {
        Router.go("root");
      }
    });
  }
};

const makeAccountSettingsUi = function () {
  return new SandstormAccountSettingsUi(globalTopbar, globalDb,
      window.location.protocol + "//" + makeWildcardHost("static"));
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const formatInCountdown = function (template, countdownDatetime) {
  const diff = countdownDatetime.getTime() - Date.now();

  const units = {
    day: 86400000,
    hour: 3600000,
    minute: 60000,
    second: 1000,
  };

  for (const unit in units) {
    // If it's more than one full unit away, then we'll print in terms of this unit. This does
    // mean that we write e.g. "1 minute" for the whole range between 2 minutes and 1 minute, but
    // whatever, this is typical of these sorts of displays.
    if (diff >= units[unit]) {
      const count = Math.floor(diff / units[unit]);
      // Update next 1ms after the point where `count` would change.
      setTopBarTimeout(template, diff - count * units[unit] + 1);
      return {
        text: "in " + count + " " + unit + (count > 1 ? "s" : ""),
        className: "countdown-" + unit,
      };
    }
  }

  // We're within a second of the countdown, or past it.
  if (diff < -3600000) {
    // Notification appears stale.
    return null;
  } else {
    setTopBarTimeout(template, diff + 3600001);
    return { text: "any moment", className: "countdown-now" };
  }
};

const formatAccountExpires = function () {
  const expires = Meteor.user().expires;
  return (expires && expires.toLocaleTimeString()) || null;
};

const formatAccountExpiresIn = function (template, currentDatetime) {
  // TODO(someday): formatInCountdown will set the interval to match account expiration time, and
  // completely overwrite the previous interval for $IN_COUNTDOWN
  const user = Meteor.user() || {};
  const expires = user.expires || null;
  if (!expires) {
    return null;
  } else {
    return formatInCountdown(template, expires, currentDatetime);
  }
};

const setTopBarTimeout = function (template, delay) {
  Meteor.clearTimeout(template.timeout);
  template.timeout = Meteor.setTimeout(function () {
    template.timer.changed();
  }, delay);

  // Make sure we re-run when the timeout triggers.
  template.timer.depend();
};

const determineAppName = function (grainId) {
  // Returns:
  //
  // - The current app title, if we can determine it, or
  //
  // - The empty string "", if we can't determine the current app title.
  let params = "";

  // Try our hardest to find the package's name, falling back on the default if needed.
  if (grainId) {
    const grain = globalDb.collections.grains.findOne({ _id: grainId });
    if (grain && grain.packageId) {
      const thisPackage = globalDb.collections.packages.findOne({ _id: grain.packageId });
      if (thisPackage) {
        params = SandstormDb.appNameFromPackage(thisPackage);
      }
    }
  }

  return params;
};

const billingPromptState = new ReactiveVar(null);

const showBillingPrompt = function (reason, next) {
  billingPromptState.set({
    reason: reason,
    db: globalDb,
    topbar: globalTopbar,
    accountsUi: globalAccountsUi,
    billingPromptTemplate: Meteor.settings.public.stripePublicKey
                              ? "billingPrompt" : "billingPromptLocal",
    onComplete: function () {
      billingPromptState.set(null);
      if (!Meteor.settings.public.stripePublicKey) {
        Meteor.call("updateQuota", function (err) {
          if (err) {
            console.error(err);
            alert(err);
          }

          if (next) next();
        });
      } else if (next) {
        next();
      }
    },
  });
};

// TEMPORARY HACK for free plan going away.
Template.sandstormAppListPage.events({
  "click .upgrade-plan-now": function (event, tmpl) {
    showBillingPrompt("voluntary");
  }
});
Template.sandstormGrainListPage.events({
  "click .upgrade-plan-now": function (event, tmpl) {
    showBillingPrompt("voluntary");
  }
});

const ifQuotaAvailable = function (next) {
  const reason = isUserOverQuota(Meteor.user());
  if (reason) {
    showBillingPrompt(reason, function () {
      // If the user successfully raised their quota, continue the operation.
      if (!isUserOverQuota(Meteor.user())) {
        next();
      }
    });
  } else {
    next();
  }
};

const ifPlanAllowsCustomApps = function (next) {
  if (globalDb.isDemoUser() || globalDb.isUninvitedFreeUser()) {
    if (Meteor.settings.public.stripePublicKey) {
      showBillingPrompt("customApp", function () {
        // If the user successfully chose a plan, continue the operation.
        if (!globalDb.isDemoUser() && !globalDb.isUninvitedFreeUser()) {
          next();
        }
      });
    } else {
      alert("Sorry, demo users cannot upload custom apps.");
    }
  } else {
    next();
  }
};

const isDemoExpired = function () {
  const user = Meteor.user();
  if (!user) return false;
  let expires = user.expires;
  if (!expires) return false;
  expires = expires.getTime() - Date.now();
  if (expires <= 0) return true;
  const comp = Tracker.currentComputation;
  if (expires && comp) {
    Meteor.setTimeout(comp.invalidate.bind(comp), expires);
  }

  return false;
};

// export: this is also used by grain.js
export const makeDateString = function (date) {
  if (!date) {
    return "";
  }

  let result;

  const now = new Date();
  const diff = now.valueOf() - date.valueOf();

  if (diff < 86400000 && now.getDate() === date.getDate()) {
    result = date.toLocaleTimeString();
  } else {
    result = MONTHS[date.getMonth()] + " " + date.getDate() + " ";

    if (now.getFullYear() !== date.getFullYear()) {
      result = date.getFullYear() + " " + result;
    }
  }

  return result;
};

// export: used in shared/demo.js
export const launchAndEnterGrainByPackageId = function (packageId, options) {
  const action = globalDb.collections.userActions.findOne({ packageId: packageId });
  if (!action) {
    alert("Somehow, you seem to have attempted to launch a package you have not installed.");
    return;
  } else {
    launchAndEnterGrainByActionId(action._id, null, null, options);
  }
};

// export: used in sandstorm-ui-app-details
export const launchAndEnterGrainByActionId = function (actionId, devPackageId, devIndex, options) {
  // Note that this takes a devPackageId and a devIndex as well. If provided,
  // they override the actionId.
  let packageId;
  let command;
  let appTitle;
  let nounPhrase;
  if (devPackageId) {
    const devPackage = globalDb.collections.devPackages.findOne(devPackageId);
    if (!devPackage) {
      console.error("no such dev package: ", devPackageId);
      return;
    }

    const devAction = devPackage.manifest.actions[devIndex];
    packageId = devPackageId;
    command = devAction.command;
    appTitle = SandstormDb.appNameFromPackage(devPackage);
    nounPhrase = SandstormDb.nounPhraseForActionAndAppTitle(devAction, appTitle);
  } else {
    const action = globalDb.collections.userActions.findOne(actionId);
    if (!action) {
      console.error("no such action:", actionId);
      return;
    }

    packageId = action.packageId;
    const pkg = globalDb.collections.packages.findOne(packageId);
    command = action.command;
    appTitle = SandstormDb.appNameFromPackage(pkg);
    nounPhrase = SandstormDb.nounPhraseForActionAndAppTitle(action, appTitle);
  }

  const title = "Untitled " + appTitle + " " + nounPhrase;

  // We need to ask the server to start a new grain, then browse to it.
  Meteor.call("newGrain", packageId, command, title, function (error, grainId) {
    if (error) {
      if (error.error === 402 || error.error === "quota-exhausted") {
        // Sadly this can occur under LDAP quota management when the backend updates its quota
        // while creating the grain.
        showBillingPrompt("outOfStorage", function () {
          // TODO(someday): figure out the actual reason, instead of hard-coding outOfStorage
          Meteor.call("newGrain", packageId, command, title,
          function (error, grainId) {
            if (error) {
              console.error(error);
              alert(error.message);
            } else {
              Router.go("grain", { grainId: grainId }, options);
            }
          });
        });
      } else {
        console.error(error);
        alert(error.message);
      }
    } else {
      Router.go("grain", { grainId: grainId }, options);
    }
  });
};

// export global - used in grain.js
export const globalQuotaEnforcer = {
  ifQuotaAvailable: ifQuotaAvailable,
  ifPlanAllowsCustomApps: ifPlanAllowsCustomApps,
};

export const HasUsers = new Mongo.Collection("hasUsers");  // dummy collection defined above

if (Meteor.settings.public.quotaEnabled) {
  window.testDisableQuotaClientSide = function () {
    Meteor.settings.public.quotaEnabled = false;
  };
}

Router.onRun(function () {
  // Close menus and popups any time we navigate.
  globalTopbar.reset();
  this.next();
});

export const credentialsSubscription = Meteor.subscribe("credentials");

Template.registerHelper("dateString", makeDateString);
Template.registerHelper("hideNavbar", function () {
  // Hide navbar if user is not logged in, since they can't go anywhere with it.
  return (!Meteor.userId() && globalGrains.getAll().length <= 1) || isDemoExpired();
});

Template.registerHelper("shrinkNavbar", function () {
  // Shrink the navbar if the user clicked the button to do so.
  return Session.get("shrink-navbar");
});

Template.registerHelper("quotaEnabled", function () {
  return globalDb.isQuotaEnabled();
});

Template.registerHelper("referralsEnabled", function () {
  return globalDb.isReferralEnabled();
});

Template.registerHelper("con", function () {
  const args = Array.prototype.slice.call(arguments);
  const last = args[args.length - 1];
  // Blaze may pass a trailing options object, but not in every call shape.
  if (last && typeof last === "object" && Object.prototype.hasOwnProperty.call(last, "hash")) {
    args.pop();
  }

  return args.map((arg) => {
    return coerceTemplateText(arg) || "";
  }).join(".");
});

Meteor.startup(function () {
  // Tell app authors how to run JS in the context of the grain-frame.
  if (!Meteor._localStorage.getItem("muteDevNote")) {
    console.log(
        "%cApp authors: To understand the grain-frame in Sandstorm and how to find " +
        "logs and perform troubleshooting, see: " +
        "\n- https://docs.sandstorm.org/en/latest/developing/path/ " +
        "\n- https://docs.sandstorm.org/en/latest/using/top-bar/ " +
        "\n- https://docs.sandstorm.org/en/latest/developing/troubleshooting/ " +
        "\n" +
        "\nWhen debugging, make sure you execute Javascript " +
        "in the context of the 'grain-frame' IFRAME. References: " +
        "\n- https://stackoverflow.com/questions/3275816/debugging-iframes-with-chrome-developer-tools " +
        "\n- https://developer.mozilla.org/en-US/docs/Tools/Working_with_iframes " +
        "\n" +
        "\nWe can also provide personal assistance! Get in touch: https://sandstorm.io/community",
      "font-size: large; background-color: yellow;");
  }
});

Router.configure({
  layoutTemplate: "layout",
  notFoundTemplate: "notFound",
  loadingTemplate: "loading",
});

if (Meteor.isClient) {
  Router.onBeforeAction("loading");
}

const promptForFile = function (input, callback) {
  // TODO(cleanup): Share code with "upload picture" and other upload buttons.
  function listener(e) {
    input.removeEventListener("change", listener);
    callback(e.currentTarget.files[0]);
  }

  input.addEventListener("change", listener);
  input.click();
};

const startUpload = function (file, endpoint, onComplete) {
  // TODO(cleanup): Use Meteor's HTTP, although this may require sending them a PR to support
  //   progress callbacks (and officially document that binary input is accepted).

  if (endpoint.startsWith("/") && !endpoint.startsWith("//")) {
    // Endpoint is relative to the current host. Use the DDP host instead, if one is defined,
    // so that we don't do file transfers over the main host, which may be a CDN.
    const origin = __meteor_runtime_config__.DDP_DEFAULT_CONNECTION_URL || "";  // jscs:ignore requireCamelCaseOrUpperCaseIdentifiers
    endpoint = origin + endpoint;
  }

  Session.set("uploadStatus", "Uploading");
  Session.set("uploadError", undefined);

  const xhr = new XMLHttpRequest();

  xhr.onreadystatechange = function () {
    if (xhr.readyState == 4) {
      if (xhr.status >= 200 && xhr.status < 300) {
        Session.set("uploadProgress", 0);
        onComplete(xhr.responseText);
      } else {
        Session.set("uploadError", {
          status: xhr.status,
          statusText: xhr.statusText,
          response: xhr.responseText,
        });
      }
    }
  };

  if (xhr.upload) {
    xhr.upload.addEventListener("progress", function (progressEvent) {
      Session.set("uploadProgress",
          Math.floor(progressEvent.loaded / progressEvent.total * 100));
    });
  }

  xhr.open("POST", endpoint, true);
  xhr.send(file);

  Router.go("uploadStatus");
};

export const restoreBackup = function (file) {
  Meteor.call("newRestoreToken", function (err, token) {
    if (err) {
      console.error(err);
      alert(err.message);
    } else {
      startUpload(file, "/uploadBackup/" + token, function (response) {
        Session.set("uploadStatus", "Unpacking");
        Meteor.call("restoreGrain", token, null, function (err, grainId) {
          if (err) {
            console.log(err);
            Session.set("uploadStatus", undefined);
            Session.set("uploadError", {
              status: "",
              statusText: err.message,
            });
          } else {
            Router.go("grain", { grainId: grainId }, { replaceState: true });
          }
        });
      });
    }
  });
};

export const promptRestoreBackup = function (input) {
  promptForFile(input, restoreBackup);
};

export const uploadApp = function (file) {
  Meteor.call("newUploadToken", function (err, token) {
    if (err) {
      console.error(err);
      alert(err.message);
    } else {
      startUpload(file, "/upload/" + token, function (response) {
        Session.set("uploadStatus", undefined);
        Router.go("install", { packageId: response }, { replaceState: true });
      });
    }
  });
};

export const promptUploadApp = function (input) {
  promptForFile(input, uploadApp);
};

registerTestApi({
  createApiTokenForFirstGrain(roleAssignment, frontendRef, callback) {
    const grain = Grains.findOne();
    if (!grain) {
      callback({ error: { message: "No grain found." } });
      return;
    }

    this.createApiTokenForGrain(grain._id, roleAssignment, frontendRef, callback);
  },

  createApiTokenForGrain(grainId, roleAssignment, frontendRef, callback) {
    Meteor.call("newApiToken", { accountId: Meteor.userId() },
                grainId, "petname", roleAssignment, frontendRef,
                function (error, result) {
                  callback({ error, result, grainId });
                });
  },

  restoreBackup,
  uploadApp,
});

Template.uploadTest.events({
  "change #upload-app": function (event, tmpl) {
    uploadApp(event.currentTarget.files[0]);
  },

  "change #upload-backup": function (event, tmpl) {
    restoreBackup(event.currentTarget.files[0]);
  },
});

Router.map(function () {
  this.route("root", {
    path: "/",
    subscriptions: function () {
      this.subscribe("hasUsers").wait();
      if (!Meteor.loggingIn() && Meteor.user() && Meteor.user().loginCredentials) {
        this.subscribe("grainsMenu").wait();
      }
    },

    data: function () {
      if (isStandalone()) {
        return; // TODO(soon): move the route logic here?
      }
      // If the user is logged-in, and can create new grains, and
      // has no grains yet, then send them to "new".
      if (this.ready() && Meteor.userId() && !Meteor.loggingIn() && Meteor.user().loginCredentials) {
        if (globalDb.currentUserGrains().count() === 0 &&
            globalDb.currentUserApiTokens().count() === 0) {
          Router.go("apps", {}, { replaceState: true });
        } else {
          Router.go("grains", {}, { replaceState: true });
        }
      }

      if (this.ready() && !HasUsers.findOne("hasUsers") && !globalDb.allowDevAccounts()) {
        // This server has no users and hasn't been setup yet.
        this.redirect("setupWizardIntro");
      }

      return {
        build: getBuildInfo().build,
        splashUrl: (globalDb.collections.settings.findOne("splashUrl") || {}).value,
      };
    },
  });

  this.route("linkHandler", {
    path: "/link-handler/:url",

    data: function () {
      let url = this.params.url;
      if (url.lastIndexOf("web+sandstorm:", 0) === 0) {
        url = url.slice("web+sandstorm:".length);
      }
      // TODO(cleanup):  Didn't use Router.go() because the url may contain a query term.
      document.location = "/install/" + url;
      return {};
    },
  });

  this.route("about", {
    path: "/about",
    data: function () {
      const result = getBuildInfo();

      result.termsUrl = globalDb.getSetting("termsUrl");
      result.privacyUrl = globalDb.getSetting("privacyUrl");

      return result;
    },
  });

  this.route("uploadStatus", {
    path: "/upload",

    waitOn: function () {
      return Meteor.subscribe("credentials");
    },

    data: function () {
      return {
        progress: Session.get("uploadProgress"),
        status: Session.get("uploadStatus"),
        error: Session.get("uploadError"),
      };
    },
  });

  this.route("uploadTest", {
    path: "/upload-test",

    waitOn: function () {
      return Meteor.subscribe("credentials");
    },

    data: function () {},
  });

  this.route("referrals", {
    path: "/referrals",

    waitOn: function () {
      return Meteor.subscribe("referralInfoPseudo");
    },
  });

  this.route("account", {
    path: "/account",

    waitOn() {
      return globalSubs;
    },

    data: function () {
      // Don't allow logged-out or demo users to visit the accounts page. There should be no way
      // for them to get there except for typing the URL manually. In theory showing the accounts
      // page to a demo user could make some sense for editing their profile, but we really do not
      // want them signing up for subscription plans!
      if ((!Meteor.user() && !Meteor.loggingIn()) || globalDb.isDemoUser()) {
        Router.go("root", {}, { replaceState: true });
      } else {
        return makeAccountSettingsUi();
      }
    },
  });
});

export {
  billingPromptState,
  credentialsSubscription,
  determineAppName,
  formatAccountExpires,
  formatAccountExpiresIn,
  formatInCountdown,
  isDemoExpired,
  logoutSandstorm,
  makeAccountSettingsUi,
};

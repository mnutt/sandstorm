import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";
import { Tracker } from "meteor/tracker";
import { Session } from "meteor/session";

import { isDevelopmentServer } from "/imports/client/dev-mode";
import { isStandalone } from "/imports/client/standalone";
import { globalDb } from "/imports/db-deprecated";
import {
  billingPromptState,
  credentialsSubscription,
  determineAppName,
  formatAccountExpires,
  formatAccountExpiresIn,
  formatInCountdown,
  isDemoExpired,
  logoutSandstorm,
  makeAccountSettingsUi,
} from "/imports/client/shell-client";

import "/imports/client/shell/styles/layout-main-content-ui.scss";
import "/imports/client/shell/styles/layout-main-content-state-ui.scss";
import "/imports/client/shell/styles/layout-centered-box-ui.scss";
import "/imports/client/shell/styles/layout-ios-ui.scss";
import "/imports/client/shell/styles/admin-alert.scss";

Template.layout.events({
  "click a": function (event) {
    // Close menus if a navigation link is clicked. Usually the Router.onRun(), above, will also
    // execute, but it will not in the case where the link points to the current page, yet we'd
    // really still like for the menus to close in such cases.
    if (!event.isDefaultPrevented()) {
      globalThis.globalTopbar.reset();
    }
  },
});

Template.body.onRendered(function () {
  // If we're on iOS, set a class name on <body> so we can use CSS styles to work around mobile
  // Safari's ridiculous iframe rendering behavior.
  //
  // Note that this can't be done as a template helper because the <body> tag cannot have
  // attributes determined by helpers. This appears to be a Meteor bug related to the fact that
  // the <body> tag is not inside a <template>, but rather is itself equivalent to a <template>.
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
    document.body.className = "ios";
  }
});

Template.layout.onCreated(function () {
  this.timer = new Tracker.Dependency();
  const resizeTracker = this.resizeTracker = new Tracker.Dependency();
  this.resizeFunc = function () {
    resizeTracker.changed();
  };

  window.addEventListener("resize", this.resizeFunc, false);
});

Template.layout.onDestroyed(function () {
  Meteor.clearTimeout(this.timeout);
  window.removeEventListener("resize", this.resizeFunc, false);
});

Template.layout.helpers({
  effectiveServerTitle() {
    const useServerTitle =
        globalDb.getSettingWithFallback("whitelabelUseServerTitleForHomeText", false);
    return useServerTitle ? globalDb.getSettingWithFallback("serverTitle", "Sandstorm") :
        "Sandstorm";
  },

  adminAlertIsTooLarge: function () {
    Template.instance().resizeTracker.depend();
    const setting = globalDb.collections.settings.findOne({ _id: "adminAlert" });
    if (!setting || !setting.value) {
      return false;
    }
    // TODO(someday): 10 and 850 are just magic values that estimate the size of the font and the
    // number of pixels everything else in the topbar respectively. This should really be
    // calculated based on actual sizes of things in the topbar.
    return (window.innerWidth - setting.value.length * 10) < 850;
  },

  adminAlert: function () {
    const setting = globalDb.collections.settings.findOne({ _id: "adminAlert" });
    if (!setting || !setting.value) {
      return null;
    }

    let text = setting.value;

    const alertTimeSetting = globalDb.collections.settings.findOne({ _id: "adminAlertTime" });
    const alertTime = alertTimeSetting && alertTimeSetting.value;

    const alertUrlSetting = globalDb.collections.settings.findOne({ _id: "adminAlertUrl" });
    let alertUrl = alertUrlSetting ? alertUrlSetting.value.trim() : null;
    if (!alertUrl) alertUrl = null;

    const template = Template.instance();
    let param;
    let className;
    if (text.indexOf("$TIME") !== -1) {
      if (!alertTime) return null;
      text = text.replace("$TIME", alertTime.toLocaleTimeString());
    }

    if (text.indexOf("$DATE") !== -1) {
      if (!alertTime) return null;
      text = text.replace("$DATE", alertTime.toLocaleDateString());
    }

    if (text.indexOf("$IN_COUNTDOWN") !== -1) {
      if (!alertTime) return null;
      param = formatInCountdown(template, alertTime);
      if (!param) return null;
      text = text.replace("$IN_COUNTDOWN", param.text);
      className = param.className;
    }

    if (text.indexOf("$ACCOUNT_EXPIRES_IN") !== -1) {
      param = formatAccountExpiresIn(template);
      if (!param) return null;
      text = text.replace("$ACCOUNT_EXPIRES_IN", param.text);
      className = param.className;
    }

    if (text.indexOf("$ACCOUNT_EXPIRES") !== -1) {
      param = formatAccountExpires();
      if (!param) return null;
      text = text.replace("$ACCOUNT_EXPIRES", param);
    }

    if (text.indexOf("$APPNAME") !== -1) {
      text = text.replace("$APPNAME", determineAppName(this.grainId));
    }

    if (alertUrl && alertUrl.indexOf("$APPNAME") !== -1) {
      alertUrl = alertUrl.replace("$APPNAME", determineAppName(this.grainId));
    }

    return {
      text,
      className,
      alertUrl,
    };
  },

  billingPromptState: function () {
    return billingPromptState.get();
  },

  demoExpired: isDemoExpired,
  canUpgradeDemo: function () {
    return Meteor.settings.public.allowUninvited;
  },

  globalAccountsUi: function () {
    return globalThis.globalAccountsUi;
  },

  globalGrains: function () {
    return globalThis.globalGrains;
  },

  credentialUser: function () {
    const user = Meteor.user();
    return user && user.type === "credential";
  },

  showAccountButtons: function () {
    return Meteor.user() && !Meteor.loggingIn() && !globalThis.isDemoUser();
  },

  accountButtonsData: function () {
    const showSendFeedback = !globalDb.getSettingWithFallback("whitelabelHideSendFeedback", false);
    return {
      isAdmin: globalDb.isAdmin(),
      grains: globalThis.globalGrains,
      showSendFeedback,
    };
  },

  firstLogin: function () {
    return !isDevelopmentServer() && credentialsSubscription.ready() &&
        !globalThis.isDemoUser() && !Meteor.loggingIn()
        && Meteor.user() && !Meteor.user().hasCompletedSignup &&
        !isStandalone();
  },

  accountSettingsUi: function () {
    return makeAccountSettingsUi();
  },

  isAccountSuspended: function () {
    const user = Meteor.user();
    return user && user.suspended;
  },

  isStandalone: function () {
    return isStandalone();
  },

  demoModal: function () {
    return Session.get("globalDemoModal");
  },

  dismissDemoModal: function () {
    return function () {
      Session.set("globalDemoModal", null);
    };
  },
});

Template.layout.events({
  "click .demo-expired-main-content button[name=logout]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    logoutSandstorm();
  },

  "click .demo-startup-modal .start"(evt) {
    Session.set("globalDemoModal", null);
  },
});

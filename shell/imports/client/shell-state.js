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

import { Meteor } from "meteor/meteor";
import { Session } from "meteor/session";

import AccountsUi from "/imports/client/accounts/accounts-ui";
import { GrainViewList } from "/imports/client/grain/grainview-list";
import { registerTestApi } from "/imports/client/test-api";
import { globalDb } from "/imports/db-deprecated";
import { SandstormTopbar } from "/imports/sandstorm-ui-topbar/topbar";

Session.setDefault("shrink-navbar", false);

export const globalGrains = new GrainViewList(globalDb);

// If Meteor._localStorage disappears, we'll have to write our own localStorage wrapper, I guess.
// Using window.localStorage is dangerous because it throws an exception if cookies are disabled.
Session.set("shrink-navbar", Meteor._localStorage.getItem("shrink-navbar") === "true");

export const globalTopbar = new SandstormTopbar(globalDb,
  {
    get() {
      return Session.get("topbar-expanded");
    },

    set(value) {
      Session.set("topbar-expanded", value);
    },
  },
  globalGrains,
  {
    get() {
      return Session.get("shrink-navbar");
    },

    set(value) {
      Meteor._localStorage.setItem("shrink-navbar", value);
      Session.set("shrink-navbar", value);
    },
  });

export const globalAccountsUi = new AccountsUi(globalDb);

export const forceReplica = function (replica) {
  // Helper function for blackrock debugging.
  document.cookie = "force_replica=" + replica + ";path=/;domain=." + window.location.hostname;
};

registerTestApi({
  activeGrainFrameSelector() {
    const active = globalGrains.getActive();
    return active && active.grainId ? "#grain-frame-" + active.grainId() : null;
  },

  isActiveGrainIncognito() {
    const active = globalGrains.getActive();
    return active ? active.isIncognito() : false;
  },
});

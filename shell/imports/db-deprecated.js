// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
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

// This file imports symbols from the sandstorm-db package. New code should use SandstormDb
// directly.

// TODO(cleanup): Over time, eliminate the use of each of these assignments by using `globalDb`
//   directly. For collections, prefer to update SandstormDb to provide methods for querying the
//   collection rather than use `globalDb.collections` directly. When code is moved into packages,
//   the `globalDb` global should NOT go with it; the package should expect a SandstormDb to be
//   passed in, thus allowing mocking the database for unit tests.

import { Meteor } from "meteor/meteor";
import { SandstormDb } from "/imports/sandstorm-db/db";

let quotaManager;
if (Meteor.isServer) {
  import { LDAP } from "/imports/server/accounts/ldap";
  // Imports are usually not allowed to occur in a block. However, it is the only way to do
  // this under Meteor. Using // jscs:disable doesn't work for what it considers syntax violations,
  // and so we've added this file to .jscsrc's excludedFiles explicitly.

  quotaManager = new LDAP();
} else {
  quotaManager = {
    updateUserQuota(db, user) {
      return {
        storage: user.cachedStorageQuota || 0,
        grains: Infinity,
        compute: Infinity,
      };
    },
  };
}

export const globalDb = new SandstormDb(quotaManager);

export const Packages = globalDb.collections.packages;
export const DevPackages = globalDb.collections.devPackages;
export const UserActions = globalDb.collections.userActions;
export const Grains = globalDb.collections.grains;
export const Contacts = globalDb.collections.contacts;
export const Sessions = globalDb.collections.sessions;
export const SignupKeys = globalDb.collections.signupKeys;
export const ActivityStats = globalDb.collections.activityStats;
export const DeleteStats = globalDb.collections.deleteStats;
export const FileTokens = globalDb.collections.fileTokens;
export const ApiTokens = globalDb.collections.apiTokens;
export const Notifications = globalDb.collections.notifications;
export const StatsTokens = globalDb.collections.statsTokens;
export const Misc = globalDb.collections.misc;

export const currentUserGrains = globalDb.currentUserGrains.bind(globalDb);
export const isDemoUser = globalDb.isDemoUser.bind(globalDb);
export const isSignedUp = globalDb.isSignedUp.bind(globalDb);
export const isSignedUpOrDemo = globalDb.isSignedUpOrDemo.bind(globalDb);
export const isUserOverQuota = globalDb.isUserOverQuota.bind(globalDb);
export const isUserExcessivelyOverQuota = globalDb.isUserExcessivelyOverQuota.bind(globalDb);
export const isAdmin = globalDb.isAdmin.bind(globalDb);
export const isAdminById = globalDb.isAdminById.bind(globalDb);
export const findAdminUserForToken = globalDb.findAdminUserForToken.bind(globalDb);
export const matchWildcardHost = globalDb.matchWildcardHost.bind(globalDb);
export const makeWildcardHost = globalDb.makeWildcardHost.bind(globalDb);
export const allowDevAccounts = globalDb.allowDevAccounts.bind(globalDb);
export const roleAssignmentPattern = globalDb.roleAssignmentPattern;

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

// Keep package-reference knowledge in one place. Generated isolate packages participate in the
// ordinary package lifecycle, but candidates and immutable published revisions are additional
// references which predate user actions and may outlive grains.
async function packageHasReferences(db, pkg) {
  const packageId = pkg._id;
  if (await db.collections.userActions.findOneAsync({ packageId })) return true;
  if (await db.collections.grains.findOneAsync({ packageId })) return true;

  const notificationQuery = {};
  notificationQuery[`appUpdates.${pkg.appId}.packageId`] = packageId;
  if (await db.collections.notifications.findOneAsync(notificationQuery)) return true;
  if (await db.getAppIdForPreinstalledPackage(packageId)) return true;

  if (db.collections.isolateCandidates &&
      await db.collections.isolateCandidates.findOneAsync({ previewPackageId: packageId })) {
    return true;
  }

  if (db.collections.createdIsolateRevisions &&
      await db.collections.createdIsolateRevisions.findOneAsync({ packageId })) {
    return true;
  }

  return false;
}

export { packageHasReferences };

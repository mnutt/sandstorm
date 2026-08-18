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

import Capnp from "/imports/server/capnp";
import { inMeteor } from "/imports/server/async-helpers";
import { getGlobalBackend } from "/imports/server/backend-instance";
import { frontendRefRegistry } from "/imports/server/frontend-ref-registry-instance";
import { PersistentImpl } from "/imports/server/persistent";
import {
  completePublishGrant,
  consumePublishGrant,
  createPublishGrant,
  normalizeIntent,
  requireCommittedCandidate,
  requireOwnKeys,
  requirePublishGrant,
  requireTargetOwnership,
  revokePublishGrantIfUnreferenced,
} from "/imports/server/isolate-publisher-grants";
import { publishIsolateCandidate } from "/imports/server/isolate-publisher-service";

const Authoring = Capnp.importSystem("sandstorm/isolate-authoring.capnp");
const AuthoringImpl = Capnp.importSystem("sandstorm/isolate-authoring-impl.capnp");

const PUBLISHER_FRONTEND_REF = "isolatePublisher";

function schemaIntent(intent) {
  return {
    normalizedDigest: Buffer.from(intent.normalizedDigest, "hex"),
    target: intent.target,
    metadata: {
      title: intent.metadata.title,
      nounPhrase: intent.metadata.nounPhrase,
      shortDescription: intent.metadata.shortDescription,
      marketingVersion: intent.metadata.marketingVersion || "",
    },
  };
}

function publicResult(result) {
  return {
    createdAppId: result.createdAppId,
    revisionId: result.revisionId,
    appId: result.appId,
    appVersion: result.appVersion,
    title: result.title,
  };
}

class IsolatePublisherImpl extends PersistentImpl {
  constructor(db, saveTemplate, grantId) {
    super(db, saveTemplate);
    this.db = db;
    this.grantId = grantId;
  }

  publish(requestId) {
    return inMeteor(async () => {
      let grant = await requirePublishGrant(this.db, this.grantId);
      const candidate = await requireCommittedCandidate(this.db, grant);
      grant = await consumePublishGrant(this.db, grant, requestId);
      if (grant.result) return { result: publicResult(grant.result) };

      const result = await publishIsolateCandidate(
        this.db,
        getGlobalBackend(),
        {
          accountId: grant.ownerId,
          requestingGrainId: grant.requestingGrainId,
          operationScope: `isolate-publish-grant:${grant._id}`,
        },
        requestId,
        candidate._id,
        grant.target,
        grant.metadata);
      await completePublishGrant(this.db, grant, result);
      return { result: publicResult(result) };
    });
  }
}

function makePublisherCapability(db, saveTemplate, grantId) {
  return new Capnp.Capability(
    new IsolatePublisherImpl(db, saveTemplate, grantId),
    AuthoringImpl.PersistentIsolatePublisher);
}

function registerIsolatePublisherFrontendRef(registry) {
  registry.register({
    frontendRefField: PUBLISHER_FRONTEND_REF,
    typeId: Authoring.IsolatePublisher.typeId,

    restore(db, saveTemplate, value) {
      requireOwnKeys(value, ["grantId"], "Saved isolate publication grant");
      return makePublisherCapability(db, saveTemplate, value.grantId);
    },

    async validate(db, session, request) {
      const { grantId, intent, requirements } = await createPublishGrant(db, session, request);
      return {
        descriptor: {
          tags: [{
            id: Authoring.IsolatePublisher.typeId,
            value: Capnp.serialize(Authoring.IsolatePublisher.PowerboxTag, schemaIntent(intent)),
          }],
        },
        requirements,
        frontendRef: { grantId },
      };
    },

    async drop(db, value) {
      requireOwnKeys(value, ["grantId"], "Saved isolate publication grant");
      await revokePublishGrantIfUnreferenced(db, value.grantId);
    },

    async query(db, userAccountId, tagValue) {
      if (!userAccountId || !tagValue) return [];
      let intent;
      try {
        intent = normalizeIntent(Capnp.parse(Authoring.IsolatePublisher.PowerboxTag, tagValue));
      } catch (error) {
        return [];
      }

      const account = await db.collections.users.findOneAsync(userAccountId);
      if (!await db.isAccountSignedUpOrDemoAsync(account)) return [];
      let targetApp;
      try {
        targetApp = await requireTargetOwnership(db, userAccountId, intent.target);
      } catch (error) {
        return [];
      }

      const isUpdate = Object.prototype.hasOwnProperty.call(intent.target, "existingApp");
      return [{
        _id: `frontendref-isolate-publisher-${userAccountId}`,
        frontendRef: {
          [PUBLISHER_FRONTEND_REF]: {
            accountId: userAccountId,
            normalizedDigest: intent.normalizedDigest,
            target: intent.target,
            metadata: intent.metadata,
          },
        },
        cardTemplate: "isolatePublisherPowerboxCard",
        publishIntent: {
          action: isUpdate ? "Publish an update to" : "Publish a new app",
          title: intent.metadata.title,
          targetTitle: targetApp && targetApp.title,
          digest: intent.normalizedDigest,
        },
      }];
    },
  });
}

registerIsolatePublisherFrontendRef(frontendRefRegistry);

export {
  registerIsolatePublisherFrontendRef,
};

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
import { requestIsolateCandidateCleanup } from "/imports/server/isolate-candidates";
import { normalizeGeneratedIsolateMetadata } from
  "/imports/server/isolate-package-service";
import { previewIsolateBundle } from "/imports/server/isolate-preview-service";
import { watchIsolatePreviewLog } from "/imports/server/isolate-preview-log";
import {
  createPreviewGrant,
  fail,
  ownKeys,
  receivePreviewBundle,
  revokePreviewGrantIfUnreferenced,
  requirePreviewGrant,
} from "/imports/server/isolate-previewer-service";

const Authoring = Capnp.importSystem("sandstorm/isolate-authoring.capnp");
const AuthoringImpl = Capnp.importSystem("sandstorm/isolate-authoring-impl.capnp");
const ByteStream = Capnp.importSystem("sandstorm/util.capnp").ByteStream;

const PREVIEWER_FRONTEND_REF = "isolatePreviewer";
const CANDIDATE_FRONTEND_REF = "isolateCandidate";

function candidateInfo(candidate) {
  return {
    normalizedDigest: Buffer.from(candidate.normalizedDigest, "hex"),
    compatibilityDate: candidate.bundleInfo.compatibilityDate,
    compatibilityFlags: candidate.bundleInfo.compatibilityFlags,
    modules: candidate.bundleInfo.modules,
    validationWarnings: candidate.validationWarnings || [],
    createdAt: String(BigInt(candidate.createdAt.getTime()) * 1000000n),
    bindings: candidate.platformBindings || [],
  };
}

class IsolateCandidateImpl extends PersistentImpl {
  constructor(db, saveTemplate, candidateId) {
    super(db, saveTemplate);
    this.db = db;
    this.candidateId = candidateId;
  }

  getInfo() {
    return inMeteor(async () => {
      const value = await this.db.collections.isolateCandidates.findOneAsync(this.candidateId);
      if (!value) fail("candidate-not-found", "The isolate candidate no longer exists.");
      return { info: candidateInfo(value) };
    });
  }
}

function makeCandidateCapability(db, candidate, grant) {
  const requirements = [{
    permissionsHeld: {
      accountId: grant.ownerId,
      grainId: grant.requestingGrainId,
      permissions: [],
    },
  }];
  const saveTemplate = {
    frontendRef: { [CANDIDATE_FRONTEND_REF]: { candidateId: candidate._id } },
    requirements,
  };
  return new Capnp.Capability(
    new IsolateCandidateImpl(db, saveTemplate, candidate._id),
    AuthoringImpl.PersistentIsolateCandidate);
}

class IsolatePreviewerImpl extends PersistentImpl {
  constructor(db, saveTemplate, grantId) {
    super(db, saveTemplate);
    this.db = db;
    this.grantId = grantId;
  }

  preview(requestId, bundle, metadata) {
    return inMeteor(async () => {
      const grant = await requirePreviewGrant(this.db, this.grantId);
      const packageMetadata = normalizeGeneratedIsolateMetadata({
        appTitle: metadata && metadata.appTitle,
        nounPhrase: metadata && metadata.nounPhrase,
        shortDescription: metadata && metadata.shortDescription,
        appVersion: 0,
        marketingVersion: "preview",
      });
      const backend = getGlobalBackend();
      const { actor, snapshot, packageUpload } = await receivePreviewBundle(
        this.db, grant, bundle, {
        wrapByteStream: stream => new Capnp.Capability(stream, ByteStream),
        wrapReceiver: receiver => new Capnp.Capability(receiver, Authoring.BundleReceiver),
      }, {
        backendCap: backend.cap(),
        metadata: packageMetadata,
      });
      try {
        await requirePreviewGrant(this.db, this.grantId);
        const result = await previewIsolateBundle(
          this.db,
          backend,
          actor,
          requestId,
          snapshot,
          packageMetadata,
          {
            requireActive: async () => await requirePreviewGrant(this.db, this.grantId),
            packageUpload,
          });
        const { makePersistentUiView } = await import("/imports/server/core");
        const view = await makePersistentUiView(this.db, {
          grainId: result.grainId,
          accountId: grant.ownerId,
        }, result.grainId);
        return {
          candidate: makeCandidateCapability(this.db, result.candidate, grant),
          view,
        };
      } finally {
        if (packageUpload && typeof packageUpload.close === "function") packageUpload.close();
      }
    });
  }

  watchPreviewLog(normalizedDigest, backlogAmount, stream) {
    return inMeteor(async () => {
      const grant = await requirePreviewGrant(this.db, this.grantId);
      return await watchIsolatePreviewLog(
        this.db,
        getGlobalBackend(),
        grant,
        normalizedDigest,
        backlogAmount,
        stream,
      );
    });
  }
}

function makePreviewerCapability(db, saveTemplate, grantId) {
  return new Capnp.Capability(
    new IsolatePreviewerImpl(db, saveTemplate, grantId),
    AuthoringImpl.PersistentIsolatePreviewer);
}

function registerIsolatePreviewerFrontendRefs(registry) {
  registry.register({
    frontendRefField: PREVIEWER_FRONTEND_REF,
    typeId: Authoring.IsolatePreviewer.typeId,

    restore(db, saveTemplate, value) {
      ownKeys(value, ["grantId"], "Saved isolate preview grant");
      return makePreviewerCapability(db, saveTemplate, value.grantId);
    },

    async validate(db, session, request) {
      const { grantId, requirements } = await createPreviewGrant(db, session, request);

      return {
        descriptor: {
          tags: [{
            id: Authoring.IsolatePreviewer.typeId,
            value: Capnp.serialize(Authoring.IsolatePreviewer.PowerboxTag, {}),
          }],
        },
        requirements,
        frontendRef: { grantId },
      };
    },

    async drop(db, value) {
      ownKeys(value, ["grantId"], "Saved isolate preview grant");
      await revokePreviewGrantIfUnreferenced(db, value.grantId);
    },

    async query(db, userAccountId, tagValue) {
      if (!userAccountId) return [];
      if (tagValue) Capnp.parse(Authoring.IsolatePreviewer.PowerboxTag, tagValue);
      const account = await db.collections.users.findOneAsync(userAccountId);
      if (!await db.isAccountSignedUpOrDemoAsync(account)) return [];
      return [{
        _id: `frontendref-isolate-previewer-${userAccountId}`,
        frontendRef: { [PREVIEWER_FRONTEND_REF]: { accountId: userAccountId } },
        cardTemplate: "isolatePreviewerPowerboxCard",
        accountTitle: account.profile && account.profile.name,
      }];
    },
  });

  registry.register({
    frontendRefField: CANDIDATE_FRONTEND_REF,

    restore(db, saveTemplate, value) {
      ownKeys(value, ["candidateId"], "Saved isolate candidate");
      return new Capnp.Capability(
        new IsolateCandidateImpl(db, saveTemplate, value.candidateId),
        AuthoringImpl.PersistentIsolateCandidate);
    },

    async drop(db, value) {
      ownKeys(value, ["candidateId"], "Saved isolate candidate");
      await requestIsolateCandidateCleanup(db, value.candidateId);
    },
  });
}

registerIsolatePreviewerFrontendRefs(frontendRefRegistry);

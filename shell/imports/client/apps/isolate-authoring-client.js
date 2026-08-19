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
import { Random } from "meteor/random";
import { ReactiveVar } from "meteor/reactive-var";
import { Template } from "meteor/templating";
import { Router } from "meteor/vlasky:galvanized-iron-router";
import { highlight } from "sugar-high";

import { globalDb } from "/imports/db-deprecated";
import { globalSubs } from "/imports/client/shell-client";
import { globalGrains } from "/imports/client/shell-state";
import { IsolatePreviewPane } from "/imports/client/apps/isolate-preview-pane";

import "/imports/client/apps/styles/isolate-authoring.scss";

const DRAFT_STORAGE_PREFIX = "sandstorm-isolate-authoring-draft-v1:";
const DEFAULT_SOURCE = `export default {
  fetch(request) {
    const url = new URL(request.url);
    return new Response(
      \`<!doctype html>
      <title>My isolate app</title>
      <h1>Hello from \${url.pathname}</h1>\`,
      { headers: { "content-type": "text/html; charset=UTF-8" } },
    );
  },
};
`;

function storageKey() {
  return DRAFT_STORAGE_PREFIX + (Meteor.userId() || "signed-out");
}

function defaultDraft() {
  return {
    title: "My isolate app",
    nounPhrase: "app",
    shortDescription: "A small app running in a Sandstorm isolate",
    compatibilityDate: "2025-01-01",
    source: DEFAULT_SOURCE,
    preview: null,
  };
}

function isStoredDraft(value) {
  return value && typeof value === "object" &&
    (value.publishTargetId === undefined || typeof value.publishTargetId === "string") &&
    ["title", "nounPhrase", "shortDescription", "compatibilityDate", "source"]
      .every(field => typeof value[field] === "string");
}

function loadDraft() {
  const stored = Meteor._localStorage.getItem(storageKey());
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (isStoredDraft(parsed)) {
        return parsed;
      }
    } catch (error) {
      console.warn("Ignoring an invalid browser-local isolate draft:", error);
    }
  }

  const draft = defaultDraft();
  Meteor._localStorage.setItem(storageKey(), JSON.stringify(draft));
  return draft;
}

function saveDraft(draft) {
  Meteor._localStorage.setItem(storageKey(), JSON.stringify(draft));
}

function snapshotKey(draft) {
  return JSON.stringify({
    title: draft.title,
    nounPhrase: draft.nounPhrase,
    shortDescription: draft.shortDescription,
    compatibilityDate: draft.compatibilityDate,
    source: draft.source,
  });
}

function bundleFromDraft(draft) {
  return {
    formatVersion: 1,
    mainModule: "worker.js",
    compatibilityDate: draft.compatibilityDate,
    compatibilityFlags: [],
    modules: [{ name: "worker.js", type: "esModule", content: draft.source }],
  };
}

function previewMetadata(draft) {
  return {
    appTitle: draft.title,
    nounPhrase: draft.nounPhrase,
    shortDescription: draft.shortDescription,
    appVersion: 0,
    marketingVersion: "draft",
  };
}

function publishMetadata(draft) {
  return {
    title: draft.title,
    nounPhrase: draft.nounPhrase,
    shortDescription: draft.shortDescription,
  };
}

function errorMessage(error) {
  return error && (error.reason || error.message) || "The operation failed.";
}

function setStatus(instance, kind, message) {
  instance.operationStatus.set({ kind, message });
}

function updateDraft(instance, changes) {
  const draft = {
    ...instance.draft.get(),
    ...changes,
    preview: null,
    previewRequest: null,
    publishRequest: null,
  };
  instance.draft.set(draft);
  saveDraft(draft);
}

function matchingPreview(instance) {
  const draft = instance.draft.get();
  if (!draft.preview || draft.preview.snapshotKey !== snapshotKey(draft)) return null;
  return draft.preview;
}

function currentPreview(instance) {
  const preview = matchingPreview(instance);
  if (!preview || preview.publishedRevisionId) return null;
  return preview;
}

function currentCandidateRecord(instance) {
  const preview = matchingPreview(instance);
  if (!preview) return null;
  return globalDb.collections.isolateCandidates.findOne(preview.candidateId) || preview;
}

async function publish(instance, target) {
  const preview = currentPreview(instance);
  if (!preview || instance.busy.get()) return false;

  instance.busy.set(true);
  setStatus(instance, "working", "Publishing the reviewed candidate…");
  try {
    let draft = instance.draft.get();
    const inputKey = JSON.stringify({
      candidateId: preview.candidateId,
      target,
      metadata: publishMetadata(draft),
    });
    const publishRequest = draft.publishRequest && draft.publishRequest.inputKey === inputKey ?
      draft.publishRequest : { inputKey, requestId: `publish_${Random.id()}` };
    draft = { ...draft, publishRequest };
    instance.draft.set(draft);
    saveDraft(draft);
    const result = await Meteor.callAsync(
      "isolateAuthoringPublish",
      publishRequest.requestId,
      preview.candidateId,
      target,
      publishMetadata(draft),
    );
    const updated = {
      ...draft,
      preview: { ...preview, publishedRevisionId: result.revisionId },
      publishRequest: null,
      publishTargetId: result.createdAppId,
    };
    instance.draft.set(updated);
    saveDraft(updated);
    setStatus(instance, "success", `Published ${result.title} version ${result.appVersion}.`);
    return true;
  } catch (error) {
    setStatus(instance, "error", errorMessage(error));
    return false;
  } finally {
    instance.busy.set(false);
  }
}

Router.map(function () {
  this.route("isolateAuthoring", {
    path: "/apps/create",
    template: "isolateAuthoringPage",
    waitOn: function () {
      return globalSubs.concat(Meteor.subscribe("isolateAuthoringState"));
    },
    data: function () {
      if (!Meteor.userId() && !Meteor.loggingIn()) {
        Router.go("root", {}, { replaceState: true });
        return;
      }

      return { _db: globalDb };
    },
  });
});

Template.isolateAuthoringPage.onCreated(function () {
  this.draft = new ReactiveVar(loadDraft());
  this.busy = new ReactiveVar(false);
  this.operationStatus = new ReactiveVar(null);
  this.previewError = new ReactiveVar(null);
  this.previewTarget = new ReactiveVar(null);
  this.metadataDraft = new ReactiveVar(null);
  this.detailsModalOpen = new ReactiveVar(false);
  this.publishModalOpen = new ReactiveVar(false);
  this.selectedPublishTarget = new ReactiveVar(null);
  this.dismissDetailsModal = () => this.detailsModalOpen.set(false);
  this.dismissPublishModal = () => this.publishModalOpen.set(false);
  this.previewPane = null;
});

Template.isolateAuthoringPage.onRendered(function () {
  this.previewPane = new IsolatePreviewPane(
    globalDb,
    globalGrains,
    this.find(".isolate-preview-frame-mount"),
    this.find(".isolate-preview-log-mount"));
});

Template.isolateAuthoringPage.onDestroyed(function () {
  if (this.previewPane) this.previewPane.destroy();
});

Template.isolateAuthoringPage.helpers({
  setDocumentTitle() {
    const data = Template.instance().data;
    if (data && data._db) document.title = `Create app · ${data._db.getServerTitle()}`;
  },

  draft() {
    return Template.instance().draft.get();
  },

  highlightedSource() {
    const source = Template.instance().draft.get().source;
    // The HTML renderer separates line spans with newline text nodes. Remove those separators
    // because the editor lays out each line span as its own row.
    return highlight(source, { lang: "javascript" })
      .replace(/\n(?=<span class="sh__line)/g, "");
  },

  busy() {
    return Template.instance().busy.get();
  },

  operationStatus() {
    return Template.instance().operationStatus.get();
  },

  previewError() {
    return Template.instance().previewError.get();
  },

  currentCandidate() {
    return currentCandidateRecord(Template.instance());
  },

  candidateCompatibilityDate() {
    const candidate = currentCandidateRecord(Template.instance());
    return candidate?.normalizedBundle?.compatibilityDate;
  },

  candidateCompatibilityFlags() {
    const candidate = currentCandidateRecord(Template.instance());
    return candidate?.normalizedBundle?.compatibilityFlags || [];
  },

  candidateBindings() {
    return currentCandidateRecord(Template.instance())?.platformBindings || [];
  },

  candidateValidationWarnings() {
    return currentCandidateRecord(Template.instance())?.validationWarnings || [];
  },

  previewTarget() {
    return Template.instance().previewTarget.get();
  },

  previewDigest() {
    const target = Template.instance().previewTarget.get();
    if (!target) return "";
    return `${target.normalizedDigest.slice(0, 12)}…`;
  },

  resetDisabled() {
    if (Template.instance().busy.get()) return true;
    const slot = globalDb.collections.isolatePreviewSlots.findOne();
    return !(slot && slot.grainId || matchingPreview(Template.instance())?.grainId);
  },

  publishDisabled() {
    return Template.instance().busy.get() || !currentPreview(Template.instance());
  },

  detailsModalOpen() {
    return Template.instance().detailsModalOpen.get();
  },

  dismissDetailsModal() {
    return Template.instance().dismissDetailsModal;
  },

  metadataDraft() {
    return Template.instance().metadataDraft.get();
  },

  publishModalOpen() {
    return Template.instance().publishModalOpen.get();
  },

  dismissPublishModal() {
    return Template.instance().dismissPublishModal;
  },

  publishTargetApp() {
    const createdAppId = Template.instance().selectedPublishTarget.get();
    return createdAppId && globalDb.collections.createdIsolateApps.findOne(createdAppId);
  },

  publishTargetNextVersion() {
    const createdAppId = Template.instance().selectedPublishTarget.get();
    const app = createdAppId && globalDb.collections.createdIsolateApps.findOne(createdAppId);
    return app && app.appVersion + 1;
  },

  selectedRevisionHistory() {
    const createdAppId = Template.instance().selectedPublishTarget.get();
    if (!createdAppId) return [];
    return globalDb.collections.createdIsolateRevisions.find(
      { createdAppId }, { sort: { publishedAt: -1 } }).fetch();
  },

  revisionVersion() {
    return this.metadataSnapshot && this.metadataSnapshot.appVersion;
  },

  publishedAtIso() {
    return this.publishedAt instanceof Date ? this.publishedAt.toISOString() : "";
  },

  publishedAtLabel() {
    return this.publishedAt instanceof Date ? this.publishedAt.toLocaleString() : "";
  },
});

Template.isolateAuthoringPage.events({
  "input .source-editor textarea"(event, instance) {
    updateDraft(instance, { source: event.currentTarget.value });
  },

  async "click .preview-draft"(event, instance) {
    event.preventDefault();
    if (instance.busy.get()) return;

    instance.busy.set(true);
    instance.previewError.set(null);
    setStatus(instance, "working", "Validating and starting the preview…");
    try {
      let draft = instance.draft.get();
      const inputKey = snapshotKey(draft);
      const previewRequest = draft.previewRequest && draft.previewRequest.inputKey === inputKey ?
        draft.previewRequest : { inputKey, requestId: `preview_${Random.id()}` };
      draft = { ...draft, previewRequest };
      instance.draft.set(draft);
      saveDraft(draft);
      const result = await Meteor.callAsync(
        "isolateAuthoringPreview",
        previewRequest.requestId,
        bundleFromDraft(draft),
        previewMetadata(draft),
      );
      const preview = {
        ...result.candidate,
        grainId: result.grainId,
        snapshotKey: snapshotKey(draft),
      };
      const updated = { ...draft, preview, previewRequest: null };
      instance.draft.set(updated);
      saveDraft(updated);
      const target = {
        grainId: result.grainId,
        normalizedDigest: result.candidate.normalizedDigest,
      };
      instance.previewTarget.set(target);
      instance.previewPane.show(target);
      instance.operationStatus.set(null);
    } catch (error) {
      instance.operationStatus.set(null);
      instance.previewError.set({ message: errorMessage(error) });
    } finally {
      instance.busy.set(false);
    }
  },

  "click .edit-app-details"(event, instance) {
    event.preventDefault();
    const draft = instance.draft.get();
    instance.metadataDraft.set({
      title: draft.title,
      nounPhrase: draft.nounPhrase,
      shortDescription: draft.shortDescription,
      compatibilityDate: draft.compatibilityDate,
    });
    instance.detailsModalOpen.set(true);
  },

  "input .edit-app-details-form input"(event, instance) {
    const metadata = instance.metadataDraft.get();
    if (!metadata || !event.currentTarget.name) return;
    instance.metadataDraft.set({
      ...metadata,
      [event.currentTarget.name]: event.currentTarget.value,
    });
  },

  "submit .edit-app-details-form"(event, instance) {
    event.preventDefault();
    const metadata = instance.metadataDraft.get();
    if (!metadata) return;
    updateDraft(instance, metadata);
    instance.detailsModalOpen.set(false);
  },

  "click .cancel-app-details"(event, instance) {
    event.preventDefault();
    instance.detailsModalOpen.set(false);
  },

  async "click .reset-preview"(event, instance) {
    event.preventDefault();
    if (instance.busy.get()) return;

    instance.busy.set(true);
    setStatus(instance, "working", "Replacing the preview grain and its data…");
    try {
      const draft = instance.draft.get();
      const result = await Meteor.callAsync("isolateAuthoringResetPreview");
      const preview = currentPreview(instance);
      const updated = {
        ...draft,
        preview: preview && { ...preview, grainId: result.grainId },
      };
      instance.draft.set(updated);
      saveDraft(updated);
      const target = instance.previewTarget.get();
      if (target && preview) {
        const replacement = {
          grainId: result.grainId,
          normalizedDigest: preview.normalizedDigest,
        };
        instance.previewTarget.set(replacement);
        instance.previewPane.show(replacement);
      }
      setStatus(instance, "success", "Preview data was reset in a replacement grain.");
    } catch (error) {
      setStatus(instance, "error", errorMessage(error));
    } finally {
      instance.busy.set(false);
    }
  },

  "click .open-publish-modal"(event, instance) {
    event.preventDefault();
    const preferredTarget = instance.draft.get().publishTargetId;
    const preferredApp = preferredTarget &&
      globalDb.collections.createdIsolateApps.findOne(preferredTarget);
    instance.selectedPublishTarget.set(preferredApp ? preferredTarget : null);
    instance.publishModalOpen.set(true);
  },

  async "submit .publish-isolate-form"(event, instance) {
    event.preventDefault();
    const createdAppId = instance.selectedPublishTarget.get();
    const target = createdAppId ? { existingApp: createdAppId } : { newApp: null };
    if (await publish(instance, target)) instance.publishModalOpen.set(false);
  },

  "click .cancel-publish"(event, instance) {
    event.preventDefault();
    instance.publishModalOpen.set(false);
  },

  "click .reload-inline-preview"(event, instance) {
    event.preventDefault();
    instance.previewPane.reload();
  },

});

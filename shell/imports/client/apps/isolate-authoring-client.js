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

import { globalDb } from "/imports/db-deprecated";
import { globalSubs } from "/imports/client/shell-client";
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
    authoringSessionId: `authoring_${Random.id()}`,
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
    typeof value.authoringSessionId === "string" &&
    /^[A-Za-z0-9_-]{8,128}$/.test(value.authoringSessionId) &&
    ["title", "nounPhrase", "shortDescription", "compatibilityDate", "source"]
      .every(field => typeof value[field] === "string");
}

function loadDraft() {
  const stored = Meteor._localStorage.getItem(storageKey());
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (isStoredDraft(parsed)) return parsed;
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
  instance.publishedResult.set(null);
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

async function publish(instance, target) {
  const preview = currentPreview(instance);
  if (!preview || instance.busy.get()) return;

  instance.busy.set(true);
  instance.publishedResult.set(null);
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
      draft.authoringSessionId,
      publishRequest.requestId,
      preview.candidateId,
      target,
      publishMetadata(draft),
    );
    const updated = {
      ...draft,
      preview: { ...preview, publishedRevisionId: result.revisionId },
      publishRequest: null,
    };
    instance.draft.set(updated);
    saveDraft(updated);
    instance.publishedResult.set(result);
    setStatus(instance, "success", `Published ${result.title} version ${result.appVersion}.`);
  } catch (error) {
    setStatus(instance, "error", errorMessage(error));
  } finally {
    instance.busy.set(false);
  }
}

Router.map(function () {
  this.route("isolateAuthoring", {
    path: "/apps/create",
    template: "isolateAuthoringPage",
    waitOn: function () {
      const draft = loadDraft();
      return globalSubs.concat(
        Meteor.subscribe("isolateAuthoringState", draft.authoringSessionId));
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
  this.publishedResult = new ReactiveVar(null);
  this.previewTarget = new ReactiveVar(null);
  this.previewPane = null;
});

Template.isolateAuthoringPage.onRendered(function () {
  this.previewPane = new IsolatePreviewPane(
    globalDb,
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

  busy() {
    return Template.instance().busy.get();
  },

  operationStatus() {
    return Template.instance().operationStatus.get();
  },

  currentCandidate() {
    const preview = matchingPreview(Template.instance());
    if (!preview) return null;
    return globalDb.collections.isolateCandidates.findOne(preview.candidateId) || preview;
  },

  previewGrainId() {
    const slot = globalDb.collections.isolatePreviewSlots.findOne();
    return slot && slot.grainId || matchingPreview(Template.instance())?.grainId;
  },

  previewTarget() {
    return Template.instance().previewTarget.get();
  },

  previewDigest() {
    const target = Template.instance().previewTarget.get();
    if (!target) return "";
    return `${target.normalizedDigest.slice(0, 12)}…`;
  },

  publishDisabled() {
    return Template.instance().busy.get() || !currentPreview(Template.instance());
  },

  createdApps() {
    return globalDb.collections.createdIsolateApps.find({}, { sort: { updatedAt: -1 } }).fetch();
  },

  hasCreatedApps() {
    return globalDb.collections.createdIsolateApps.find().count() > 0;
  },

  publishedResult() {
    return Template.instance().publishedResult.get();
  },
});

Template.isolateAuthoringPage.events({
  "input input, input textarea"(event, instance) {
    if (!event.currentTarget.name) return;
    updateDraft(instance, { [event.currentTarget.name]: event.currentTarget.value });
  },

  async "submit .isolate-authoring-form"(event, instance) {
    event.preventDefault();
    if (instance.busy.get()) return;

    instance.busy.set(true);
    instance.publishedResult.set(null);
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
        draft.authoringSessionId,
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
      setStatus(instance, "success", "Preview is ready in a hidden grain.");
    } catch (error) {
      setStatus(instance, "error", errorMessage(error));
    } finally {
      instance.busy.set(false);
    }
  },

  async "click .reset-preview"(event, instance) {
    event.preventDefault();
    if (instance.busy.get()) return;

    instance.busy.set(true);
    setStatus(instance, "working", "Replacing the preview grain and its data…");
    try {
      const draft = instance.draft.get();
      const result = await Meteor.callAsync(
        "isolateAuthoringResetPreview", draft.authoringSessionId);
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

  "click .publish-new"(event, instance) {
    event.preventDefault();
    publish(instance, { newApp: null });
  },

  "click .publish-update"(event, instance) {
    event.preventDefault();
    const select = instance.find("select.existing-app");
    if (select && select.value) publish(instance, { existingApp: select.value });
  },

  "click .reload-inline-preview"(event, instance) {
    event.preventDefault();
    instance.previewPane.reload();
  },

  "click .toggle-inline-preview-logs"(event, instance) {
    event.preventDefault();
    instance.previewPane.toggleLogs(event.currentTarget);
  },

  "click .close-inline-preview"(event, instance) {
    event.preventDefault();
    instance.previewPane.close();
    instance.previewTarget.set(null);
  },
});

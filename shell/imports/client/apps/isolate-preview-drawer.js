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
import { ReactiveVar } from "meteor/reactive-var";
import { Template } from "meteor/templating";
import { Tracker } from "meteor/tracker";
import { Blaze } from "meteor/blaze";

import { globalDb } from "/imports/db-deprecated";
import { globalGrains } from "/imports/client/shell-state";
import { IsolatePreviewPane } from "/imports/client/apps/isolate-preview-pane";

class IsolatePreviewDrawer {
  constructor() {
    this.target = new ReactiveVar(null);
    this.blazeView = null;
    this.previewPane = null;
    this.sourceWatcher = null;
  }

  attach(mount, logMount) {
    this.previewPane = new IsolatePreviewPane(globalDb, mount, logMount);
    const target = this.target.get();
    if (target) this.previewPane.show(target);
  }

  detach() {
    if (this.previewPane) this.previewPane.destroy();
    this.previewPane = null;
  }

  show(target) {
    this.target.set({ ...target });
    if (!this.blazeView) {
      const mainContent = document.querySelector("body>.main-content");
      if (!mainContent) throw new Error("The isolate preview drawer has no shell mount.");
      this.blazeView = Blaze.renderWithData(Template.isolatePreviewDrawer, this, mainContent);
    } else if (this.previewPane) {
      this.previewPane.show(target);
    }

    if (!this.sourceWatcher) {
      this.sourceWatcher = Tracker.autorun(() => {
        const currentTarget = this.target.get();
        const active = globalGrains.getActive();
        if (currentTarget && (!active || active.grainId() !== currentTarget.sourceGrainId)) {
          Meteor.defer(() => {
            const latestTarget = this.target.get();
            const latestActive = globalGrains.getActive();
            if (latestTarget &&
                (!latestActive || latestActive.grainId() !== latestTarget.sourceGrainId)) {
              this.close();
            }
          });
        }
      });
    }
  }

  reload() {
    if (this.previewPane) this.previewPane.reload();
  }

  close() {
    if (this.sourceWatcher) this.sourceWatcher.stop();
    this.sourceWatcher = null;
    this.target.set(null);
    if (this.blazeView) Blaze.remove(this.blazeView);
    this.blazeView = null;
  }
}

const isolatePreviewDrawer = new IsolatePreviewDrawer();

Template.isolatePreviewDrawer.onRendered(function () {
  this.data.attach(
    this.find(".isolate-preview-frame-mount"),
    this.find(".isolate-preview-log-mount"));
});

Template.isolatePreviewDrawer.onDestroyed(function () {
  this.data.detach();
});

Template.isolatePreviewDrawer.helpers({
  target() {
    return Template.instance().data.target.get();
  },

  shortDigest() {
    const target = Template.instance().data.target.get();
    return target ? `${target.normalizedDigest.slice(0, 12)}…` : "";
  },
});

Template.isolatePreviewDrawer.events({
  "click .reload-isolate-preview"(event, instance) {
    event.preventDefault();
    instance.data.reload();
  },

});

function showIsolatePreviewDrawer(target) {
  isolatePreviewDrawer.show(target);
}

function closeIsolatePreviewDrawer() {
  isolatePreviewDrawer.close();
}

export {
  closeIsolatePreviewDrawer,
  showIsolatePreviewDrawer,
};

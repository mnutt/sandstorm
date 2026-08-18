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

import { Blaze } from "meteor/blaze";
import { Meteor } from "meteor/meteor";
import { ReactiveVar } from "meteor/reactive-var";
import { Template } from "meteor/templating";

import { GrainLog } from "/imports/client/grain/grain-pseudo-collections";
import { AnsiUp } from "/imports/client/vendor/ansi-up";

class IsolatePreviewLogView {
  constructor(mount, grainId) {
    if (!mount) throw new Error("An isolate preview log requires a mount element.");
    this.mount = mount;
    this.grainId = new ReactiveVar(null);
    this.subscription = null;
    this.blazeView = Blaze.renderWithData(Template.isolatePreviewLog, this, mount);
    this.setGrainId(grainId);
  }

  setGrainId(grainId, force = false) {
    if (typeof grainId !== "string" || grainId.length === 0) {
      throw new Error("An isolate preview log requires a grain ID.");
    }

    if (!force && grainId === this.grainId.get()) return;
    if (this.subscription) this.subscription.stop();
    this.grainId.set(grainId);
    this.subscription = Meteor.subscribe("grainLog", grainId);
  }

  reconnect() {
    const grainId = this.grainId.get();
    if (grainId) this.setGrainId(grainId, true);
  }

  destroy() {
    if (this.subscription) this.subscription.stop();
    this.subscription = null;
    if (this.blazeView) Blaze.remove(this.blazeView);
    this.blazeView = null;
    this.mount = null;
  }
}

Template.isolatePreviewLog.onCreated(function () {
  this.shouldScroll = true;
});

Template.isolatePreviewLog.onRendered(function () {
  this.autorun(() => {
    Template.currentData().grainId.get();
    GrainLog.find({ grainId: Template.currentData().grainId.get() }).count();
    if (!this.shouldScroll) return;
    const contents = this.find(".isolate-preview-log-contents");
    if (contents) contents.scrollTop = contents.scrollHeight;
  });
});

Template.isolatePreviewLog.events({
  "scroll .isolate-preview-log-contents"(event, instance) {
    const contents = event.currentTarget;
    instance.shouldScroll =
      contents.clientHeight + contents.scrollTop + 5 >= contents.scrollHeight;
  },
});

Template.isolatePreviewLog.helpers({
  logHtml() {
    const grainId = Template.instance().data.grainId.get();
    if (!grainId) return "";
    const text = GrainLog.find({ grainId }, { sort: { sequence: 1 } })
      .map(entry => entry.text)
      .join("");
    return AnsiUp.ansi_to_html(text, { use_classes: true });
  },
});

export { IsolatePreviewLogView };

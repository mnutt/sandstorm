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

import { GrainView } from "/imports/client/grain/grainview";

import "/imports/client/apps/styles/isolate-preview-pane.scss";

class IsolatePreviewPane {
  constructor(db, mount) {
    if (!mount) throw new Error("An isolate preview pane requires a mount element.");
    this.db = db;
    this.mount = mount;
    this.grainView = null;
    this.target = null;
  }

  show(target) {
    if (!target || typeof target.grainId !== "string" ||
        typeof target.normalizedDigest !== "string") {
      throw new Error("An isolate preview pane requires a grain and candidate digest.");
    }

    if (this.target && this.target.grainId === target.grainId &&
        this.target.normalizedDigest === target.normalizedDigest) {
      return;
    }

    if (this.grainView && this.target && this.target.grainId === target.grainId) {
      this.target = { ...target };
      this.grainView.reset(!this.grainView.isIncognito());
      this.grainView.openSession();
      return;
    }

    this.close();
    this.target = { ...target };
    this.grainView = new GrainView(null, this.db, target.grainId, "", null, this.mount);
    this.grainView.setActive(true);
    this.grainView.openSession();
  }

  reload() {
    if (!this.grainView) return;
    this.grainView.reset(!this.grainView.isIncognito());
    this.grainView.openSession();
  }

  close() {
    if (this.grainView) this.grainView.destroy();
    this.grainView = null;
    this.target = null;
  }

  destroy() {
    this.close();
    this.mount = null;
  }
}

export { IsolatePreviewPane };

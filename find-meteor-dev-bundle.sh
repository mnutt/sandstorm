#! /bin/bash
#
# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
# All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# This script attempts to find Meteor's "dev bundle", which contains the node
# and mongo binaries and headers, so that we can borrow them rather than making
# users install them separately.
#
# Meteor's warehouse normally provides a version symlink for meteor-tool. Use
# that local mapping first so configuring a build does not query the catalog.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

METEOR_WAREHOUSE_DIR="${METEOR_WAREHOUSE_DIR:-$HOME/.meteor}"

# If we run the meteor tool outside of `shell`, it might try to update itself. Inside `shell`, it
# sees the meteor version we're using and sticks to that.
cd "$SCRIPT_DIR/shell"

METEOR_RELEASE=${1:-$(<.meteor/release)}
CACHE_FILE="../tmp/$METEOR_RELEASE.location"

mkdir -p ../tmp
if [ -s "$CACHE_FILE" ]; then
  cat "$CACHE_FILE"
  exit
fi

RELEASE_VERSION=${METEOR_RELEASE#METEOR@}
LOCAL_DEV_BUNDLE="$METEOR_WAREHOUSE_DIR/packages/meteor-tool/$RELEASE_VERSION/mt-os.linux.x86_64/dev_bundle"
if [ -x "$LOCAL_DEV_BUNDLE/bin/node" ]; then
  readlink -f "$LOCAL_DEV_BUNDLE" > "$CACHE_FILE"
  cat "$CACHE_FILE"
  exit
fi

echo "Locating Meteor dev bundle from the pinned project release..." >&2
NODE_PATH=$(meteor node -p process.execPath)
DEV_BUNDLE=$(dirname "$(dirname "$NODE_PATH")")
test -x "$DEV_BUNDLE/bin/node"
readlink -f "$DEV_BUNDLE" > "$CACHE_FILE"
cat "$CACHE_FILE"

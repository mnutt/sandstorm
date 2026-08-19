# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2026 Sandstorm Development Group, Inc. and contributors
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

@0xb9186301b4de5b90;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Grain = import "grain.capnp";
using Util = import "util.capnp";

interface IsolateBundle @0xc40007b255479838 {
  # Caller-owned immutable source snapshot. Module contents are streamed into a receiver chosen by
  # Sandstorm, so the factory can enforce limits without buffering them in one RPC message.

  getInfo @0 () -> (info :BundleInfo);
  transfer @1 (receiver :BundleReceiver);
  # transfer() must open and complete every declared module, then call receiver.finish().
}

struct BundleInfo {
  formatVersion @0 :UInt16;
  mainModule @1 :Text;
  compatibilityDate @2 :Text;
  compatibilityFlags @3 :List(Text);
  modules @4 :List(ModuleInfo);
}

struct ModuleInfo {
  name @0 :Text;
  type @1 :ModuleType;
  size @2 :UInt64;
}

enum ModuleType {
  esModule @0;
  json @1;
  text @2;
}

interface BundleReceiver @0x85eb330db82a150f {
  beginModule @0 (index :UInt16) -> (stream :Util.ByteStream);
  # Each declared index must be opened exactly once. The stream must receive exactly the size
  # declared by BundleInfo.ModuleInfo and must end with done().

  finish @1 ();
  # Verifies that every module stream completed. No more modules may be opened afterward.
}

interface IsolateCandidate @0xe7ad8c1ea7bd077a {
  # Immutable identity for one normalized snapshot. A separately-authorized publisher grant is
  # bound to the matching server-side candidate when the user approves its Powerbox request.

  getInfo @0 () -> (info :CandidateInfo);
}

struct CandidateInfo {
  normalizedDigest @0 :Data;
  compatibilityDate @1 :Text;
  compatibilityFlags @2 :List(Text);
  modules @3 :List(ModuleInfo);
  validationWarnings @4 :List(Text);
  createdAt @5 :Util.DateInNs;
  bindings @6 :List(Text);
}

struct PreviewMetadata {
  appTitle @0 :Text;
  nounPhrase @1 :Text;
  shortDescription @2 :Text;
}

interface IsolatePreviewer @0xcd90b943c38e24c3 {
  # Lower-authority isolate factory capability. It can validate and run arbitrary isolate source,
  # but cannot install an app action or publish a revision.

  preview @0 (
    requestId :Text,
    bundle :IsolateBundle,
    metadata :PreviewMetadata
  ) -> (
    candidate :IsolateCandidate,
    view :Grain.UiView
  );

  watchPreviewLog @1 (
    normalizedDigest :Data,
    backlogAmount :UInt32 = 8192,
    stream :Util.ByteStream
  ) -> (
    handle :Util.Handle
  );
  # Streams up to backlogAmount bytes from the current preview's debug log, followed by new log
  # output, until handle is dropped. normalizedDigest is only a locator: Sandstorm resolves it
  # again within this grant's owning account and authoring grain. The call fails if the candidate
  # is no longer installed in the hidden preview grain. Sandstorm applies a defensive upper bound
  # to backlogAmount.

  struct PowerboxTag {}
}

struct PublishTarget {
  union {
    newApp @0 :Void;
    existingApp @1 :Text;
    # Internal created-app identity returned by an earlier successful publication.
  }
}

struct AppMetadata {
  title @0 :Text;
  nounPhrase @1 :Text;
  shortDescription @2 :Text;
  marketingVersion @3 :Text;
}

struct PublishedRevision {
  createdAppId @0 :Text;
  revisionId @1 :Text;
  appId @2 :Text;
  appVersion @3 :UInt32;
  title @4 :Text;
}

interface IsolatePublisher @0x9cacf36bd0b3125d {
  # One-shot, higher-authority capability granted for one exact candidate digest, publication
  # target, and metadata snapshot. Restoring a saved copy does not reset its consumption state.

  publish @0 (
    requestId :Text
  ) -> (
    result :PublishedRevision
  );

  struct PowerboxTag {
    normalizedDigest @0 :Data;
    target @1 :PublishTarget;
    metadata @2 :AppMetadata;
  }
}

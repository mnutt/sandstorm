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
  # Immutable identity for one normalized snapshot. This capability, rather than CandidateInfo,
  # must be presented to a separately-authorized publisher.

  getInfo @0 () -> (info :CandidateInfo);
}

struct CandidateInfo {
  normalizedDigest @0 :Data;
  compatibilityDate @1 :Text;
  compatibilityFlags @2 :List(Text);
  modules @3 :List(ModuleInfo);
  validationWarnings @4 :List(Text);
  createdAt @5 :Util.DateInNs;
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

  struct PowerboxTag {}
}

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

@0x9c4c843143858190;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Authoring = import "isolate-authoring.capnp";
using SystemPersistent = import "supervisor.capnp".SystemPersistent;

interface PersistentIsolatePreviewer @0xc81b0d695fdfbe28
    extends (Authoring.IsolatePreviewer, SystemPersistent) {}

interface PersistentIsolateCandidate @0xaf7a381bed64a441
    extends (Authoring.IsolateCandidate, SystemPersistent) {}

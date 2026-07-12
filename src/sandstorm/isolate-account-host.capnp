# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2026 Sandstorm contributors
# Licensed under the Apache License, Version 2.0.

@0xcc0ca57a616f7cf2;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Supervisor = import "supervisor.capnp".Supervisor;
using SandstormCore = import "supervisor.capnp".SandstormCore;

interface IsolateAccountHost {
  # Account-scoped Sandstorm control plane. The process receives its trust domain and filesystem
  # roots at startup, so callers provide only validated opaque IDs and selected manifest fields.

  startGrain @0 (grainId :Text, packageId :Text, mainModule :Text,
                 compatibilityDate :Text, isNew :Bool, core :SandstormCore)
             -> (supervisor :Supervisor);
}

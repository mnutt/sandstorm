// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
// Licensed under the Apache License, Version 2.0.

#include "server.h"

int main() {
  // Keep this initial target deliberately small: it proves that Sandstorm's host binary is built
  // against workerd's in-process Server API rather than shelling out to the npm executable.
  static_assert(sizeof(workerd::server::Server) > 0);
  return 0;
}

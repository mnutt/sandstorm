#!/bin/bash
#
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

set -euo pipefail

THIS_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")

cd "$THIS_DIR"

NIGHTWATCH_PARAMS=(-t benchmarks/node-capnp-baseline.js)

extract_major_version() {
  echo "$1" | sed -E 's/[^0-9]*([0-9]+)\..*/\1/'
}

prepare_repo_local_chrome() {
  local driver_bin="node_modules/chromedriver/lib/chromedriver/chromedriver"
  if [ ! -x "$driver_bin" ]; then
    echo "Missing chromedriver binary at: $driver_bin" >&2
    echo "Install test dependencies first (e.g. npm install in tests/)." >&2
    exit 1
  fi

  local driver_version driver_major
  driver_version="$("$driver_bin" --version | awk '{print $2}')"
  driver_major="$(extract_major_version "$driver_version")"

  echo "Ensuring repo-local Chrome-for-Testing version $driver_version"
  ./node_modules/.bin/browsers \
    install "chrome@$driver_version" --path ./.browsers >/dev/null

  local chrome_bin
  chrome_bin="$(find ./.browsers/chrome -type f -path "*linux-${driver_major}*/chrome-linux64/chrome" | sort | tail -n1)"
  if [ -z "$chrome_bin" ]; then
    chrome_bin="$(find ./.browsers/chrome -type f -path "*/chrome-linux64/chrome" | sort | tail -n1)"
  fi

  if [ -z "$chrome_bin" ] || [ ! -x "$chrome_bin" ]; then
    echo "Failed to locate downloaded Chrome binary under tests/.browsers/chrome" >&2
    exit 1
  fi

  export NIGHTWATCH_CHROME_BINARY="$chrome_bin"
  echo "Using Chrome binary: $NIGHTWATCH_CHROME_BINARY"
}

if [ ! -z "${TESTCASE:-}" ]; then
  read TESTFILE TESTNAME <<< "$TESTCASE"
  if [ -z "$TESTNAME" ]; then
    NIGHTWATCH_PARAMS=(-t "$TESTFILE")
  else
    NIGHTWATCH_PARAMS=(-t "$TESTFILE" --testcase "$TESTNAME")
  fi
fi

prepare_repo_local_chrome

if [[ -z "${LAUNCH_URL:-}" ]]; then
  ./node_modules/.bin/nightwatch -e benchmarks "${NIGHTWATCH_PARAMS[@]}"
else
  sed "s|.*launch_url.*|\"launch_url\" : \"$LAUNCH_URL\",|g" nightwatch.json > nightwatch.benchmarks.tmp.json
  ./node_modules/.bin/nightwatch -e benchmarks -c ./nightwatch.benchmarks.tmp.json \
    "${NIGHTWATCH_PARAMS[@]}"
fi

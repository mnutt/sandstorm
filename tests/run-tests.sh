#!/bin/bash
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

set -euo pipefail

THIS_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")

cd "$THIS_DIR"

export SANDSTORM_DIR="${SANDSTORM_DIR:-/opt/sandstorm}"

test -e assets/ssjekyll5.spk || curl https://sandstorm.io/apps/ssjekyll5.spk > assets/ssjekyll5.spk
test -e assets/ssjekyll6.spk || curl https://sandstorm.io/apps/ssjekyll6.spk > assets/ssjekyll6.spk
test -e assets/ssjekyll7.spk || curl https://sandstorm.io/apps/ssjekyll7.spk > assets/ssjekyll7.spk

NIGHTWATCH_PARAMS=()

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

CHROMEDRIVER_PID=""

stop_chromedriver() {
  if [[ -n "$CHROMEDRIVER_PID" ]] && kill -0 "$CHROMEDRIVER_PID" 2>/dev/null; then
    kill "$CHROMEDRIVER_PID" 2>/dev/null || true
    wait "$CHROMEDRIVER_PID" || true
  fi
  CHROMEDRIVER_PID=""
}

start_chromedriver() {
  local driver_bin="node_modules/chromedriver/lib/chromedriver/chromedriver"
  local driver_log="reports/chromedriver.log"
  local attempt

  mkdir -p reports
  "$driver_bin" --port=4444 > "$driver_log" 2>&1 &
  CHROMEDRIVER_PID=$!
  trap stop_chromedriver EXIT

  for ((attempt = 0; attempt < 100; attempt++)); do
    if ! kill -0 "$CHROMEDRIVER_PID" 2>/dev/null; then
      echo "ChromeDriver exited during startup:" >&2
      cat "$driver_log" >&2
      exit 1
    fi
    if curl --silent --fail --output /dev/null http://127.0.0.1:4444/status; then
      return
    fi
    sleep 0.1
  done

  echo "Timed out waiting for ChromeDriver. Its log follows:" >&2
  cat "$driver_log" >&2
  exit 1
}

if [ ! -z "${TESTCASE:-}" ]; then
  # This is awkward because the test case name usually has spaces, but we need
  # to pass it as a single argument on the command-line. So, we concoct a bash
  # array with TESTNAME containing the name, spacing and all.
  read TESTFILE TESTNAME <<< "$TESTCASE"
  if [ -z "$TESTNAME" ]; then
    NIGHTWATCH_PARAMS=(-t $TESTFILE)
  else
    NIGHTWATCH_PARAMS=(-t $TESTFILE --testcase "$TESTNAME")
  fi
  SKIP_UNITTESTS=true
fi

prepare_repo_local_chrome

if [[ -z "${LAUNCH_URL:-}" ]]; then
  if [[ -z "${SKIP_UNITTESTS:-}" ]]; then
    ../shell/test-packages.sh -f
    nightwatch -e unittests "${NIGHTWATCH_PARAMS[@]}"
  fi
  start_chromedriver
  nightwatch -e default "${NIGHTWATCH_PARAMS[@]}"
else
  sed "s|.*launch_url.*|\"launch_url\" : \"$LAUNCH_URL\",|g" nightwatch.json > nightwatch.tmp.json
  if [[ -z "${SKIP_UNITTESTS:-}" ]]; then
    ../shell/test-packages.sh -f
    nightwatch -e unittests -c ./nightwatch.tmp.json "${NIGHTWATCH_PARAMS[@]}"
  fi
  start_chromedriver
  nightwatch -e default -c ./nightwatch.tmp.json "${NIGHTWATCH_PARAMS[@]}"
fi

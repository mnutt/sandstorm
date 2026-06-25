#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <sandstorm-tarball>" >&2
  exit 1
fi

BUNDLE_PATH=$(readlink -f "$1")
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
INSTANCE=${SANDSTORM_LIMA_INSTANCE:-sandstorm-trusty-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$}
CONFIG_TEMPLATE="$REPO_ROOT/tests/ci/lima-ubuntu-14.04.yaml"
CONFIG_PATH="${TMPDIR:-/tmp}/${INSTANCE}.yaml"
VM_STARTED=0
GUEST_READY=0

case "$BUNDLE_PATH" in
  "$REPO_ROOT"/*)
    GUEST_BUNDLE_PATH="/workspace/${BUNDLE_PATH#"$REPO_ROOT"/}"
    ;;
  *)
    echo "Bundle path must be inside repo: $BUNDLE_PATH" >&2
    exit 1
    ;;
esac

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ] && [ "$GUEST_READY" -eq 1 ]; then
    limactl shell "$INSTANCE" sudo cat /opt/sandstorm/var/log/sandstorm.log 2>/dev/null || true
    limactl shell "$INSTANCE" sudo cat /opt/sandstorm/var/log/mongo.log 2>/dev/null || true
  fi
  if [ "$VM_STARTED" -eq 1 ]; then
    limactl shell "$INSTANCE" sudo /opt/sandstorm/sandstorm stop >/dev/null 2>&1 || true
  fi
  limactl stop "$INSTANCE" >/dev/null 2>&1 || true
  limactl delete -f "$INSTANCE" >/dev/null 2>&1 || true
  rm -f "$CONFIG_PATH"
}
trap cleanup EXIT

escape_for_sed_replacement() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//&/\\&}
  value=${value//|/\\|}
  printf '%s' "$value"
}

sed "s|@SANDSTORM_REPO_ROOT@|$(escape_for_sed_replacement "$REPO_ROOT")|g" \
  "$CONFIG_TEMPLATE" > "$CONFIG_PATH"

if ! timeout 8m limactl start --tty=false --name="$INSTANCE" "$CONFIG_PATH"; then
  cat "$HOME/.lima/$INSTANCE"/serial*.log 2>/dev/null || true
  exit 1
fi
VM_STARTED=1
GUEST_READY=1

limactl shell "$INSTANCE" bash -s -- "$GUEST_BUNDLE_PATH" <<'EOF'
set -euxo pipefail

BUNDLE_PATH=$1
export DEBIAN_FRONTEND=noninteractive

uname -a

apt_get_update() {
  apt-get -o Acquire::Check-Valid-Until=false update
}

if [ -f /etc/apt/sources.list ]; then
  sed -i \
    -e "s|http://[^ ]*archive.ubuntu.com/ubuntu|http://old-releases.ubuntu.com/ubuntu|g" \
    -e "s|http://security.ubuntu.com/ubuntu|http://old-releases.ubuntu.com/ubuntu|g" \
    /etc/apt/sources.list
fi
apt_get_update

apt-get install -y --no-install-recommends \
  adduser \
  ca-certificates \
  curl \
  openssl \
  procps \
  psmisc \
  sudo \
  xz-utils

export OVERRIDE_SANDSTORM_DEFAULT_DIR=/opt/sandstorm
/workspace/install.sh -d -p 6080 "$BUNDLE_PATH"

cat >> /opt/sandstorm/sandstorm.conf <<'CONFIG_EOF'
UPDATE_CHANNEL=none
PORT=6080
MONGO_PORT=6081
BIND_IP=0.0.0.0
BASE_URL=http://local.sandstorm.io:6080
WILDCARD_HOST=*.local.sandstorm.io:6080
CONFIG_EOF

/opt/sandstorm/sandstorm stop || true
/opt/sandstorm/sandstorm start

for i in $(seq 1 120); do
  if curl -fsS --resolve local.sandstorm.io:6080:127.0.0.1 \
      http://local.sandstorm.io:6080/ >/dev/null; then
    exit 0
  fi
  sleep 1
done

cat /opt/sandstorm/var/log/sandstorm.log || true
cat /opt/sandstorm/var/log/mongo.log || true
exit 1
EOF

node "$REPO_ROOT/tests/ci/grain-smoke.mjs"

#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <distro-name> <docker-image> <sandstorm-tarball>" >&2
  exit 1
fi

DISTRO_NAME=$1
DOCKER_IMAGE=$2
BUNDLE_PATH=$(readlink -f "$3")
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CONTAINER_NAME="sandstorm-smoke-${DISTRO_NAME//[^a-zA-Z0-9_.-]/-}-${GITHUB_RUN_ID:-local}-$$"

case "$BUNDLE_PATH" in
  "$REPO_ROOT"/*)
    CONTAINER_BUNDLE_PATH="/workspace/${BUNDLE_PATH#"$REPO_ROOT"/}"
    ;;
  *)
    echo "Bundle path must be inside repo: $BUNDLE_PATH" >&2
    exit 1
    ;;
esac

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    docker exec "$CONTAINER_NAME" bash -lc \
      'cat /opt/sandstorm/var/log/sandstorm.log 2>/dev/null || true; cat /opt/sandstorm/var/log/mongo.log 2>/dev/null || true' \
      || true
  fi
  docker exec "$CONTAINER_NAME" /opt/sandstorm/sandstorm stop >/dev/null 2>&1 || true
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --rm --privileged -d \
  --name "$CONTAINER_NAME" \
  -p 6080:6080 \
  -v "$REPO_ROOT:/workspace" \
  -w /workspace \
  "$DOCKER_IMAGE" \
  sleep infinity

docker exec -i "$CONTAINER_NAME" \
  bash -s -- "$CONTAINER_BUNDLE_PATH" <<'EOF'
set -euxo pipefail

BUNDLE_PATH=$1
export DEBIAN_FRONTEND=noninteractive

install_with_yum() {
  if ! yum makecache -y; then
    if [ -d /etc/yum.repos.d ]; then
      sed -i \
        -e 's/^mirrorlist=/#mirrorlist=/g' \
        -e 's|^#baseurl=http://mirror.centos.org/centos/$releasever|baseurl=http://vault.centos.org/7.9.2009|g' \
        -e 's|^baseurl=http://mirror.centos.org/centos/$releasever|baseurl=http://vault.centos.org/7.9.2009|g' \
        /etc/yum.repos.d/CentOS-*.repo || true
    fi
    yum makecache -y
  fi

  yum install -y \
    ca-certificates \
    curl \
    openssl \
    procps-ng \
    psmisc \
    shadow-utils \
    sudo \
    initscripts \
    tar \
    which \
    xz
}

install_with_apt() {
  apt_get_update() {
    apt-get -o Acquire::Check-Valid-Until=false update
  }

  if ! apt_get_update; then
    if [ -f /etc/apt/sources.list ]; then
      sed -i \
        -e "s|http://archive.ubuntu.com/ubuntu|http://old-releases.ubuntu.com/ubuntu|g" \
        -e "s|http://security.ubuntu.com/ubuntu|http://old-releases.ubuntu.com/ubuntu|g" \
        -e "s|http://deb.debian.org/debian-security|http://archive.debian.org/debian-security|g" \
        -e "s|http://security.debian.org/debian-security|http://archive.debian.org/debian-security|g" \
        -e "s|http://deb.debian.org/debian|http://archive.debian.org/debian|g" \
        -e "s|http://ftp.debian.org/debian|http://archive.debian.org/debian|g" \
        /etc/apt/sources.list
      sed -i '/-updates/d' /etc/apt/sources.list
    fi
    apt_get_update
  fi

  apt-get install -y --no-install-recommends \
    adduser \
    ca-certificates \
    curl \
    openssl \
    procps \
    psmisc \
    sudo \
    xz-utils
}

if command -v apt-get >/dev/null 2>&1; then
  install_with_apt
elif command -v yum >/dev/null 2>&1; then
  install_with_yum
else
  echo "No supported package manager found." >&2
  exit 1
fi

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

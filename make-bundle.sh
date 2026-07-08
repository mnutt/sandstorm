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

set -euo pipefail
shopt -s extglob

SOURCE_ROOT=${SANDSTORM_SOURCE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
NATIVE_STAGE=${SANDSTORM_NATIVE_STAGE:-$SOURCE_ROOT}
SHELL_BUILD_DIR=${SANDSTORM_SHELL_BUILD_DIR:-$SOURCE_ROOT/shell-build}
BUNDLE_DIR=${SANDSTORM_BUNDLE_DIR:-$SOURCE_ROOT/bundle}
WORK_DIR=${SANDSTORM_WORK_DIR:-$SOURCE_ROOT/tmp}
CACHE_DIR=${SANDSTORM_CACHE_DIR:-$SOURCE_ROOT/hack}
NODE_MODULES_DIR=${SANDSTORM_NODE_MODULES_DIR:-$NATIVE_STAGE/node_modules}
CAPNP_ES_NPM_DIR=${SANDSTORM_CAPNP_ES_NPM_DIR:-$SOURCE_ROOT/tmp/capnp-es-npm}

mkdir -p "$WORK_DIR" "$CACHE_DIR"
rm -rf "$BUNDLE_DIR"
: > "$WORK_DIR/host.list"

fail() {
  echo "make-bundle.sh: FAILED at line $1" >&2
  rm -rf "$BUNDLE_DIR"
  exit 1
}

trap 'fail ${LINENO}' ERR

secureCurlDownload() {
  curl --proto '=https' --tlsv1.2 --output "$1" "$2"
}

verifySha256() {
  local path=$1
  local sha256=$2
  local label=$3

  if ! sha256sum --check <<EOF
$sha256 *$path
EOF
  then
    echo "$label did not match expected checksum.  Aborting."
    exit 1
  fi
}

copyDep() {
  # Copies a file from the system into the chroot.

  local FILE=$1
  local DST="$BUNDLE_DIR${FILE/#\/usr\/local/\/usr}"

  if [ -e "$DST" ]; then
    # already copied
    :
  elif [[ "$FILE" == /etc/* ]]; then
    # We'll want to copy configuration (e.g. for DNS) from the host at runtime.
    if [ -f "$FILE" ]; then
      echo "$FILE" >> "$WORK_DIR/host.list"
    fi
  elif [ -h "$FILE" ]; then
    # Symbolic link.
    # We copy over the target, and recreate the link.
    # Currently we denormalize the link because I'm not sure how to follow
    # one link at a time in bash (since readlink without -f gives a relative
    # path and I'm not sure how to interpret that against the link's path).
    # I'm sure there's a way, but whatever...
    mkdir -p $(dirname "$DST")
    local LINK=$(readlink -f "$FILE")
    ln -sf "${LINK/#\/usr\/local/\/usr}" "$DST"
    copyDep "$LINK"
  elif [ -d "$FILE" ]; then
    # Directory.  Make it, but don't copy contents; we'll do that later.
    mkdir -p "$DST"
  elif [ -f "$FILE" ]; then
    # Regular file.  Copy it over.
    mkdir -p $(dirname "$DST")
    cp "$FILE" "$DST"
  fi
}

copyDeps() {
  # Reads filenames on stdin and copies them into the chroot.

  while read FILE; do
    copyDep "$FILE"
  done
}

# Check for requiremnets.
for CMD in zip unzip xz gpg; do
  if ! which "$CMD" > /dev/null; then
    echo "Please install $CMD" >&2
    fail ${LINENO}
  fi
done

METEOR_DEV_BUNDLE=$("$SOURCE_ROOT/find-meteor-dev-bundle.sh")

# Start with the meteor bundle.
cp -r "$SHELL_BUILD_DIR/bundle" "$BUNDLE_DIR"
rm -f "$BUNDLE_DIR/README"
cp "$SOURCE_ROOT/meteor-bundle-main.js" "$BUNDLE_DIR/sandstorm-main.js"

# Meteor wants us to do `npm install` in the bundle to prepare it. Its generated server manifest
# pins build helpers that have since received security fixes, so update those pins before install.
# Native extensions must use Meteor's Node and build helpers rather than whatever is first on the
# host PATH.
(cd "$BUNDLE_DIR/programs/server" && \
 chmod u+w package.json npm-shrinkwrap.json && \
 PATH=$METEOR_DEV_BUNDLE/lib/node_modules/.bin:$METEOR_DEV_BUNDLE/bin:$PATH \
   "$METEOR_DEV_BUNDLE/bin/npm" pkg set \
     dependencies.underscore=1.13.8 \
     dependencies.node-gyp=12.4.0 \
     dependencies.@mapbox/node-pre-gyp=2.0.3 && \
 PATH=$METEOR_DEV_BUNDLE/lib/node_modules/.bin:$METEOR_DEV_BUNDLE/bin:$PATH \
   "$METEOR_DEV_BUNDLE/bin/npm" install --omit=dev --no-audit && \
 PATH=$METEOR_DEV_BUNDLE/lib/node_modules/.bin:$METEOR_DEV_BUNDLE/bin:$PATH \
   "$METEOR_DEV_BUNDLE/bin/npm" audit --omit=dev --audit-level=high)

# Ensure node-capnp is present where server startup looks first
# (process.cwd() starts at /programs/server in the runtime chroot).
mkdir -p "$BUNDLE_DIR/programs/server/node_modules"
cp "$NODE_MODULES_DIR/capnp.js" "$BUNDLE_DIR/programs/server/node_modules/capnp.js"
cp "$NODE_MODULES_DIR/capnp.node" "$BUNDLE_DIR/programs/server/node_modules/capnp.node"

# Copy over key binaries.
mkdir -p "$BUNDLE_DIR/bin"
cp "$NATIVE_STAGE/bin/sandstorm-http-bridge" "$BUNDLE_DIR/bin/sandstorm-http-bridge"
cp "$NATIVE_STAGE/bin/sandstorm" "$BUNDLE_DIR/sandstorm"
cp "$NATIVE_STAGE/bin/workerd" "$BUNDLE_DIR/bin/workerd"
cp "$METEOR_DEV_BUNDLE/bin/node" "$BUNDLE_DIR/bin"

# We used to pull mongodb out of the meteor dev bundle, but we need to figure out how to safely
# upgrade some databases created with very old mongo versions, so we're shipping mongo 2.6 for
# now.
#cp $METEOR_DEV_BUNDLE/mongodb/bin/{mongo,mongod} bundle/bin

# Pull mongo v2.6 out of a previous Sandstorm package.
OLD_BUNDLE_BASE=sandstorm-171
OLD_BUNDLE_FILENAME=$OLD_BUNDLE_BASE.tar.xz
OLD_BUNDLE_PATH="$CACHE_DIR/$OLD_BUNDLE_FILENAME"
OLD_BUNDLE_SHA256=ebffd643dffeba349f139bee34e4ce33fd9b1298fafc1d6a31eb35a191059a99
OLD_MONGO_FILES="$OLD_BUNDLE_BASE/bin/mongo $OLD_BUNDLE_BASE/bin/mongod"
if [ ! -e "$OLD_BUNDLE_PATH" ] ; then
  echo "Fetching $OLD_BUNDLE_FILENAME to extract a mongo 2.6..."
  secureCurlDownload "$OLD_BUNDLE_PATH" "https://dl.sandstorm.org/$OLD_BUNDLE_FILENAME"
fi

# Always check the checksum to guard against corrupted downloads.
verifySha256 "$OLD_BUNDLE_PATH" "$OLD_BUNDLE_SHA256" "Old bundle"

# Extract bin/mongo and bin/mongod from the old Sandstorm bundle.
OLD_BUNDLE_EXTRACT_DIR="$WORK_DIR/$OLD_BUNDLE_BASE"
rm -rf "$OLD_BUNDLE_EXTRACT_DIR"
mkdir -p "$OLD_BUNDLE_EXTRACT_DIR"
tar -C "$OLD_BUNDLE_EXTRACT_DIR" -xf "$OLD_BUNDLE_PATH" $OLD_MONGO_FILES
cp "$OLD_BUNDLE_EXTRACT_DIR/$OLD_BUNDLE_BASE/bin/mongo" \
  "$OLD_BUNDLE_EXTRACT_DIR/$OLD_BUNDLE_BASE/bin/mongod" "$BUNDLE_DIR/bin"
rm -rf "$OLD_BUNDLE_EXTRACT_DIR"

# Download MongoDB 2.6.12 to get mongodump (not included in the old Sandstorm bundle).
MONGO26_VERSION=2.6.12
MONGO26_FILENAME=mongodb-linux-x86_64-${MONGO26_VERSION}.tgz
MONGO26_PATH="$CACHE_DIR/$MONGO26_FILENAME"
MONGO26_SHA256=6d6415ac068825d1aed23f9482080ce3551bfac828d9570be1d72990d5f441b0
if [ ! -e "$MONGO26_PATH" ] ; then
  echo "Fetching MongoDB 2.6.12 for mongodump..."
  secureCurlDownload "$MONGO26_PATH" "https://fastdl.mongodb.org/linux/$MONGO26_FILENAME"
fi

verifySha256 "$MONGO26_PATH" "$MONGO26_SHA256" "MongoDB 2.6.12 package"

# Extract mongodump from MongoDB 2.6.12.
MONGO26_BASE=mongodb-linux-x86_64-${MONGO26_VERSION}
MONGO26_EXTRACT_DIR="$WORK_DIR/$MONGO26_BASE"
rm -rf "$MONGO26_EXTRACT_DIR"
mkdir -p "$MONGO26_EXTRACT_DIR"
tar -C "$MONGO26_EXTRACT_DIR" -xf "$MONGO26_PATH" "${MONGO26_BASE}/bin/mongodump"
cp "$MONGO26_EXTRACT_DIR/${MONGO26_BASE}/bin/mongodump" "$BUNDLE_DIR/bin/mongodump"
rm -rf "$MONGO26_EXTRACT_DIR"

# Download MongoDB 7.0 for migration support.
# Both versions are bundled - users run 'sandstorm migrate-mongo'
# to upgrade their database from 2.6 to 7.0.
MONGO7_VERSION=7.0.16
MONGO7_FILENAME=mongodb-linux-x86_64-ubuntu2204-${MONGO7_VERSION}.tgz
MONGO7_PATH="$CACHE_DIR/$MONGO7_FILENAME"
MONGO7_SHA256=376c258ae9b104b88814214bc3214a2e0d1300d8192d24d8c46259f364866422
if [ ! -e "$MONGO7_PATH" ] ; then
  echo "Fetching MongoDB 7.0..."
  secureCurlDownload "$MONGO7_PATH" "https://fastdl.mongodb.org/linux/$MONGO7_FILENAME"
fi

verifySha256 "$MONGO7_PATH" "$MONGO7_SHA256" "MongoDB 7.0 package"

# Extract mongod from MongoDB 7.0 package.
# Note: MongoDB 7.0 doesn't include the legacy mongo shell, use mongosh instead.
MONGO7_BASE=mongodb-linux-x86_64-ubuntu2204-${MONGO7_VERSION}
MONGO7_EXTRACT_DIR="$WORK_DIR/$MONGO7_BASE"
rm -rf "$MONGO7_EXTRACT_DIR"
mkdir -p "$MONGO7_EXTRACT_DIR"
tar -C "$MONGO7_EXTRACT_DIR" -xf "$MONGO7_PATH" "${MONGO7_BASE}/bin/mongod"
cp "$MONGO7_EXTRACT_DIR/${MONGO7_BASE}/bin/mongod" "$BUNDLE_DIR/bin/mongod7"
rm -rf "$MONGO7_EXTRACT_DIR"

# Download MongoDB Database Tools (mongodump, mongorestore) for MongoDB 7.0.
# These are distributed separately since MongoDB 4.4+.
MONGO_TOOLS_VERSION=100.10.0
MONGO_TOOLS_FILENAME=mongodb-database-tools-ubuntu2004-x86_64-${MONGO_TOOLS_VERSION}.tgz
MONGO_TOOLS_PATH="$CACHE_DIR/$MONGO_TOOLS_FILENAME"
MONGO_TOOLS_SHA256=74583f31eb2fefa4b7016b525b0f50209a4e20364f41719cc8c93b7156e49937
if [ ! -e "$MONGO_TOOLS_PATH" ] ; then
  echo "Fetching MongoDB Database Tools..."
  secureCurlDownload "$MONGO_TOOLS_PATH" "https://fastdl.mongodb.org/tools/db/$MONGO_TOOLS_FILENAME"
fi

verifySha256 "$MONGO_TOOLS_PATH" "$MONGO_TOOLS_SHA256" "MongoDB Database Tools package"

# Extract mongorestore from database tools package.
MONGO_TOOLS_BASE=mongodb-database-tools-ubuntu2004-x86_64-${MONGO_TOOLS_VERSION}
MONGO_TOOLS_EXTRACT_DIR="$WORK_DIR/$MONGO_TOOLS_BASE"
rm -rf "$MONGO_TOOLS_EXTRACT_DIR"
mkdir -p "$MONGO_TOOLS_EXTRACT_DIR"
tar -C "$MONGO_TOOLS_EXTRACT_DIR" -xf "$MONGO_TOOLS_PATH" \
  "${MONGO_TOOLS_BASE}/bin/mongorestore"
cp "$MONGO_TOOLS_EXTRACT_DIR/${MONGO_TOOLS_BASE}/bin/mongorestore" \
  "$BUNDLE_DIR/bin/mongorestore7"
rm -rf "$MONGO_TOOLS_EXTRACT_DIR"

# Download mongosh (MongoDB Shell) for MongoDB 7.0.
# MongoDB 7.0+ uses mongosh instead of the legacy mongo shell.
MONGOSH_VERSION=2.3.8
MONGOSH_FILENAME=mongosh-${MONGOSH_VERSION}-linux-x64.tgz
MONGOSH_PATH="$CACHE_DIR/$MONGOSH_FILENAME"
MONGOSH_SHA256=23edb768189663aaa9732a2340a25b5fc05a314940538809a7840be7f2ce221f
if [ ! -e "$MONGOSH_PATH" ] ; then
  echo "Fetching mongosh..."
  secureCurlDownload "$MONGOSH_PATH" "https://downloads.mongodb.com/compass/$MONGOSH_FILENAME"
fi

verifySha256 "$MONGOSH_PATH" "$MONGOSH_SHA256" "mongosh package"

# Extract mongosh binary.
MONGOSH_BASE=mongosh-${MONGOSH_VERSION}-linux-x64
MONGOSH_EXTRACT_DIR="$WORK_DIR/$MONGOSH_BASE"
rm -rf "$MONGOSH_EXTRACT_DIR"
mkdir -p "$MONGOSH_EXTRACT_DIR"
tar -C "$MONGOSH_EXTRACT_DIR" -xf "$MONGOSH_PATH" "${MONGOSH_BASE}/bin/mongosh"
cp "$MONGOSH_EXTRACT_DIR/${MONGOSH_BASE}/bin/mongosh" "$BUNDLE_DIR/bin/mongosh"
rm -rf "$MONGOSH_EXTRACT_DIR"

cp $(which zip unzip xz gpg) "$BUNDLE_DIR/bin"

# 'node-fibers' depends on a package (detect-libc) that uses various heuristics
# to work out what libc implementation & version it was linked against. The more
# reliable ones use these commands, so we include them to increase the chances
# of success. Notably, without these detecting the correct libc fails if the
# bundle was built on current Archlinux (as of Jan. 2020).
cp $(which ldd getconf) "$BUNDLE_DIR/bin"

# Older installs might be symlinking /usr/local/bin/spk to
# /opt/sandstorm/latest/bin/spk, while newer installs link it to
# /opt/sandstorm/sandstorm. We should keep creating the old symlink to avoid
# breakages.
ln -s ../sandstorm "$BUNDLE_DIR/bin/spk"

# Binaries copied from Meteor aren't writable by default.
chmod u+w "$BUNDLE_DIR"/bin/*

# Copy over capnp schemas.
mkdir -p "$BUNDLE_DIR/usr/include"/{capnp,sandstorm}
cp "$SOURCE_ROOT"/src/capnp/!(*test*).capnp "$BUNDLE_DIR/usr/include/capnp"
cp "$SOURCE_ROOT"/src/sandstorm/!(*-internal).capnp "$BUNDLE_DIR/usr/include/sandstorm"

# Copy over the pinned capnp-es compiler used by `spk dev-isolate` for capnp:
# schema imports. Runtime modules are embedded into the C++ binaries, but dev
# mode still needs the compiler to generate app-local schema modules.
mkdir -p "$BUNDLE_DIR/usr/lib/capnp-es"
cp -R "$CAPNP_ES_NPM_DIR/node_modules/@mnutt/capnp-es/dist" \
  "$BUNDLE_DIR/usr/lib/capnp-es/dist"
mkdir -p "$BUNDLE_DIR/usr/lib/capnp-es/node_modules"
cp -R "$CAPNP_ES_NPM_DIR/node_modules/typescript" \
  "$BUNDLE_DIR/usr/lib/capnp-es/node_modules/typescript"

# Copy over node_modules staged by the native CMake install.
cp -r "$NODE_MODULES_DIR" "$BUNDLE_DIR/node_modules"

# Copy over all necessary shared libraries.
(ldd "$BUNDLE_DIR"/bin/* $(find "$BUNDLE_DIR" -name '*.node') || true) | \
  grep -o '[[:space:]]/[^ ]*' | copyDeps

# Determine dependencies needed to run getaddrinfo() and copy them over.  glibc loads the
# DNS library dynamically, so `ldd` alone won't tell us this.  Also we want to find out
# what config files are needed from /etc, though we don't copy them over until runtime.
cat > "$WORK_DIR/dnstest.c" << '__EOF__'
#include <sys/types.h>
#include <sys/socket.h>
#include <netdb.h>
#include <stdlib.h>

int main() {
  struct addrinfo* result;
  getaddrinfo("example.com", "http", NULL, &result);
  return 0;
}
__EOF__

$CC "$WORK_DIR/dnstest.c" -o "$WORK_DIR/dnstest"
strace "$WORK_DIR/dnstest" 2>&1 | grep -o '"/[^"]*"' | tr -d '"' | copyDeps

# Add some whitelisted entries to host.list that we always want to include,
# even if the build machine doesn't necessarily use them.  This helps handle
# systems that use resolvconf to manage /etc/resolv.conf.
# We skip copyDeps because it only adds files that exist on this system; we
# wish to make things work for systems configured differently from the build host.
cat >> "$WORK_DIR/host.list" << '__EOF__'
/etc/gai.conf
/etc/host.conf
/etc/hosts
/etc/nsswitch.conf
/etc/resolvconf
/etc/resolv.conf
/etc/services
/run/resolvconf
/run/systemd/resolve/resolv.conf
__EOF__

# Dedup the host.list and copy over.  Don't copy the ld.so.x files, though.
grep -v '/ld[.]so[.]' "$WORK_DIR/host.list" | sort | uniq > "$BUNDLE_DIR/host.list"

# Make mount points.
mkdir -p "$BUNDLE_DIR"/{dev,proc,tmp,etc,etc.host,run,run.host,var}
touch "$BUNDLE_DIR/dev"/{null,zero,random,urandom,fuse}

# Generate a suitable C.UTF-8 locale that we and Mongo can rely on
mkdir -p "$BUNDLE_DIR/usr/lib/locale"
localedef --no-archive --inputfile="$SOURCE_ROOT/localedata-C" --charmap=UTF-8 \
  "$BUNDLE_DIR/usr/lib/locale/C.UTF-8"

# Don't strip binaries.  Having symbols is very useful for debugging and profiling.  Debug symbols
# usually compress well, add basically no runtime perf impact when not being used by other tools,
# and the debug sections probably won't even get mapped until used let alone faulted in.

if [ -e "$SOURCE_ROOT/.git" ]; then
  git -C "$SOURCE_ROOT" rev-parse HEAD > "$BUNDLE_DIR/git-revision"
else
  echo "unknown" > "$BUNDLE_DIR/git-revision"
fi
echo "$USER@$HOSTNAME $(date)" > "$BUNDLE_DIR/buildstamp"

cat > "$BUNDLE_DIR/README.md" << '__EOF__'
# Sandstorm Bundle

See: http://sandstorm.io

This is a self-contained, batteries-included Sandstorm server. It should
work on any Linux kernel whose version is 3.13 or newer. The rest of your
filesystem is not touched and may as well be empty; everything will run in
a chroot.

This bundle is intended to be installed using the Sandstorm installer or
updater. To install Sandstorm, please run:

    curl https://install.sandstorm.org | bash

If you have already installed Sandstorm, you can update your installation to
this version by running:

    service sandstorm update <filename>.tar.xz
__EOF__

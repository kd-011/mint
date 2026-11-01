#!/usr/bin/env bash
# Copy dist/mint.apk (run build.sh first) to a host over scp/ssh as
# <PUBLISH_DIR>/mint-<version>.apk, then check the sha256 there against the
# local file. PUBLISH_HOST (an ssh host) and PUBLISH_DIR come from the env file,
# see shell.env.example.
set -euo pipefail
cd "$(dirname "$0")"
. ./load-env.sh
: "${PUBLISH_HOST:?PUBLISH_HOST is not set (ssh host to copy the APK to), set it in the env file}"
: "${PUBLISH_DIR:?PUBLISH_DIR is not set (directory on that host), set it in the env file}"
HOST=$PUBLISH_HOST
DIR=${PUBLISH_DIR%/}
test -f dist/mint.apk -a -f dist/mint-latest.json || { echo 'run ./build.sh first'; exit 1; }
name=$(grep -oP '"file":\s*"\K[^"]+' dist/mint-latest.json)
sha=$(sha256sum dist/mint.apk | cut -d' ' -f1)
grep -q "$sha" dist/mint-latest.json || { echo 'dist/mint-latest.json does not match dist/mint.apk'; exit 1; }

scp -q dist/mint.apk "$HOST:/tmp/$name"
remote=$(ssh "$HOST" "set -e
  install -D -m 644 '/tmp/$name' '$DIR/$name'
  rm -f '/tmp/$name'
  sha256sum '$DIR/$name' | cut -d' ' -f1")
[ "$remote" = "$sha" ] || { echo "sha256 mismatch on $HOST: $remote vs $sha" >&2; exit 1; }
echo "published $name to $HOST ($sha)"

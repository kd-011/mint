#!/usr/bin/env bash
# Build the Mint Android release APK for sideloading. Outputs in dist/.
# Needs: JDK 21, the Android SDK, Node, and (for a signed APK) a keystore.
# Settings come from an env file, see shell.env.example and README.md.
#
#   ./build.sh              unit tests, then the release APK, aapt checks, dist/
#   ./build.sh --test-only  cap sync and the JVM unit tests only
#
# A full Gradle build takes minutes: run it detached so it survives a
# dropped shell, and poll the log:
#   mkdir -p ~/.cache/mint-apk
#   systemd-run --user --collect --unit=mint-apk-$(date +%s) \
#     bash -c './build.sh > ~/.cache/mint-apk/build.log 2>&1; echo APK_BUILD_EXIT_CODE=$? >> ~/.cache/mint-apk/build.log'
set -euo pipefail
cd "$(dirname "$0")"

# The application id. To rename the app, change it here too (README.md, "Renaming the package").
PKG=io.github.kd011.mint

. ./load-env.sh

case "${MINT_APP_ORIGIN:-}" in
  '') echo 'MINT_APP_ORIGIN is not set. Put it in the env file, e.g. MINT_APP_ORIGIN=https://mint.example.com/' >&2; exit 1 ;;
esac
[[ "$MINT_APP_ORIGIN" =~ ^https://[A-Za-z0-9.-]+/?$ ]] \
  || { echo "MINT_APP_ORIGIN must be an https origin with no path, like https://mint.example.com/ (got: $MINT_APP_ORIGIN)" >&2; exit 1; }
APP_HOST=${MINT_APP_ORIGIN#https://}
APP_HOST=${APP_HOST%/}
MINT_APP_ORIGIN=https://$APP_HOST/
MINT_AUTH_HOST=${MINT_AUTH_HOST:-}
[[ -z "$MINT_AUTH_HOST" || "$MINT_AUTH_HOST" =~ ^[A-Za-z0-9.-]+$ ]] \
  || { echo "MINT_AUTH_HOST must be a bare host name like auth.example.com, or empty (got: $MINT_AUTH_HOST)" >&2; exit 1; }
export MINT_APP_ORIGIN MINT_AUTH_HOST   # read by capacitor.config.js

[ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME" ] || { echo 'ANDROID_HOME must point at the Android SDK (set it in the env file)' >&2; exit 1; }
if [ -n "${JAVA_HOME:-}" ]; then export JAVA_HOME PATH="$JAVA_HOME/bin:$PATH"; fi
command -v java >/dev/null || { echo 'No java found: set JAVA_HOME (JDK 21) in the env file' >&2; exit 1; }
if [ -n "${NODE_BIN_DIR:-}" ]; then PATH="$NODE_BIN_DIR:$PATH"; fi
command -v node >/dev/null || PATH="$HOME/.local/opt/node/bin:$PATH"   # common per-user install dir, last resort
command -v npm >/dev/null || { echo 'No node/npm found: put them on PATH or set NODE_BIN_DIR in the env file' >&2; exit 1; }
BT="$ANDROID_HOME/build-tools/35.0.0"

[ -d node_modules ] || npm ci --no-audit --no-fund
npx cap sync android
# The offline page cannot know the server, so the synced copy gets the origin now.
offline=android/app/src/main/assets/public/offline.html
sed -i "s|__MINT_APP_ORIGIN__|$MINT_APP_ORIGIN|g" "$offline"
! grep -q '__MINT_APP_ORIGIN__' "$offline" || { echo 'offline page placeholder was not replaced' >&2; exit 1; }
GRADLE_ARGS=(-PmintAppHost="$APP_HOST" -PmintAuthHost="$MINT_AUTH_HOST")
if [ "${1:-}" = '--test-only' ]; then
  ( cd android && ./gradlew --no-daemon -q "${GRADLE_ARGS[@]}" testReleaseUnitTest )
  exit 0
fi
( cd android && ./gradlew --no-daemon -q "${GRADLE_ARGS[@]}" testReleaseUnitTest assembleRelease )
out=android/app/build/outputs/apk/release
if [ ! -f "$out/app-release.apk" ]; then
  echo "No signed APK: no keystore was found, so Gradle only produced an unsigned one ($out/app-release-unsigned.apk), which Android will not install. See README.md, 'Signing'." >&2
  exit 1
fi
mkdir -p dist
cp "$out/app-release.apk" dist/mint.apk
"$BT/apksigner" verify --print-certs dist/mint.apk | grep -E 'Signer #1 certificate SHA-256'

# What the bank app must and must not be, checked on the built APK itself.
badging=$("$BT/aapt" dump badging dist/mint.apk)
manifest=$("$BT/aapt" dump xmltree dist/mint.apk AndroidManifest.xml)
grep -q "package: name='$PKG'" <<<"$badging" || { echo 'wrong package' >&2; exit 1; }
grep -q 'usesCleartextTraffic.*=(type 0x12)0x0' <<<"$manifest" || { echo 'cleartext traffic is not off' >&2; exit 1; }
grep -q 'allowBackup.*=(type 0x12)0x0' <<<"$manifest" || { echo 'allowBackup is not off' >&2; exit 1; }
# AndroidX adds one signature permission in our own namespace for unexported receivers; it is not a grant.
perms=$(grep -o "uses-permission: name='[^']*'" <<<"$badging" | grep -v "name='$PKG.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'" | sort | tr '\n' ' ')
echo "permissions: $perms"
[ "$perms" = "uses-permission: name='android.permission.ACCESS_NETWORK_STATE' uses-permission: name='android.permission.INTERNET' " ] || { echo 'unexpected permissions' >&2; exit 1; }
# FLAG_SECURE (0x2000 = 8192): inside MainActivity.onCreate the bytecode must load
# 8192, call Window.setFlags, and only then call super.onCreate (which builds the WebView).
oncreate=$("$BT/dexdump" -d dist/mint.apk | grep -A12 "\] $PKG.MainActivity.onCreate:")
flag_line=$(grep -n '#int 8192' <<<"$oncreate" | head -1 | cut -d: -f1)
set_line=$(grep -n 'Landroid/view/Window;.setFlags' <<<"$oncreate" | head -1 | cut -d: -f1)
super_line=$(grep -n 'BridgeActivity;.onCreate' <<<"$oncreate" | head -1 | cut -d: -f1)
[ -n "$flag_line" ] && [ -n "$set_line" ] && [ -n "$super_line" ] && [ "$flag_line" -lt "$set_line" ] && [ "$set_line" -lt "$super_line" ] \
  || { echo 'MainActivity.onCreate does not set FLAG_SECURE before super.onCreate' >&2; exit 1; }
echo 'FLAG_SECURE: set before super.onCreate'

version_code=$(grep -oP 'versionCode\s+\K[0-9]+' android/app/build.gradle)
version_name=$(grep -oP 'versionName\s+"\K[^"]+' android/app/build.gradle)
sha256=$(sha256sum dist/mint.apk | cut -d' ' -f1)
size=$(stat -c%s dist/mint.apk)
cat > dist/mint-latest.json <<JSON
{
  "versionCode": $version_code,
  "versionName": "$version_name",
  "sha256": "$sha256",
  "size": $size,
  "file": "mint-$version_name.apk"
}
JSON
ls -la dist

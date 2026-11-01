# Mint for Android

A thin Capacitor 8 shell (WebView) over your own self-hosted Mint server. It is not a store app: you build it yourself, sign it with your own key and sideload it. Every screen, rule and number comes from the server, so web changes never need a new APK. No iOS, no push, no widget.

What the shell adds: `FLAG_SECURE` (no screenshots, screen recording or recents thumbnail), no backup, TLS only, no permissions beyond INTERNET and ACCESS_NETWORK_STATE, hardware back walks the WebView history, an offline page with a retry countdown (`www/offline.html`, no data shown), and WebAuthn support so Mint's passkey lock works.

## Requirements

- JDK 21
- Android SDK with platform 36 and build-tools 35.0.0
- Node and npm
- A Mint server reachable over https

## Configure

Copy `shell.env.example` to `shell.env` (gitignored) and fill it in. `build.sh` and `publish.sh` read the first file found of: `$MINT_ANDROID_ENV`, `android-shell/shell.env`, `~/.config/mint/android.env`.

| Key | Meaning |
|---|---|
| `MINT_APP_ORIGIN` | Required. Your Mint origin, for example `https://mint.example.com/` |
| `MINT_AUTH_HOST` | Optional. Host of the login gateway your proxy redirects to, for example `auth.example.com`. Empty means none |
| `JAVA_HOME` | JDK 21 home. Optional if `java` on PATH is JDK 21 |
| `ANDROID_HOME` | Required. Android SDK root |
| `NODE_BIN_DIR` | Optional. Directory with `node` and `npm` if not on PATH |
| `PUBLISH_HOST`, `PUBLISH_DIR` | Only for `publish.sh`: ssh host and target directory |

`MINT_APP_ORIGIN` and `MINT_AUTH_HOST` become the WebView's start URL and navigation allow list (`capacitor.config.js`), the trusted hosts in `ShellPolicy` (via `BuildConfig`), and the address on the offline page. Nothing deployment-specific is committed.

## Build

```sh
./build.sh              # cap sync, JVM unit tests, release APK, aapt checks -> dist/mint.apk + dist/mint-latest.json
./build.sh --test-only  # cap sync and the unit tests only
./publish.sh            # scp dist/mint.apk to PUBLISH_HOST:PUBLISH_DIR/mint-<version>.apk, sha256 checked there
```

Bump `versionCode` and `versionName` in `android/app/build.gradle` for every release. A full build takes a few minutes. `build.sh` fails unless the built APK has the expected package, cleartext traffic off, backup off, exactly the two permissions above, and `FLAG_SECURE` set before `super.onCreate`. The unit tests cover the trusted-host policy (`ShellPolicyTest`) and source guards for the secure window, TLS-only manifest and WebAuthn (`HardeningTest`).

`node icons.mjs` regenerates the launcher icons and splash from Mint's leaf mark (needs Playwright, set `PLAYWRIGHT_DIR` if it is not resolvable).

## Signing

Bring your own keystore. Never commit it: `keystore.properties`, `*.keystore` and `*.password` are gitignored here.

```sh
cd android-shell
keytool -genkeypair -v -storetype PKCS12 -keystore mint-upload.keystore \
  -alias mint -keyalg RSA -keysize 4096 -validity 10000
```

Then create `android-shell/keystore.properties` (paths in `storeFile` are relative to that file):

```properties
storeFile=mint-upload.keystore
storePassword=...
keyAlias=mint
keyPassword=...
```

To keep it elsewhere, set `MINT_KEYSTORE_PROPERTIES` to its full path (environment variable or Gradle property). Without a keystore Gradle still builds an unsigned release APK, which Android will not install, and `build.sh` stops with a message saying so.

Print the certificate fingerprint the server needs:

```sh
keytool -list -v -keystore mint-upload.keystore -alias mint | grep 'SHA256:'
# SHA256: AA:BB:CC:...   <- this is MINT_ANDROID_CERT_SHA256
```

Back the keystore up somewhere safe. Lose it and every install has to be uninstalled before it can update.

## Server settings

The passkey lock needs the server to know the app. Set these on the Mint server (see `lib/androidapp.mjs`):

- `MINT_ANDROID_PACKAGE`: the application id, default `io.github.kd011.mint`
- `MINT_ANDROID_CERT_SHA256`: your signing certificate fingerprint from above

Both must match the APK you built, or the lock refuses the app.

## Renaming the package

The default id is `io.github.kd011.mint`. If you want your own, change all of these together, then set `MINT_ANDROID_PACKAGE` on the server to match:

1. `applicationId` and `namespace` in `android/app/build.gradle`
2. The java package: move `android/app/src/main/java/io/github/kd011/mint/` (and the matching `src/test` directory) to your path and update the `package` line in every `.java` file. `HardeningTest` and the `ACTIVITY` path in it also name the old directory
3. `appId` in `capacitor.config.js`
4. `package_name` and `custom_url_scheme` in `android/app/src/main/res/values/strings.xml`
5. `PKG` at the top of `build.sh` (the aapt and dexdump checks use it)

An app that changes its id is a different app to Android: existing installs will not update to it.

## Signing in behind a login gateway

If your proxy puts a gateway in front of Mint, set `MINT_AUTH_HOST` so the sign-in page opens inside the app. Otherwise Capacitor hands it to the system browser and the session lands in the wrong place. The cookie is flushed to disk whenever the app leaves the screen, so a sign-in made just before a swipe-away survives.

`ShellPolicy.REMEMBER_ME_JS` targets Authelia's sign-in page: it ticks `#remember-checkbox` once, for at most 15 seconds, and touches nothing else. It does nothing on other gateways. Without it an Authelia session cookie does not survive the app being killed.

## The fingerprint lock and assetlinks

Mint locks itself with a WebAuthn passkey (`navigator.credentials`, platform authenticator, user verification required). Plain Android System WebView does not do WebAuthn, so the app enables it with `WebSettingsCompat.setWebAuthenticationSupport(..., FOR_APP)` (androidx.webkit 1.14, WebView 128 or newer), which routes to Android's Credential Manager with the app as caller. The assertion's origin then becomes `android:apk-key-hash:<cert hash>`, which the server accepts only for the certificate in `MINT_ANDROID_CERT_SHA256`.

Android only lets an app use a site's passkeys when `https://mint.example.com/.well-known/assetlinks.json` names the app's package and certificate. Mint serves that file, but it must be reachable without a session. If a login gateway sits in front, add a bypass rule for that one path. Authelia example:

```yaml
- domain: mint.example.com
  resources:
    - '^/\.well-known/assetlinks\.json$'
  policy: bypass
```

Put it before any broader rule for the domain and reload the gateway. Other gateways have their own equivalent: allow that path unauthenticated.

A passkey created in a desktop browser only works in the app if the browser saved it to a synced password manager. If nothing is enrolled the lock screen offers "Set up fingerprint"; enrolling from the app is the simplest route.

## Not verified

No device or emulator was used for: the Credential Manager prompt, Google's assetlinks check, the Authelia "Remember me" injection against a live page, or `FLAG_SECURE` on a real recents screen. The JVM unit tests and the aapt/dexdump checks in `build.sh` are what is automated.

## Layout

- `capacitor.config.js`: start URL, navigation allow list, offline page, colours, user agent suffix (reads the env file values)
- `android/app/src/main/java/io/github/kd011/mint/MainActivity.java`: secure window, insets, back, cookie flush, WebAuthn mode, sign-in nudge
- `.../ShellPolicy.java`: trusted hosts and the sign-in nudge script (unit tested)
- `www/offline.html`, `icons.mjs`, `build.sh`, `publish.sh`, `load-env.sh`, `shell.env.example`

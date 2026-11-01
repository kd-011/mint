// The Android app (android-shell/): who it is, as far as the server needs to know.
//
// Passkeys in the app go through Android's Credential Manager as the app itself
// (WebView "app mode" WebAuthn), so an assertion's clientDataJSON origin is
// android:apk-key-hash:<SHA-256 of the signing certificate, base64url>, not
// your site's https origin. The lock accepts that one extra origin under the
// same rp id, and /.well-known/assetlinks.json names the same package and
// certificate so Android lets the app use your site's passkeys at all.
// Neither is a secret: the certificate fingerprint is public by design.
//
// The certificate is the upload key you generate for android-shell/ (bring your
// own keystore, see android-shell/README.md). A new key means a new fingerprint.
// Set it with MINT_ANDROID_CERT_SHA256 (as keytool prints it, colon separated).
// Unset, or set to off, the Android app is simply not recognised: the web app
// and its passkey lock are unaffected.

// Read when called, not when this file loads: server.mjs imports it before it reads .env.

/** The app's package id. Change it only if you renamed the app in android-shell/. */
export const androidPackage = () => (process.env.MINT_ANDROID_PACKAGE ?? '').trim() || 'io.github.kd011.mint';

/** SHA-256 of the release signing certificate, as keytool prints it, or '' when no app is configured. */
export function androidCert() {
  const v = (process.env.MINT_ANDROID_CERT_SHA256 ?? '').trim();
  return /^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/.test(v) ? v.toUpperCase() : '';
}

/** The WebAuthn origin an assertion made inside the app carries. */
export function androidAppOrigin(fingerprint = androidCert()) {
  if (!fingerprint) return null;
  return `android:apk-key-hash:${Buffer.from(fingerprint.replaceAll(':', ''), 'hex').toString('base64url')}`;
}

/** Served at /.well-known/assetlinks.json: passkey sharing for the app (the app is not an app-link handler: no autoVerify filters). */
export function assetLinks(fingerprint = androidCert()) {
  if (!fingerprint) return [];
  return [{
    // Google's provider reads get_login_creds; Bitwarden's checks handle_all_urls and
    // otherwise answers "passkey not supported for this app".
    relation: ['delegate_permission/common.get_login_creds', 'delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: androidPackage(), sha256_cert_fingerprints: [fingerprint] },
  }];
}

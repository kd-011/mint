// The Android app (android-shell/): its identity as the server needs it. A
// passkey assertion made inside the app's WebView goes through Android's
// Credential Manager as the app, so its origin is android:apk-key-hash:<cert
// SHA-256, base64url>, and Android only lets the app use the site's
// passkeys when /.well-known/assetlinks.json names the same package and cert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openDb } from '../lib/db.mjs';
import { createLock } from '../lib/lock.mjs';
import { androidAppOrigin, assetLinks } from '../lib/androidapp.mjs';
import { authenticator } from './fixtures/webauthn.mjs';

const ORIGIN = 'https://mint.example.com';
const RP = 'mint.example.com';
// A made-up certificate fingerprint, 32 bytes as keytool prints it.
const CERT = Array.from({ length: 32 }, (_, i) => ((i * 7 + 3) % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');

test('the app origin is the base64url of the certificate hash', () => {
  const o = androidAppOrigin(CERT);
  assert.match(o, /^android:apk-key-hash:[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(o.split(':')[2], 'base64url').toString('hex').toUpperCase(), CERT.replaceAll(':', ''));
});

test('assetlinks.json names the package and certificate for passkeys, and nothing more', () => {
  const doc = assetLinks(CERT);
  assert.equal(doc.length, 1);
  assert.deepEqual(doc[0].relation, ['delegate_permission/common.get_login_creds', 'delegate_permission/common.handle_all_urls']);
  assert.deepEqual(doc[0].target, { namespace: 'android_app', package_name: 'io.github.kd011.mint', sha256_cert_fingerprints: [CERT] });
});

function lockWith(appOrigins) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'mint-android-')), 'mint.db'));
  return createLock({ db, origin: ORIGIN, appOrigins, log: () => {} });
}

test('an assertion made in the app unlocks, under the real rp id, only for the listed app key', () => {
  const lock = lockWith([androidAppOrigin(CERT)]);
  const a = authenticator();
  const o = lock.registerOptions({ origin: ORIGIN });
  lock.register({ ...a.create({ challenge: o.challenge, origin: ORIGIN, rpId: RP }), label: 'Phone' });

  const g = lock.assertOptions({ origin: ORIGIN });
  assert.equal(g.rpId, RP);
  assert.equal(lock.assert(a.get({ challenge: g.challenge, origin: androidAppOrigin(CERT), rpId: RP })).credentialId, a.id);

  // Another app key, or the right key with the wrong rp id, is refused; so is UV missing (covered in lock.test.mjs).
  const other = 'android:apk-key-hash:' + Buffer.alloc(32, 7).toString('base64url');
  const g2 = lock.assertOptions({ origin: ORIGIN });
  assert.throws(() => lock.assert(a.get({ challenge: g2.challenge, origin: other, rpId: RP })), { reason: 'origin' });
  const g3 = lock.assertOptions({ origin: ORIGIN });
  assert.throws(() => lock.assert(a.get({ challenge: g3.challenge, origin: androidAppOrigin(CERT), rpId: 'evil.example' })), { reason: 'rp' });
});

test('with no app origin configured the app origin is refused like any other', () => {
  const lock = lockWith([]);
  const a = authenticator();
  const o = lock.registerOptions({ origin: ORIGIN });
  lock.register({ ...a.create({ challenge: o.challenge, origin: ORIGIN, rpId: RP }), label: 'Phone' });
  const g = lock.assertOptions({ origin: ORIGIN });
  assert.throws(() => lock.assert(a.get({ challenge: g.challenge, origin: androidAppOrigin(CERT), rpId: RP })), { reason: 'origin' });
});

test('no certificate configured means no app origin and an empty assetlinks document', () => {
  assert.equal(androidAppOrigin(''), null);
  assert.deepEqual(assetLinks(''), []);
});

test('MINT_ANDROID_CERT_SHA256 and MINT_ANDROID_PACKAGE are read from the environment, and a malformed value counts as unset', async () => {
  const save = { c: process.env.MINT_ANDROID_CERT_SHA256, p: process.env.MINT_ANDROID_PACKAGE };
  try {
    process.env.MINT_ANDROID_CERT_SHA256 = CERT.toLowerCase();
    process.env.MINT_ANDROID_PACKAGE = 'com.example.mint';
    const m = await import('../lib/androidapp.mjs');
    assert.equal(m.androidCert(), CERT);
    assert.equal(m.androidPackage(), 'com.example.mint');
    assert.equal(m.assetLinks()[0].target.package_name, 'com.example.mint');
    process.env.MINT_ANDROID_CERT_SHA256 = 'not-a-fingerprint';
    delete process.env.MINT_ANDROID_PACKAGE;
    assert.equal(m.androidCert(), '');
    assert.equal(m.androidPackage(), 'io.github.kd011.mint');
  } finally {
    for (const [k, v] of [['MINT_ANDROID_CERT_SHA256', save.c], ['MINT_ANDROID_PACKAGE', save.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('a certificate set in .env (not in the process environment) reaches assetlinks.json', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mint-android-env-'));
  writeFileSync(join(home, '.env'), `MINT_ANDROID_CERT_SHA256=${CERT}\nREDBARK_API_KEY=rbk_live_xxx\nMINT_GATE_KEY=${'g'.repeat(8)}-test-gate-key-0123456789abcdef0123\n`);
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const p = spawn(process.execPath, [join(root, 'server.mjs')], { env: { PATH: process.env.PATH, MINT_HOME: home, MINT_PORT: '0', MINT_SCHEDULER: 'off', MINT_LOCK: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const url = await new Promise((resolve, reject) => {
      let out = '';
      const t = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000);
      p.stdout.on('data', (d) => { out += d; const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out); if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); } });
      p.stderr.on('data', (d) => { out += d; });
    });
    const doc = await (await fetch(`${url}/.well-known/assetlinks.json`)).json();
    assert.deepEqual(doc[0].target.sha256_cert_fingerprints, [CERT]);
  } finally {
    p.kill('SIGTERM');
  }
});

test('the server logs plainly when the Android certificate is unset', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mint-android-log-'));
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const p = spawn(process.execPath, [join(root, 'server.mjs')], { env: { PATH: process.env.PATH, MINT_HOME: home, MINT_PORT: '0', MINT_SCHEDULER: 'off', MINT_LOCK: 'off', REDBARK_API_KEY: 'rbk_live_xxx', MINT_GATE_KEY: 'test-gate-key-0123456789abcdef0123456789' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const out = await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error(`no start: ${buf}`)), 8000);
      p.stdout.on('data', (d) => { buf += d; if (/listening on/.test(buf)) { clearTimeout(t); resolve(buf); } });
    });
    assert.match(out, /android: MINT_ANDROID_CERT_SHA256 is not set/);
  } finally {
    p.kill('SIGTERM');
  }
});

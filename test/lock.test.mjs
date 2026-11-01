// The fingerprint lock's verifier (lib/lock.mjs): WebAuthn registration and
// assertion checked with node:crypto against a software authenticator, and the
// unlock sessions (signed cookie, 15 minute sliding idle, 8 hour cap, revoke).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, getSetting } from '../lib/db.mjs';
import { createLock, LOCK_COOKIE, readCookie, LockError } from '../lib/lock.mjs';
import { authenticator } from './fixtures/webauthn.mjs';

const ORIGIN = 'https://mint.example.com';
const RP = 'mint.example.com';
const MIN = 60 * 1000;

function setup({ devOrigin = '' } = {}) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'mint-lock-')), 'mint.db'));
  let t = Date.parse('2026-10-20T00:00:00Z');
  const clock = { now: () => t, add: (ms) => { t += ms; } };
  const lock = createLock({ db, origin: ORIGIN, devOrigin, now: clock.now, log: () => {} });
  return { db, lock, clock };
}

// Enrol one authenticator and return it.
function enrol(lock, { alg } = {}) {
  const a = authenticator({ alg });
  const o = lock.registerOptions({ origin: ORIGIN });
  lock.register({ ...a.create({ challenge: o.challenge, origin: ORIGIN, rpId: RP }), label: 'Test phone' });
  return a;
}
const assertWith = (lock, a, over = {}) => {
  const o = lock.assertOptions({ origin: ORIGIN });
  return lock.assert(a.get({ challenge: o.challenge, origin: ORIGIN, rpId: RP, ...over }));
};

test('registration options ask for a platform fingerprint with user verification required', () => {
  const { lock } = setup();
  const o = lock.registerOptions({ origin: ORIGIN });
  assert.equal(o.rp.id, RP);
  assert.equal(o.authenticatorSelection.userVerification, 'required');
  assert.equal(o.authenticatorSelection.authenticatorAttachment, 'platform');
  assert.equal(o.attestation, 'none');
  assert.deepEqual(o.pubKeyCredParams.map((p) => p.alg).sort(), [-257, -7]);
  assert.match(o.challenge, /^[A-Za-z0-9_-]{43}$/);
});

test('a good ES256 registration stores the credential and turns the lock on', () => {
  const { lock, db } = setup();
  assert.equal(lock.count(), 0);
  assert.equal(getSetting(db, 'lock_enabled_at'), null);
  const a = enrol(lock);
  assert.equal(lock.count(), 1);
  const [c] = lock.credentials();
  assert.equal(c.id, a.id);
  assert.equal(c.label, 'Test phone');
  assert.equal(c.alg, -7);
  assert.ok(getSetting(db, 'lock_enabled_at'));
});

test('an RS256 registration (some Android and Bitwarden authenticators) works end to end', () => {
  const { lock } = setup();
  const a = enrol(lock, { alg: -257 });
  assert.equal(lock.credentials()[0].alg, -257);
  assert.equal(assertWith(lock, a).credentialId, a.id);
});

test('registration is refused for a wrong challenge, a wrong origin, a wrong rp, no UV, or a get() response', () => {
  const { lock } = setup();
  const a = authenticator();
  const bad = [
    [{ challenge: 'A'.repeat(43) }, 'challenge'],
    [{ origin: 'https://evil.example' }, 'origin'],
    [{ rpId: 'evil.example' }, 'rp'],
    [{ uv: false }, 'uv'],
    [{ up: false }, 'up'],
    [{ type: 'webauthn.get' }, 'type'],
  ];
  for (const [over, reason] of bad) {
    const o = lock.registerOptions({ origin: ORIGIN });
    assert.throws(() => lock.register(a.create({ challenge: o.challenge, origin: ORIGIN, rpId: RP, ...over })), { reason }, reason);
  }
  assert.equal(lock.count(), 0);
});

test('a good assertion verifies and the counter is stored', () => {
  const { lock } = setup();
  const a = enrol(lock);
  assert.equal(assertWith(lock, a, { count: 5 }).credentialId, a.id);
  assert.equal(lock.credentials()[0].sign_count, 5);
  assert.ok(lock.credentials()[0].last_used_at);
});

test('assertion options carry the enrolled credential ids and require UV', () => {
  const { lock } = setup();
  const a = enrol(lock);
  const o = lock.assertOptions({ origin: ORIGIN });
  assert.equal(o.rpId, RP);
  assert.equal(o.userVerification, 'required');
  assert.deepEqual(o.allowCredentials.map((c) => c.id), [a.id]);
});

test('assertions are refused: wrong challenge, wrong origin, wrong rpIdHash, missing UV or UP, wrong type', () => {
  const { lock } = setup();
  const a = enrol(lock);
  const cases = [
    [{ challenge: 'B'.repeat(43) }, 'challenge'],
    [{ origin: 'https://mint.example.com.evil.example' }, 'origin'],
    [{ origin: 'http://localhost:8970' }, 'origin'],
    [{ rpId: 'example.com' }, 'rp'],
    [{ uv: false }, 'uv'],
    [{ up: false }, 'up'],
    [{ type: 'webauthn.create' }, 'type'],
  ];
  for (const [over, reason] of cases) {
    const o = lock.assertOptions({ origin: ORIGIN });
    assert.throws(() => lock.assert(a.get({ challenge: o.challenge, origin: ORIGIN, rpId: RP, ...over })), { reason }, reason);
  }
});

test('a tampered signature is refused', () => {
  const { lock } = setup();
  const a = enrol(lock);
  assert.throws(() => assertWith(lock, a, { tamper: true }), { reason: 'signature' });
});

test('an assertion signed by a different key under the same id is refused', () => {
  const { lock } = setup();
  const a = enrol(lock);
  const other = authenticator();
  const o = lock.assertOptions({ origin: ORIGIN });
  const r = other.get({ challenge: o.challenge, origin: ORIGIN, rpId: RP });
  assert.throws(() => lock.assert({ ...r, id: a.id }), { reason: 'signature' });
});

test('an unknown credential is refused', () => {
  const { lock } = setup();
  enrol(lock);
  assert.throws(() => assertWith(lock, authenticator()), { reason: 'credential' });
});

test('a replayed or lower counter is refused; a passkey that never counts (0) is fine', () => {
  const { lock } = setup();
  const a = enrol(lock);
  assertWith(lock, a, { count: 7 });
  assert.throws(() => assertWith(lock, a, { count: 7 }), { reason: 'counter' }, 'same counter');
  assert.throws(() => assertWith(lock, a, { count: 3 }), { reason: 'counter' }, 'lower counter');
  assert.throws(() => assertWith(lock, a, { count: 0 }), { reason: 'counter' }, 'dropped to zero after counting');
  assert.equal(assertWith(lock, a, { count: 8 }).credentialId, a.id);

  const { lock: l2 } = setup();
  const b = enrol(l2);
  assertWith(l2, b, { count: 0 });
  assertWith(l2, b, { count: 0 });
});

test('a challenge is single use: replaying a whole good assertion is refused', () => {
  const { lock } = setup();
  const a = enrol(lock);
  const o = lock.assertOptions({ origin: ORIGIN });
  const r = a.get({ challenge: o.challenge, origin: ORIGIN, rpId: RP, count: 0 });
  lock.assert(r);
  assert.throws(() => lock.assert(r), { reason: 'challenge' });
});

test('a challenge expires after two minutes', () => {
  const { lock, clock } = setup();
  const a = enrol(lock);
  const o = lock.assertOptions({ origin: ORIGIN });
  clock.add(2 * MIN + 1000);
  assert.throws(() => lock.assert(a.get({ challenge: o.challenge, origin: ORIGIN, rpId: RP })), { reason: 'expired' });
  const o2 = lock.assertOptions({ origin: ORIGIN });
  clock.add(MIN + 50_000);
  assert.equal(lock.assert(a.get({ challenge: o2.challenge, origin: ORIGIN, rpId: RP })).credentialId, a.id);
});

test('a registration challenge cannot be spent on an assertion, nor the other way round', () => {
  const { lock } = setup();
  const a = enrol(lock);
  const reg = lock.registerOptions({ origin: ORIGIN });
  assert.throws(() => lock.assert(a.get({ challenge: reg.challenge, origin: ORIGIN, rpId: RP })), { reason: 'challenge' });
  const b = authenticator();
  const get = lock.assertOptions({ origin: ORIGIN });
  assert.throws(() => lock.register(b.create({ challenge: get.challenge, origin: ORIGIN, rpId: RP })), { reason: 'challenge' });
});

test('the localhost origin only counts when the dev flag names it, with its own rp id', () => {
  const dev = 'http://localhost:18970';
  const { lock } = setup({ devOrigin: dev });
  const a = authenticator();
  const o = lock.registerOptions({ origin: dev });
  assert.equal(o.rp.id, 'localhost');
  lock.register(a.create({ challenge: o.challenge, origin: dev, rpId: 'localhost' }));
  const g = lock.assertOptions({ origin: dev });
  assert.equal(g.rpId, 'localhost');
  assert.equal(lock.assert(a.get({ challenge: g.challenge, origin: dev, rpId: 'localhost' })).credentialId, a.id);
  // The dev origin cannot borrow the real rp id, nor the real origin the dev one.
  const g2 = lock.assertOptions({ origin: dev });
  assert.throws(() => lock.assert(a.get({ challenge: g2.challenge, origin: dev, rpId: RP })), { reason: 'rp' });
});

test('removing a credential; the last one cannot be removed', () => {
  const { lock } = setup();
  const a = enrol(lock);
  const b = enrol(lock);
  assert.equal(lock.count(), 2);
  assert.throws(() => lock.removeCredential('nope'), { reason: 'credential' });
  lock.removeCredential(a.id);
  assert.equal(lock.count(), 1);
  assert.throws(() => lock.removeCredential(b.id), { reason: 'last' });
  assert.throws(() => assertWith(lock, a), { reason: 'credential' });
});

test('sessions: a signed cookie that slides on use for 15 minutes idle', () => {
  const { lock, clock } = setup();
  const a = enrol(lock);
  const cookie = lock.startSession(assertWith(lock, a).credentialId);
  assert.ok(lock.session(cookie));
  clock.add(14 * MIN);
  assert.ok(lock.session(cookie), 'still inside 15 minutes');
  clock.add(14 * MIN);
  assert.ok(lock.session(cookie), 'the last use slid the window');
  clock.add(15 * MIN + 1000);
  assert.equal(lock.session(cookie), null, 'idle for 15 minutes locks');
});

test('sessions: an absolute cap of 8 hours however busy', () => {
  const { lock, clock } = setup();
  const a = enrol(lock);
  const cookie = lock.startSession(assertWith(lock, a).credentialId);
  for (let i = 0; i < 47; i++) { clock.add(10 * MIN); assert.ok(lock.session(cookie), `at ${(i + 1) * 10} minutes`); }
  clock.add(11 * MIN);
  assert.equal(lock.session(cookie), null);
});

test('sessions: revoke, a tampered cookie, a forged id, and a reset all fail', () => {
  const { lock } = setup();
  const a = enrol(lock);
  const cookie = lock.startSession(assertWith(lock, a).credentialId);
  const [sid, mac] = cookie.split('.');
  assert.equal(lock.session(`${sid}.${mac.slice(0, -2)}AA`), null, 'bad mac');
  assert.equal(lock.session(`${sid.slice(0, -2)}AA.${mac}`), null, 'other id, old mac');
  assert.equal(lock.session(''), null);
  assert.equal(lock.session('garbage'), null);
  lock.revoke(cookie);
  assert.equal(lock.session(cookie), null);
  const c2 = lock.startSession(a.id);
  assert.ok(lock.session(c2));
  lock.reset();
  assert.equal(lock.session(c2), null);
  assert.equal(lock.count(), 0);
});

test('sessions: removing the credential a session was opened with ends that session', () => {
  const { lock } = setup();
  const a = enrol(lock);
  enrol(lock);
  const cookie = lock.startSession(assertWith(lock, a).credentialId);
  lock.removeCredential(a.id);
  assert.equal(lock.session(cookie), null);
});

test('the cookie is HttpOnly, Secure, SameSite=Strict and host-only', () => {
  const { lock } = setup();
  const set = lock.cookieHeader('abc.def');
  assert.match(set, new RegExp(`^${LOCK_COOKIE}=abc\\.def;`));
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(set.includes(part), part);
  assert.doesNotMatch(set, /Domain=/i);
  assert.match(lock.clearCookieHeader(), /Max-Age=0/);
  assert.equal(readCookie(`a=1; ${LOCK_COOKIE}=x.y; b=2`), 'x.y');
  assert.equal(readCookie('a=1'), null);
  assert.equal(readCookie(undefined), null);
});

test('the cookie secret is random, kept in the settings table, and survives a restart', () => {
  const { db, lock, clock } = setup();
  const a = enrol(lock);
  const cookie = lock.startSession(a.id);
  const secret = getSetting(db, 'lock_cookie_secret');
  assert.match(secret ?? '', /^[0-9a-f]{64}$/);
  const again = createLock({ db, origin: ORIGIN, now: clock.now, log: () => {} });
  assert.ok(again.session(cookie));
});

test('a caller that is not unlocked can only enrol the first fingerprint, checked inside the write', () => {
  const { lock } = setup();
  const a = authenticator();
  const b = authenticator();
  // Two first-run enrolments in flight at once: both got a challenge while nothing was enrolled.
  const oa = lock.registerOptions({ origin: ORIGIN });
  const ob = lock.registerOptions({ origin: ORIGIN });
  lock.register(a.create({ challenge: oa.challenge, origin: ORIGIN, rpId: RP }), { firstOnly: true });
  assert.throws(() => lock.register(b.create({ challenge: ob.challenge, origin: ORIGIN, rpId: RP }), { firstOnly: true }), { reason: 'locked' });
  assert.equal(lock.count(), 1);
});

test('a public key that does not parse is refused as a format error, not a crash', () => {
  const { lock } = setup();
  const o = lock.registerOptions({ origin: ORIGIN });
  const a = authenticator();
  const r = a.create({ challenge: o.challenge, origin: ORIGIN, rpId: RP });
  // Flip a byte inside the COSE x coordinate so the point is off the curve.
  const att = Buffer.from(r.attestationObject, 'base64url');
  att[att.length - 40] ^= 0xff;
  assert.throws(() => lock.register({ ...r, attestationObject: att.toString('base64url') }), (e) => e instanceof LockError);
});

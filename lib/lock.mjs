// The fingerprint lock: a WebAuthn passkey with user verification required,
// asked for every time Mint opens, on top of the login gateway. No libraries:
// the CBOR, the COSE keys and the signatures are checked here with node:crypto.
//
// Registration (attestation "none") stores the credential id, its public key as
// SPKI and the signature counter. An assertion must carry a live single-use
// challenge, the right origin and rp id hash, both the presence and the
// verification flags, a good signature over authData || sha256(clientDataJSON)
// and, once the authenticator counts, a counter that went up.
//
// A good assertion opens a session: a random id, HMAC signed with a secret kept
// in the settings table, held server side so Lock now and a reset end it.
// Sessions slide on use for 15 minutes idle and never outlive 8 hours.
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { getSetting, setSetting, tx } from './db.mjs';

export const LOCK_COOKIE = '__Host-mint-unlock';
export const IDLE_MS = 15 * 60 * 1000;
export const MAX_MS = 8 * 60 * 60 * 1000;
export const CHALLENGE_MS = 2 * 60 * 1000;
const ALGS = [-7, -257]; // ES256, RS256

export class LockError extends Error {
  constructor(reason, message) { super(message); this.reason = reason; }
}
const fail = (reason, message) => { throw new LockError(reason, message); };

const sha256 = (b) => createHash('sha256').update(b).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');
function unb64u(s, what) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length > 16384) fail('format', `${what} is not base64url`);
  return Buffer.from(s, 'base64url');
}

// ---------- CBOR (only what attestation objects and COSE keys use) ----------

function cborDecode(buf) {
  let i = 0;
  const need = (n) => { if (i + n > buf.length) fail('format', 'CBOR ran short'); };
  const len = (info) => {
    if (info < 24) return info;
    const n = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
    if (!n) fail('format', 'CBOR length not supported');
    need(n);
    let v = 0;
    for (let k = 0; k < n; k++) v = v * 256 + buf[i++];
    return v;
  };
  const item = (depth) => {
    if (depth > 8) fail('format', 'CBOR nested too deep');
    need(1);
    const b = buf[i++];
    const major = b >> 5;
    const info = b & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      fail('format', 'CBOR simple value not supported');
    }
    const n = len(info);
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2 || major === 3) {
      need(n);
      const s = buf.subarray(i, i + n);
      i += n;
      return major === 2 ? Buffer.from(s) : s.toString('utf8');
    }
    if (major === 4) { const a = []; for (let k = 0; k < n; k++) a.push(item(depth + 1)); return a; }
    if (major === 5) { const m = new Map(); for (let k = 0; k < n; k++) { const key = item(depth + 1); m.set(key, item(depth + 1)); } return m; }
    fail('format', 'CBOR tag not supported');
  };
  const v = item(0);
  return { value: v, end: i };
}

// COSE_Key to a node KeyObject: EC2 P-256 for ES256, RSA for RS256.
function coseToKey(cose) {
  if (!(cose instanceof Map)) fail('format', 'public key is not a COSE map');
  const alg = cose.get(3);
  if (!ALGS.includes(alg)) fail('alg', `algorithm ${alg} not allowed`);
  const bytes = (k) => { const v = cose.get(k); if (!Buffer.isBuffer(v)) fail('format', 'COSE key field missing'); return b64u(v); };
  if (alg === -7 && (cose.get(1) !== 2 || cose.get(-1) !== 1)) fail('alg', 'ES256 key is not EC2 P-256');
  if (alg === -257 && cose.get(1) !== 3) fail('alg', 'RS256 key is not RSA');
  const jwk = alg === -7 ? { kty: 'EC', crv: 'P-256', x: bytes(-2), y: bytes(-3) } : { kty: 'RSA', n: bytes(-1), e: bytes(-2) };
  try { return { alg, key: createPublicKey({ key: jwk, format: 'jwk' }) }; } catch { fail('format', 'public key does not parse'); }
}

// Authenticator data: rpIdHash(32) flags(1) counter(4) [aaguid(16) idLen(2) id coseKey].
function parseAuthData(ad) {
  if (ad.length < 37) fail('format', 'authenticator data too short');
  const out = { rpIdHash: ad.subarray(0, 32), flags: ad[32], counter: ad.readUInt32BE(33) };
  if (out.flags & 0x40) {
    if (ad.length < 55) fail('format', 'attested credential data too short');
    const idLen = ad.readUInt16BE(53);
    if (idLen < 16 || idLen > 1023 || ad.length < 55 + idLen + 1) fail('format', 'credential id length out of range');
    out.credentialId = ad.subarray(55, 55 + idLen);
    const cose = cborDecode(ad.subarray(55 + idLen));
    out.coseKey = cose.value;
  }
  return out;
}

// ---------- the lock ----------

export function readCookie(header) {
  for (const part of String(header ?? '').split(';')) {
    const k = part.indexOf('=');
    if (k > 0 && part.slice(0, k).trim() === LOCK_COOKIE) return part.slice(k + 1).trim();
  }
  return null;
}

export function createLock({ db, origin, devOrigin = '', appOrigins = [], log = () => {}, now = Date.now, idleMs = IDLE_MS, maxMs = MAX_MS }) {
  // Each allowed origin has its own rp id: the real host, and localhost only
  // when MINT_LOCK_DEV_ORIGIN names it (tests and the throwaway check).
  const rps = new Map([[origin, new URL(origin).hostname]]);
  if (devOrigin) rps.set(devOrigin, new URL(devOrigin).hostname);
  // The Android app's own origin (android:apk-key-hash:...), under the real rp id (lib/androidapp.mjs).
  for (const o of appOrigins) rps.set(o, new URL(origin).hostname);
  const rpFor = (o) => rps.get(o) ?? rps.get(origin);

  // Outstanding challenges, in memory: single use, two minutes.
  const challenges = new Map();
  function issue(kind, rpId) {
    const t = now();
    for (const [k, v] of challenges) if (v.exp < t) challenges.delete(k);
    if (challenges.size > 200) challenges.delete(challenges.keys().next().value);
    const c = b64u(randomBytes(32));
    challenges.set(c, { kind, rpId, exp: t + CHALLENGE_MS });
    return c;
  }
  function spend(clientDataJSON, type, kind) {
    const raw = unb64u(clientDataJSON, 'clientDataJSON');
    let cd;
    try { cd = JSON.parse(raw.toString('utf8')); } catch { fail('format', 'clientDataJSON is not JSON'); }
    if (!cd || typeof cd !== 'object') fail('format', 'clientDataJSON is not an object');
    const ch = typeof cd.challenge === 'string' ? challenges.get(cd.challenge) : undefined;
    if (ch) challenges.delete(cd.challenge);
    if (!ch || ch.kind !== kind) {
      if (cd.type !== type) fail('type', `clientData type is ${String(cd.type).slice(0, 40)}`);
      fail('challenge', 'challenge unknown or already used');
    }
    if (cd.type !== type) fail('type', `clientData type is ${String(cd.type).slice(0, 40)}`);
    if (ch.exp < now()) fail('expired', 'challenge expired, try again');
    if (!rps.has(cd.origin)) fail('origin', 'wrong origin');
    if (cd.crossOrigin === true) fail('origin', 'cross-origin ceremony');
    const rpId = rps.get(cd.origin);
    if (rpId !== ch.rpId) fail('origin', 'origin does not match the challenge');
    return { raw, rpId };
  }
  const checkAuthData = (a, rpId) => {
    if (!timingSafeEqual(a.rpIdHash, sha256(rpId))) fail('rp', 'rp id hash does not match');
    if (!(a.flags & 0x01)) fail('up', 'user presence flag not set');
    if (!(a.flags & 0x04)) fail('uv', 'fingerprint (user verification) not done');
  };

  const listStmt = db.prepare('SELECT id, alg, sign_count, label, created_at, last_used_at FROM lock_credentials ORDER BY created_at, id');
  const credentials = () => listStmt.all();
  const count = () => db.prepare('SELECT count(*) n FROM lock_credentials').get().n;

  function registerOptions({ origin: o }) {
    const rpId = rpFor(o);
    let user = getSetting(db, 'lock_user_handle');
    if (!user) { user = b64u(randomBytes(16)); setSetting(db, 'lock_user_handle', user); }
    return {
      challenge: issue('create', rpId),
      rp: { id: rpId, name: 'Mint' },
      user: { id: user, name: 'mint', displayName: 'Mint' },
      pubKeyCredParams: ALGS.map((alg) => ({ type: 'public-key', alg })),
      // Discoverable is preferred, not required: a synced passkey is what lets a desktop
      // with no fingerprint reader unlock through the phone (the browser's QR flow).
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred', requireResidentKey: false },
      attestation: 'none',
      timeout: 60_000,
      excludeCredentials: credentials().map((c) => ({ type: 'public-key', id: c.id })),
    };
  }

  // firstOnly: the caller is not unlocked, so this may only be the very first fingerprint.
  // Checked again inside the write, so two first-run enrolments cannot both land.
  function register({ attestationObject, clientDataJSON, label } = {}, { firstOnly = false } = {}) {
    const { rpId } = spend(clientDataJSON, 'webauthn.create', 'create');
    const att = cborDecode(unb64u(attestationObject, 'attestationObject')).value;
    if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) fail('format', 'attestation object has no authData');
    const a = parseAuthData(att.get('authData'));
    checkAuthData(a, rpId);
    if (!a.credentialId || !a.coseKey) fail('format', 'no attested credential data');
    const { alg, key } = coseToKey(a.coseKey);
    const id = b64u(a.credentialId);
    if (db.prepare('SELECT 1 FROM lock_credentials WHERE id = ?').get(id)) fail('duplicate', 'that fingerprint is already set up');
    const clean = String(label ?? '').replace(/[^\p{L}\p{N} ._()'-]/gu, '').trim().slice(0, 60) || 'Fingerprint';
    let first = false;
    tx(db, () => {
      first = count() === 0;
      if (firstOnly && !first) fail('locked', 'a fingerprint is already set up; unlock to add another');
      db.prepare('INSERT INTO lock_credentials (id, public_key, alg, sign_count, label, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, key.export({ type: 'spki', format: 'der' }).toString('base64'), alg, a.counter, clean, new Date(now()).toISOString());
      if (!getSetting(db, 'lock_enabled_at')) setSetting(db, 'lock_enabled_at', new Date(now()).toISOString());
    });
    log(`lock: fingerprint "${clean}" enrolled (${alg === -7 ? 'ES256' : 'RS256'})${first ? ', the first one: the lock is on' : ''}`);
    return { credentialId: id };
  }

  function assertOptions({ origin: o }) {
    const rpId = rpFor(o);
    return {
      challenge: issue('get', rpId),
      rpId,
      allowCredentials: credentials().map((c) => ({ type: 'public-key', id: c.id })),
      userVerification: 'required',
      timeout: 60_000,
    };
  }

  function assert({ id, authenticatorData, clientDataJSON, signature } = {}) {
    const { raw, rpId } = spend(clientDataJSON, 'webauthn.get', 'get');
    const adBuf = unb64u(authenticatorData, 'authenticatorData');
    const a = parseAuthData(adBuf);
    checkAuthData(a, rpId);
    const row = typeof id === 'string' ? db.prepare('SELECT * FROM lock_credentials WHERE id = ?').get(id) : null;
    if (!row) fail('credential', 'that fingerprint is not set up for Mint');
    const key = createPublicKey({ key: Buffer.from(row.public_key, 'base64'), format: 'der', type: 'spki' });
    let ok = false;
    try { ok = verify('sha256', Buffer.concat([adBuf, sha256(raw)]), key, unb64u(signature, 'signature')); } catch { ok = false; }
    if (!ok) fail('signature', 'signature does not verify');
    // A counting authenticator must go up every time; one that has never counted may stay at 0.
    if ((a.counter !== 0 || row.sign_count !== 0) && a.counter <= row.sign_count) fail('counter', 'signature counter did not go up (a cloned key?)');
    db.prepare('UPDATE lock_credentials SET sign_count = ?, last_used_at = ? WHERE id = ?').run(a.counter, new Date(now()).toISOString(), row.id);
    return { credentialId: row.id };
  }

  function removeCredential(id) {
    const row = db.prepare('SELECT id FROM lock_credentials WHERE id = ?').get(String(id));
    if (!row) fail('credential', 'no such fingerprint');
    if (count() <= 1) fail('last', 'Mint keeps at least one fingerprint. Add another first, then remove this one.');
    tx(db, () => {
      db.prepare('DELETE FROM lock_credentials WHERE id = ?').run(row.id);
      db.prepare('DELETE FROM lock_sessions WHERE credential_id = ?').run(row.id);
    });
    log('lock: a fingerprint was removed');
  }

  // ---------- sessions ----------

  // Read each time (one indexed row), so scripts/lock-reset.mjs rotating it under a
  // running server takes effect at once.
  const secret = () => {
    let s = getSetting(db, 'lock_cookie_secret');
    if (!/^[0-9a-f]{64}$/.test(s ?? '')) { s = randomBytes(32).toString('hex'); setSetting(db, 'lock_cookie_secret', s); }
    return Buffer.from(s, 'hex');
  };
  const mac = (sid) => createHmac('sha256', secret()).update(sid).digest('base64url');
  const sidKey = (sid) => sha256(sid).toString('hex');

  function startSession(credentialId) {
    const sid = b64u(randomBytes(32));
    const t = now();
    db.prepare('DELETE FROM lock_sessions WHERE seen_at < ? OR created_at < ?').run(t - idleMs, t - maxMs);
    db.prepare('INSERT INTO lock_sessions (id, credential_id, created_at, seen_at) VALUES (?, ?, ?, ?)').run(sidKey(sid), credentialId ?? null, t, t);
    return `${sid}.${mac(sid)}`;
  }

  function parse(value) {
    const m = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(String(value ?? ''));
    if (!m) return null;
    const want = Buffer.from(mac(m[1]));
    const got = Buffer.from(m[2]);
    return want.length === got.length && timingSafeEqual(want, got) ? m[1] : null;
  }

  // The live session for a cookie value, or null. Use slides the idle window.
  function session(value) {
    const sid = parse(value);
    if (!sid) return null;
    const row = db.prepare('SELECT * FROM lock_sessions WHERE id = ?').get(sidKey(sid));
    const t = now();
    if (!row) return null;
    if (t - row.seen_at > idleMs || t - row.created_at > maxMs) {
      db.prepare('DELETE FROM lock_sessions WHERE id = ?').run(row.id);
      return null;
    }
    if (t - row.seen_at > 5_000) db.prepare('UPDATE lock_sessions SET seen_at = ? WHERE id = ?').run(t, row.id);
    return { createdAt: row.created_at, expiresAt: Math.min(t + idleMs, row.created_at + maxMs) };
  }

  function revoke(value) {
    const sid = parse(value);
    if (sid) db.prepare('DELETE FROM lock_sessions WHERE id = ?').run(sidKey(sid));
  }

  // Break glass (scripts/lock-reset.mjs uses the same steps): every fingerprint
  // and session gone, a fresh cookie secret. The lock itself stays on.
  function reset() {
    tx(db, () => {
      db.prepare('DELETE FROM lock_credentials').run();
      db.prepare('DELETE FROM lock_sessions').run();
      setSetting(db, 'lock_cookie_secret', randomBytes(32).toString('hex'));
    });
  }

  const cookieHeader = (value) => `${LOCK_COOKIE}=${value}; Path=/; Max-Age=${Math.floor(maxMs / 1000)}; HttpOnly; Secure; SameSite=Strict`;
  const clearCookieHeader = () => `${LOCK_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

  return {
    rpFor, credentials, count, registerOptions, register, assertOptions, assert, removeCredential,
    startSession, session, revoke, reset, cookieHeader, clearCookieHeader, idleMs,
  };
}

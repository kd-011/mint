// A software authenticator for the lock tests: makes the same bytes a phone's
// platform authenticator would (CBOR attestation object, authenticator data,
// clientDataJSON, a DER ES256 or PKCS#1 RS256 signature), with knobs to break
// each field the server must check.
import { createHash, generateKeyPairSync, sign, randomBytes } from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (b) => createHash('sha256').update(b).digest();

// Minimal CBOR encoder: unsigned and negative ints, byte and text strings, arrays, maps.
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
export function cbor(v) {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error(`cbor: cannot encode ${typeof v}`);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export function authenticator({ alg = -7 } = {}) {
  const pair = alg === -257
    ? generateKeyPairSync('rsa', { modulusLength: 2048 })
    : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const coseKey = alg === -257
    ? new Map([[1, 3], [3, -257], [-1, Buffer.from(jwk.n, 'base64url')], [-2, Buffer.from(jwk.e, 'base64url')]])
    : new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
  const credId = randomBytes(32);
  let counter = 0;

  const authData = ({ rpId, flags, count, attested }) => {
    const c = Buffer.alloc(4); c.writeUInt32BE(count >>> 0);
    const parts = [sha256(rpId), Buffer.from([flags]), c];
    if (attested) {
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      parts.push(Buffer.alloc(16), len, credId, cbor(coseKey));
    }
    return Buffer.concat(parts);
  };
  const clientData = ({ type, challenge, origin }) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

  return {
    id: b64u(credId),
    // navigator.credentials.create(), as the page would post it.
    create({ challenge, origin, rpId, uv = true, up = true, type = 'webauthn.create', fmt = 'none' }) {
      const flags = (up ? FLAG_UP : 0) | (uv ? FLAG_UV : 0) | FLAG_AT;
      const ad = authData({ rpId, flags, count: counter, attested: true });
      const att = cbor(new Map([['fmt', fmt], ['attStmt', new Map()], ['authData', ad]]));
      return { id: b64u(credId), attestationObject: b64u(att), clientDataJSON: b64u(clientData({ type, challenge, origin })) };
    },
    // navigator.credentials.get(). count sets the signature counter (default: one up; 0 is a passkey that never counts).
    get({ challenge, origin, rpId, uv = true, up = true, type = 'webauthn.get', count, tamper = false }) {
      if (count === undefined) count = counter + 1;
      counter = count;
      const ad = authData({ rpId, flags: (up ? FLAG_UP : 0) | (uv ? FLAG_UV : 0), count });
      const cd = clientData({ type, challenge, origin });
      const sig = sign('sha256', Buffer.concat([ad, sha256(cd)]), pair.privateKey);
      if (tamper) sig[sig.length - 1] ^= 0x01;
      return { id: b64u(credId), authenticatorData: b64u(ad), clientDataJSON: b64u(cd), signature: b64u(sig) };
    },
    setCounter(n) { counter = n; },
  };
}

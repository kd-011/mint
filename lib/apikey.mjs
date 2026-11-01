// The bearer key for the assistant's server-to-server calls. Compared in constant time,
// and honoured only for a caller that connected straight to this socket from the
// same machine: anything that came through the tunnel or the gate carries proxy
// headers, and a key presented there is refused like a wrong one.
import { createHash, timingSafeEqual } from 'node:crypto';

export const MIN_KEY_LENGTH = 32;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PROXIED = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'remote-user', 'x-mint-gate'];

// The token of an Authorization: Bearer header, or null when there is none.
export function parseBearer(header) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(header ?? ''));
  return m ? m[1] : null;
}

export function keyMatches(presented, key) {
  if (!key || key.length < MIN_KEY_LENGTH) return false;
  const a = createHash('sha256').update(String(presented)).digest();
  const b = createHash('sha256').update(key).digest();
  return timingSafeEqual(a, b);
}

export function isDirectLoopback(req) {
  return LOOPBACK.has(req.socket.remoteAddress ?? '') && !PROXIED.some((h) => h in req.headers);
}

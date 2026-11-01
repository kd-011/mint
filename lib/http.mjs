// Response and body helpers shared by the server and the engine API.
import { HttpError } from './errors.mjs';

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), geolocation=(), microphone=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) { reject(new HttpError(413, 'body too large')); req.resume(); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // Drain rather than destroy, so the 413 still reaches the client.
        reject(new HttpError(413, 'body too large'));
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export const readBody = async (req, limit) => (await readRaw(req, limit)).toString('utf8');

export async function readJson(req, limit = 64 * 1024) {
  const text = await readBody(req, limit);
  try {
    const v = JSON.parse(text || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch { throw new HttpError(400, 'body must be a JSON object'); }
}

// Fixed-window counter per key, for the endpoints that cost money or disk.
export function rateLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const e = hits.get(key);
    if (!e || e.until < now) { hits.set(key, { n: 1, until: now + windowMs }); return false; }
    e.n += 1;
    return e.n > max;
  };
}

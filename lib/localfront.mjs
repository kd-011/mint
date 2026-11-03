// The small proxy in front of a Mint that has no login gateway: the demo and local mode. Mint refuses
// anything that did not come through a gateway, so this adds the gateway's two headers to what the
// browser sends. That makes it the only thing guarding the book, so it answers only to this machine:
// a page on another site, or a DNS name rebound to 127.0.0.1, is refused here before it reaches Mint.
import { createServer, request } from 'node:http';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const parse = (s) => { try { return new URL(s); } catch { return null; } };

/** Why this request may not come in, or null. Host and Origin are as the browser sent them. */
export function refusal({ host, origin }) {
  const h = host ? parse(`http://${host}`) : null;
  if (!h || !LOOPBACK.has(h.hostname)) return 'This Mint only answers on 127.0.0.1 or localhost. To reach it from another device, put a login proxy in front: see docs/self-hosting.md.';
  if (origin != null) {
    const o = parse(origin);
    if (!o || o.protocol !== 'http:' || o.host !== h.host) return 'cross-origin request refused';
  }
  return null;
}

const page = (line) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0b0d0c"><meta http-equiv="refresh" content="2"><title>Mint</title>
<style>html{color-scheme:dark}body{margin:0;min-height:100dvh;display:grid;place-content:center;justify-items:center;gap:16px;background:#0b0d0c;color:#c9d2cd;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px}
i{width:22px;height:22px;border-radius:50%;border:2px solid #2a312d;border-top-color:#3ddc97;animation:s .8s linear infinite}@keyframes s{to{transform:rotate(1turn)}}@media (prefers-reduced-motion:reduce){i{animation:none}}</style>
<i aria-hidden="true"></i><p role="status">${line}</p></html>`;

/** An http.Server (not yet listening) that passes loopback requests to Mint on innerPort, as the gateway would. */
export function createFront({ innerPort, gate, user = 'owner', upstreamOrigin, ready = () => true, loading = 'Starting Mint.' }) {
  return createServer((req, res) => {
    const why = refusal({ host: req.headers.host, origin: req.headers.origin });
    if (why) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`${why}\n`);
    }
    if (!ready() && req.url !== '/healthz') {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '2', 'Cache-Control': 'no-store' });
      return res.end(page(loading));
    }
    const headers = { ...req.headers, 'remote-user': user, 'x-mint-gate': gate };
    // The origin has just been checked against this host, and Mint knows the page by one name only.
    if (headers.origin) headers.origin = upstreamOrigin;
    const up = request({ host: '127.0.0.1', port: innerPort, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Mint is not up yet.\n');
    });
    req.pipe(up);
  });
}

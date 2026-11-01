// Redbark webhook receiver. Two signing formats reach the same path:
//  - webhook destinations (a Redbark sync delivering transactions):
//    X-Redbark-Signature: sha256=<hex>, X-Redbark-Timestamp, X-Redbark-Delivery-Id
//  - v2 event destinations (thin events): Redbark-Signature: t=<sec>,v1=<hex>[,v1=...]
// Both are HMAC-SHA256 over "<timestamp>.<raw body>", checked in constant time
// before the body is parsed, with a 5 minute replay window. A delivery only
// triggers an API sync: rows are always re-read through the v2 API so there is
// one source of transaction ids (webhook and v2 ids are not documented as equal).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { addDays, isIsoDate } from './dates.mjs';

const TOLERANCE_SEC = 300;

const digest = (secret, t, body) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
const sameHex = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fresh = (t, nowSec, tolerance) => Number.isFinite(t) && t > 0 && Math.abs(nowSec - t) <= tolerance;

export function verifyLegacySignature({ signature, timestamp, rawBody, secrets, nowSec, tolerance = TOLERANCE_SEC }) {
  if (typeof signature !== 'string' || typeof timestamp !== 'string' || !secrets?.length) return false;
  if (!/^\d{1,12}$/.test(timestamp) || !fresh(Number(timestamp), nowSec, tolerance)) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signature.trim());
  if (!m) return false;
  const got = m[1].toLowerCase();
  return secrets.some((s) => sameHex(got, digest(s, timestamp, rawBody)));
}

export function verifyEventSignature({ header, rawBody, secrets, nowSec, tolerance = TOLERANCE_SEC }) {
  if (typeof header !== 'string' || !secrets?.length) return false;
  let t = null;
  const sigs = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && t === null && /^\d{1,12}$/.test(v)) t = v;
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) sigs.push(v.toLowerCase());
  }
  if (t === null || !sigs.length || !fresh(Number(t), nowSec, tolerance)) return false;
  return secrets.some((s) => {
    const want = digest(s, t, rawBody);
    return sigs.some((g) => sameHex(g, want));
  });
}

const ACCOUNT_ID = /^acct_[A-Za-z0-9_]{1,64}$/;

export function createWebhookHandler({ db, secrets, onSync, onConnections, now = () => Date.now(), log = console.log }) {
  const record = db.prepare(`INSERT INTO webhook_deliveries (delivery_id, kind, event_type, received_at, rows, outcome)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING`);
  const finish = db.prepare('UPDATE webhook_deliveries SET rows = ?, outcome = ? WHERE delivery_id = ?');
  const exists = db.prepare('SELECT 1 FROM webhook_deliveries WHERE delivery_id = ?');

  return async function handle({ headers, rawBody, ip }) {
    const webhookSecrets = secrets.webhook ?? [];
    const eventSecrets = secrets.events ?? [];
    if (!webhookSecrets.length && !eventSecrets.length) return { status: 503, body: { error: 'webhook not configured' } };

    const nowSec = Math.floor(now() / 1000);
    let kind = null;
    let ok = false;
    if (headers['redbark-signature']) {
      kind = 'event';
      ok = verifyEventSignature({ header: headers['redbark-signature'], rawBody, secrets: eventSecrets, nowSec });
    } else if (headers['x-redbark-signature']) {
      kind = 'webhook';
      ok = verifyLegacySignature({ signature: headers['x-redbark-signature'], timestamp: headers['x-redbark-timestamp'], rawBody, secrets: webhookSecrets, nowSec });
    }
    if (!ok) {
      log(`webhook: signature rejected (${kind ?? 'unsigned'}) from ${String(ip).replace(/[^\w.:-]/g, '')}`);
      return { status: 401, body: { error: 'bad signature' } };
    }

    let payload;
    try { payload = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'body is not JSON' } }; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { status: 400, body: { error: 'body is not an object' } };

    const id = kind === 'event' ? (headers['redbark-event-id'] || payload.id) : (headers['x-redbark-delivery-id'] || payload.id);
    if (typeof id !== 'string' || !id || id.length > 200) return { status: 400, body: { error: 'missing delivery id' } };
    const type = typeof payload.type === 'string' ? payload.type.slice(0, 100) : 'unknown';

    // The delivery id header is not covered by the HMAC, so a captured request
    // replayed with a fresh id must still dedupe: key on the signature as well.
    const sigKey = `sig:${createHash('sha256').update(String(headers['redbark-signature'] ?? headers['x-redbark-signature'])).digest('hex')}`;
    const at = new Date(now()).toISOString();
    if (exists.get(sigKey) || record.run(id, kind, type, at, 0, 'received').changes === 0) {
      return { status: 200, body: { ok: true, duplicate: true } };
    }
    record.run(sigKey, kind, type, at, 0, `signature of ${id.slice(0, 100)}`);

    let rows = 0;
    let outcome = 'recorded';
    if (kind === 'webhook' && type === 'transactions.synced') {
      const list = [...(Array.isArray(payload.data?.new) ? payload.data.new : []), ...(Array.isArray(payload.data?.updated) ? payload.data.updated : [])]
        .filter((r) => r && typeof r === 'object');
      rows = list.length;
      const accounts = [...new Set(list.map((r) => r.account_public_id).filter((a) => typeof a === 'string' && ACCOUNT_ID.test(a)))];
      const dates = list.map((r) => r.local_date).filter(isIsoDate).sort();
      if (rows) {
        onSync({ accounts: accounts.length ? accounts : null, from: dates.length ? addDays(dates[0], -3) : null, reason: 'webhook' });
        outcome = 'sync queued';
      }
    } else if (kind === 'event') {
      if (type.startsWith('connection.')) {
        onConnections({ type, id: payload.related_object?.id ?? null });
        outcome = 'connections refresh queued';
      } else if (type === 'transactions.synced' || type === 'sync_run.succeeded') {
        onSync({ accounts: null, from: null, reason: 'event' });
        outcome = 'sync queued';
      }
    }
    finish.run(rows, outcome, id);
    log(`webhook: ${kind} ${type} ${rows ? `${rows} rows, ` : ''}${outcome}`);
    return { status: 200, body: { ok: true } };
  };
}

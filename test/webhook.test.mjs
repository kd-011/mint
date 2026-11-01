import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { openDb } from '../lib/db.mjs';
import { verifyLegacySignature, verifyEventSignature, createWebhookHandler } from '../lib/webhook.mjs';

const SECRET = 'whsec_test_invented';
const NOW = 1_792_000_000;
const sign = (secret, t, body) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

function legacy(body, { secret = SECRET, t = NOW, id = 'dlv-1' } = {}) {
  return {
    'content-type': 'application/json',
    'x-redbark-signature': `sha256=${sign(secret, t, body)}`,
    'x-redbark-timestamp': String(t),
    'x-redbark-delivery-id': id,
  };
}
function event(body, { secrets = [SECRET], t = NOW, delivery = 'del_1', eventId = 'evt_1' } = {}) {
  return {
    'content-type': 'application/json',
    'redbark-signature': [`t=${t}`, ...secrets.map((s) => `v1=${sign(s, t, body)}`)].join(','),
    'redbark-delivery-id': delivery,
    'redbark-event-id': eventId,
  };
}

const synced = JSON.stringify({
  id: 'dlv-1', object: 'event', type: 'transactions.synced', api_version: '2026-03-15', created: NOW,
  data: {
    new: [
      { id: 'abc', amount: -4550, currency: 'aud', status: 'posted', description: 'TEST GROCER', direction: 'debit', class: 'payment', account_public_id: 'acct_test_everyday', local_date: '2026-10-15', merchant_name: null, category: 'FOOD_AND_DRINK', some_future_field: 1 },
      { id: 'def', amount: 1000, currency: 'aud', status: 'posted', description: 'TEST REFUND', direction: 'credit', class: 'payment', account_public_id: 'acct_test_card', local_date: '2026-10-12', merchant_name: null, category: 'INCOME' },
    ],
    updated: [],
  },
  metadata: { sync_run_id: 'run_x', new_count: 2, updated_count: 0, chunk: 1, total_chunks: 1 },
});

function setup(secrets = { webhook: [SECRET], events: [SECRET] }) {
  const db = openDb(':memory:');
  const syncs = [];
  const conns = [];
  const handler = createWebhookHandler({
    db, secrets, now: () => NOW * 1000,
    onSync: (x) => syncs.push(x), onConnections: (x) => conns.push(x), log: () => {},
  });
  return { db, handler, syncs, conns };
}

test('legacy signature: valid, tampered, stale, wrong secret, rotation', () => {
  const body = '{"a":1}';
  const ok = (o) => verifyLegacySignature({ rawBody: body, secrets: [SECRET], nowSec: NOW, ...o });
  assert.equal(ok({ signature: `sha256=${sign(SECRET, NOW, body)}`, timestamp: String(NOW) }), true);
  assert.equal(ok({ signature: `sha256=${sign(SECRET, NOW, body)}`, timestamp: String(NOW), rawBody: '{"a":2}' }), false);
  assert.equal(ok({ signature: `sha256=${sign(SECRET, NOW - 301, body)}`, timestamp: String(NOW - 301) }), false);
  assert.equal(ok({ signature: `sha256=${sign(SECRET, NOW + 301, body)}`, timestamp: String(NOW + 301) }), false);
  assert.equal(ok({ signature: `sha256=${sign('other', NOW, body)}`, timestamp: String(NOW) }), false);
  assert.equal(ok({ signature: `sha256=${sign(SECRET, NOW, body)}`, timestamp: String(NOW), secrets: ['new', SECRET] }), true);
  assert.equal(ok({ signature: 'sha256=zz', timestamp: String(NOW) }), false);
  assert.equal(ok({ signature: undefined, timestamp: undefined }), false);
  assert.equal(ok({ signature: `sha256=${sign(SECRET, NOW, body)}`, timestamp: String(NOW), secrets: [] }), false);
});

test('event signature: t=,v1= with two v1 values during rotation', () => {
  const body = '{"type":"event_destination.ping"}';
  const header = `t=${NOW},v1=${sign('old', NOW, body)},v1=${sign(SECRET, NOW, body)}`;
  assert.equal(verifyEventSignature({ header, rawBody: body, secrets: [SECRET], nowSec: NOW }), true);
  assert.equal(verifyEventSignature({ header, rawBody: body, secrets: ['nope'], nowSec: NOW }), false);
  assert.equal(verifyEventSignature({ header, rawBody: body, secrets: [SECRET], nowSec: NOW + 400 }), false);
  assert.equal(verifyEventSignature({ header: 'garbage', rawBody: body, secrets: [SECRET], nowSec: NOW }), false);
});

test('fails closed with 503 when no secret is configured', async () => {
  const { handler } = setup({ webhook: [], events: [] });
  const r = await handler({ headers: legacy(synced), rawBody: synced, ip: '1.2.3.4' });
  assert.equal(r.status, 503);
});

test('unsigned and badly signed deliveries get 401 and do nothing', async () => {
  const { handler, syncs, db } = setup();
  assert.equal((await handler({ headers: { 'content-type': 'application/json' }, rawBody: synced, ip: 'x' })).status, 401);
  assert.equal((await handler({ headers: legacy(synced, { secret: 'wrong' }), rawBody: synced, ip: 'x' })).status, 401);
  assert.equal((await handler({ headers: legacy(synced, { t: NOW - 600 }), rawBody: synced, ip: 'x' })).status, 401);
  assert.equal(syncs.length, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM webhook_deliveries').get().n, 0);
});

test('transactions.synced data payload triggers a sync of the named accounts', async () => {
  const { handler, syncs, db } = setup();
  const r = await handler({ headers: legacy(synced), rawBody: synced, ip: 'x' });
  assert.equal(r.status, 200);
  assert.equal(syncs.length, 1);
  assert.deepEqual([...syncs[0].accounts].sort(), ['acct_test_card', 'acct_test_everyday']);
  assert.equal(syncs[0].from, '2026-10-09');
  const row = db.prepare('SELECT * FROM webhook_deliveries').get();
  assert.equal(row.delivery_id, 'dlv-1');
  assert.equal(row.event_type, 'transactions.synced');
  assert.equal(row.rows, 2);
});

test('a retried delivery id is acknowledged once and not re-processed', async () => {
  const { handler, syncs } = setup();
  await handler({ headers: legacy(synced), rawBody: synced, ip: 'x' });
  const again = await handler({ headers: legacy(synced), rawBody: synced, ip: 'x' });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(syncs.length, 1);
});

test('valid signature but broken JSON is a 400', async () => {
  const { handler } = setup();
  const body = '{not json';
  assert.equal((await handler({ headers: legacy(body, { id: 'dlv-bad' }), rawBody: body, ip: 'x' })).status, 400);
});

test('thin event ping is recorded and triggers nothing', async () => {
  const { handler, syncs, conns, db } = setup();
  const body = JSON.stringify({ id: 'evt_1', object: 'event', type: 'event_destination.ping', created: '2026-10-17T00:00:00Z', livemode: true, related_object: { id: 'ed_1', type: 'event_destination', url: '' } });
  const r = await handler({ headers: event(body), rawBody: body, ip: 'x' });
  assert.equal(r.status, 200);
  assert.equal(syncs.length + conns.length, 0);
  assert.equal(db.prepare("SELECT event_type FROM webhook_deliveries WHERE delivery_id='evt_1'").get().event_type, 'event_destination.ping');
});

test('thin connection events refresh connections; sync events trigger a poll', async () => {
  const { handler, syncs, conns } = setup();
  const c = JSON.stringify({ id: 'evt_2', object: 'event', type: 'connection.expiring', related_object: { id: 'conn_test_beta', type: 'connection', url: '' } });
  assert.equal((await handler({ headers: event(c, { eventId: 'evt_2', delivery: 'd2' }), rawBody: c, ip: 'x' })).status, 200);
  assert.equal(conns.length, 1);
  const s = JSON.stringify({ id: 'evt_3', object: 'event', type: 'transactions.synced', related_object: { id: 'run_1', type: 'sync_run', url: '' } });
  assert.equal((await handler({ headers: event(s, { eventId: 'evt_3', delivery: 'd3' }), rawBody: s, ip: 'x' })).status, 200);
  assert.equal(syncs.length, 1);
  assert.equal(syncs[0].accounts, null, 'thin event names no accounts, so sync them all');
});

test('a captured delivery replayed under a fresh delivery id is still a duplicate', async () => {
  const { handler, syncs } = setup();
  await handler({ headers: legacy(synced), rawBody: synced, ip: 'x' });
  const replay = { ...legacy(synced), 'x-redbark-delivery-id': 'attacker-new-id' };
  const r = await handler({ headers: replay, rawBody: synced, ip: 'x' });
  assert.equal(r.status, 200);
  assert.equal(r.body.duplicate, true);
  assert.equal(syncs.length, 1);
});

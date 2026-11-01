// (h) Alert pipeline: the four push types (unusual charge, new subscription or
// price rise, sync or consent problem, budget at 90 percent and over) with
// dedupe in the DB, and the weekly summary line for the morning brief.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { book, monthsBack } from './fixtures/book.mjs';
import { runAlerts, listAlerts, dismissAlert, weeklySummary } from '../lib/alerts.mjs';
import { setBudget } from '../lib/budgets.mjs';
import { applyRules, createRule } from '../lib/categorise.mjs';
import { matchTransfers } from '../lib/transfers.mjs';

const NOW = new Date('2026-10-17T02:00:00Z');
const run = (b, now = NOW) => runAlerts(b.db, { now });
const kinds = (list) => list.map((a) => `${a.kind}:${a.type}`).sort();

test('unusual charge alerts once', () => {
  const b = book();
  b.add('acct_t_card', '2026-10-15', -45000, 'TEST LUXURY GOODS');
  const first = run(b);
  assert.deepEqual(kinds(first), ['unusual:new_merchant']);
  assert.match(first[0].title, /Test Luxury Goods/);
  assert.match(first[0].body, /\$450\.00/);
  assert.deepEqual(run(b), []);
  assert.equal(listAlerts(b.db).length, 1);
});

test('new subscription and price rise alert once each', () => {
  const b = book();
  b.add('acct_t_card', '2026-09-08', -2200, 'TESTSTREAM PREMIUM');
  b.add('acct_t_card', '2026-10-08', -2200, 'TESTSTREAM PREMIUM');
  for (let n = 5; n >= 1; n--) b.add('acct_t_card', monthsBack('2026-10-03', n), -1599, 'TESTMUSIC');
  b.add('acct_t_card', '2026-10-03', -1799, 'TESTMUSIC');
  assert.deepEqual(kinds(run(b)), ['subscription:new', 'subscription:price_rise']);
  assert.deepEqual(run(b), []);
});

test('an old established subscription does not alert', () => {
  const b = book();
  for (let n = 12; n >= 0; n--) b.add('acct_t_card', monthsBack('2026-10-05', n), -1599, 'TESTFLIX');
  assert.deepEqual(run(b), []);
});

test('sync broken and consent expiring, once per incident', () => {
  const b = book();
  b.db.prepare("UPDATE accounts SET last_sync_error = 'account_unavailable: gone' WHERE id = 'acct_t_card'").run();
  b.db.prepare("UPDATE connections SET consent_expires_at = '2026-11-01T00:00:00.000Z' WHERE id = 'conn_t_beta'").run();
  assert.deepEqual(kinds(run(b)), ['sync:account_error', 'sync:consent_expiring']);
  assert.deepEqual(run(b), []);
  // Fixed, then broken again later: a new incident.
  b.db.prepare("UPDATE accounts SET last_sync_error = NULL, last_synced_at = '2026-10-18T01:00:00.000Z'").run();
  assert.deepEqual(run(b, new Date('2026-10-18T02:00:00Z')), []);
  b.db.prepare("UPDATE accounts SET last_synced_at = '2026-10-19T01:00:00.000Z' WHERE id != 'acct_t_card'").run();
  b.db.prepare("UPDATE accounts SET last_sync_error = 'network_error: timeout' WHERE id = 'acct_t_card'").run();
  assert.deepEqual(kinds(run(b, new Date('2026-10-19T02:00:00Z'))), ['sync:account_error']);
  // A connection that is no longer active.
  b.db.prepare("UPDATE connections SET status = 'revoked' WHERE id = 'conn_t_alpha'").run();
  assert.deepEqual(kinds(run(b, new Date('2026-10-19T03:00:00Z'))), ['sync:connection']);
});

test('a stale account (no successful sync for a day) is a sync problem', () => {
  const b = book();
  b.db.prepare("UPDATE accounts SET last_synced_at = '2026-10-15T00:00:00.000Z' WHERE id = 'acct_t_savings'").run();
  assert.deepEqual(kinds(run(b)), ['sync:stale']);
});

test('budget at 90 percent and over, once per category per month', () => {
  const b = book();
  createRule(b.db, { field: 'description', match: 'contains', pattern: 'TEST GROCER', category_id: b.cat('Groceries') });
  setBudget(b.db, b.cat('Groceries'), { monthly_target: 10000 });
  b.add('acct_t_everyday', '2026-10-02', -9500, 'TEST GROCER');
  applyRules(b.db);
  const a = run(b);
  assert.deepEqual(kinds(a), ['budget:90']);
  assert.match(a[0].title, /Groceries/);
  assert.deepEqual(run(b), []);
  b.add('acct_t_everyday', '2026-10-03', -1000, 'TEST GROCER');
  applyRules(b.db);
  assert.deepEqual(kinds(run(b)), ['budget:over']);
  assert.deepEqual(run(b), []);
  b.add('acct_t_everyday', '2026-11-03', -9800, 'TEST GROCER');
  applyRules(b.db);
  b.db.prepare("UPDATE accounts SET last_synced_at = '2026-11-05T01:00:00.000Z'").run();
  assert.deepEqual(kinds(run(b, new Date('2026-11-05T02:00:00Z'))), ['budget:90']);
});

test('list is newest first and dismiss hides an alert', () => {
  const b = book();
  b.add('acct_t_card', '2026-10-15', -45000, 'TEST LUXURY GOODS');
  b.db.prepare("UPDATE accounts SET last_sync_error = 'boom' WHERE id = 'acct_t_card'").run();
  run(b);
  const list = listAlerts(b.db);
  assert.equal(list.length, 2);
  assert.ok(list[0].created_at >= list[1].created_at);
  for (const a of list) {
    assert.ok(a.id && a.kind && a.type && a.title && a.created_at);
    assert.equal(a.pushed_at, null);
  }
  dismissAlert(b.db, list[0].id);
  assert.equal(listAlerts(b.db).length, 1);
  assert.equal(listAlerts(b.db, { includeDismissed: true }).length, 2);
  assert.throws(() => dismissAlert(b.db, 9999), (e) => e.status === 404);
});

test('weekly summary is one line over last Monday to Sunday, transfers left out', () => {
  const b = book();
  createRule(b.db, { field: 'description', match: 'contains', pattern: 'TEST GROCER', category_id: b.cat('Groceries') });
  b.add('acct_t_everyday', '2026-10-06', -12000, 'TEST GROCER'); // in last week (Mon 5 to Sun 11 Oct)
  b.add('acct_t_card', '2026-10-10', -3000, 'TEST CINEMA', { provider_category: 'ENTERTAINMENT' });
  b.add('acct_t_everyday', '2026-10-09', 250000, 'SALARY/WAGES TEST');
  b.add('acct_t_everyday', '2026-10-07', -80000, 'ONLINE Linked Acc Trns', { provider_category: 'TRANSFER_OUT' });
  b.add('acct_t_savings', '2026-10-07', 80000, 'ONLINE Linked Acc Trns', { provider_category: 'TRANSFER_IN' });
  b.add('acct_t_everyday', '2026-10-13', -99900, 'TEST GROCER'); // this week, not counted
  applyRules(b.db);
  matchTransfers(b.db);
  const line = weeklySummary(b.db, '2026-10-17');
  assert.equal(typeof line, 'string');
  assert.doesNotMatch(line, /\n/);
  assert.match(line, /\$150\.00/); // spent
  assert.match(line, /\$2,500\.00/); // income
  assert.match(line, /Groceries \$120\.00/);
  assert.doesNotMatch(line, /\$999|\$800/);
  assert.match(line, /05\/10/);
});

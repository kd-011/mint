import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.mjs';

const TABLES = ['connections', 'accounts', 'transactions', 'balance_snapshots', 'manual_assets', 'manual_snapshots',
  'categories', 'rules', 'budgets', 'tax_tags', 'receipts', 'transfers', 'alerts', 'sync_log', 'webhook_deliveries', 'settings'];

test('schema has every table the plan needs', () => {
  const db = openDb(':memory:');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of TABLES) assert.ok(names.includes(t), `missing ${t}`);
});

test('opening twice is idempotent and WAL is on for a file db', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mint-db-'));
  const p = join(dir, 'mint.db');
  openDb(p).close();
  const db = openDb(p);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
});

test('foreign keys are enforced and money is integer only', () => {
  const db = openDb(':memory:');
  assert.throws(() => db.prepare("INSERT INTO transactions (id, account_id, status, date, amount, currency, first_seen_at, updated_at) VALUES ('t','nope','posted','2026-01-01',1,'AUD','x','x')").run(), /FOREIGN KEY/);
  db.prepare("INSERT INTO connections (id, institution, status, updated_at) VALUES ('c','Bank','active','x')").run();
  db.prepare("INSERT INTO accounts (id, connection_id, name, type, institution, created_at, updated_at) VALUES ('a','c','A','transaction','Bank','x','x')").run();
  assert.throws(() => db.prepare("INSERT INTO transactions (id, account_id, status, date, amount, currency, first_seen_at, updated_at) VALUES ('t','a','posted','2026-01-01',12.5,'AUD','x','x')").run(), /CHECK/);
});

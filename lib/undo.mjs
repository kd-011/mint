// Undo and confirm tokens for the chat door (lib/chatwrites.mjs).
//
// Every chat write runs inside capture(): the tracked tables are read before
// and after, and the rows that differ are kept with both versions. That diff is
// the undo record: restoring it puts back exactly what was there, and it also
// says how many rows a write touches, which is how a write too big to apply
// unasked (more than 5 transactions) is caught. Undo refuses when a row has
// changed since, or when undoing an add would take later rows with it.
//
// Tokens are 32 random bytes; only their SHA-256 is stored. Undo tokens last
// 24 hours, confirm tokens 10 minutes, and each is good for one use. A confirm
// token holds its operation and parameters server side, so it can only ever
// apply the one thing it was issued for.
import { createHash, randomBytes } from 'node:crypto';
import { HttpError, notFound } from './errors.mjs';
import { tx } from './db.mjs';

export const UNDO_MS = 24 * 3600_000;
export const CONFIRM_MS = 10 * 60_000;
const PRUNE_MS = 7 * 24 * 3600_000;

// What a chat write can change, parents before children. `cols` limits a big
// or sync-owned table to the columns the owner can set; `ignore` is derived data
// left out of the comparison; `where` narrows a shared table.
const TRACKED = [
  { table: 'accounts', key: ['id'], cols: ['id', 'nickname', 'hidden', 'is_business', 'spendable', 'type', 'type_override', 'feed_type'] },
  { table: 'transactions', key: ['id'], cols: ['id', 'category_id', 'category_source', 'rule_id', 'merchant_override', 'is_business', 'note'] },
  { table: 'rules', key: ['id'], ignore: ['hits'] },
  { table: 'budgets', key: ['category_id'] },
  { table: 'goals', key: ['id'] },
  { table: 'goal_contributions', key: ['id'] },
  { table: 'owed', key: ['id'] },
  { table: 'owed_payments', key: ['id'] },
  { table: 'holdings', key: ['id'] },
  { table: 'holding_lots', key: ['id'] },
  { table: 'manual_assets', key: ['id'] },
  { table: 'manual_snapshots', key: ['asset_id', 'date'] },
  { table: 'loan_inputs', key: ['account_id'] },
  { table: 'tax_tags', key: ['transaction_id'] },
  { table: 'tax_assessments', key: ['fy'], ignore: ['updated_at'] },
  { table: 'settings', key: ['key'], where: "key LIKE 'tax_estimate_inputs:%'" },
  // A manual account's daily rows (lib/manual.mjs), rebuilt on every write to it; after accounts so undo removes them first.
  { table: 'balance_snapshots', key: ['account_id', 'date'], where: "account_id LIKE 'man\\_%' ESCAPE '\\'" },
];
const SPEC = new Map(TRACKED.map((s, i) => [s.table, { ...s, order: i }]));

const hash = (token) => createHash('sha256').update(token).digest('hex');
const newToken = (prefix) => `${prefix}_${randomBytes(32).toString('base64url')}`;
const keyOf = (spec, row) => JSON.stringify(spec.key.map((k) => row[k]));
const pick = (row, cols) => Object.fromEntries(cols.map((c) => [c, row[c]]));

const colsCache = new WeakMap();
function colsOf(db, spec) {
  let m = colsCache.get(db);
  if (!m) colsCache.set(db, (m = new Map()));
  if (!m.has(spec.table)) m.set(spec.table, spec.cols ?? db.prepare(`PRAGMA table_info(${spec.table})`).all().map((c) => c.name));
  return m.get(spec.table);
}
const compared = (db, spec) => colsOf(db, spec).filter((c) => !spec.ignore?.includes(c));
const same = (db, spec, x, y) => (x == null || y == null ? x == null && y == null
  : compared(db, spec).every((c) => x[c] === y[c]));

function readAll(db) {
  const out = new Map();
  for (const spec of TRACKED) {
    const cols = colsOf(db, spec);
    const rows = db.prepare(`SELECT ${cols.join(', ')} FROM ${spec.table}${spec.where ? ` WHERE ${spec.where}` : ''}`).all();
    out.set(spec.table, new Map(rows.map((r) => [keyOf(spec, r), r])));
  }
  return out;
}

function diff(db, before, after) {
  const changes = [];
  for (const spec of TRACKED) {
    const b = before.get(spec.table);
    const a = after.get(spec.table);
    for (const k of new Set([...b.keys(), ...a.keys()])) {
      const x = b.get(k) ?? null;
      const y = a.get(k) ?? null;
      if (!same(db, spec, x, y)) changes.push({ t: spec.table, b: x && { ...x }, a: y && { ...y } });
    }
  }
  return changes;
}

export const countsOf = (changes) => {
  const n = {};
  for (const c of changes) n[c.t] = (n[c.t] ?? 0) + 1;
  return n;
};

// Runs fn in one transaction and returns { out, changes, counts, kept }.
// keep(counts, out) decides whether it stands: false rolls everything back (a dry
// run). onKeep runs inside the transaction just before it commits.
export function capture(db, fn, { keep = () => true, onKeep = null } = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const before = readAll(db);
    const out = fn();
    const changes = diff(db, before, readAll(db));
    const counts = countsOf(changes);
    const kept = keep(counts, out);
    if (kept) onKeep?.({ out, changes, counts });
    db.exec(kept ? 'COMMIT' : 'ROLLBACK');
    return { out, changes, counts, kept };
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}

// undo

const iso = (ms) => new Date(ms).toISOString();

function prune(db, now) {
  const cut = iso(now - PRUNE_MS);
  db.prepare('DELETE FROM undo_log WHERE expires_at < ?').run(cut);
  db.prepare('DELETE FROM confirm_tokens WHERE expires_at < ?').run(cut);
}

export function saveUndo(db, { op, summary, changes, now }) {
  if (!changes.length) return null;
  prune(db, now);
  const token = newToken('u');
  const expires_at = iso(now + UNDO_MS);
  db.prepare('INSERT INTO undo_log (token_hash, op, summary, changes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(hash(token), op, summary, JSON.stringify(changes), iso(now), expires_at);
  return { token, expires_at };
}

// Is this undo token still good (exists, unused, inside its 24 hours)?
export function undoOpen(db, token, { now }) {
  const row = typeof token === 'string' ? db.prepare('SELECT used_at, expires_at FROM undo_log WHERE token_hash = ?').get(hash(token)) : null;
  return !!row && !row.used_at && Date.parse(row.expires_at) > now;
}

function where(spec) { return spec.key.map((k) => `${k} = ?`).join(' AND '); }
const current = (db, spec, row) => db.prepare(`SELECT ${colsOf(db, spec).join(', ')} FROM ${spec.table} WHERE ${where(spec)}`).get(...spec.key.map((k) => row[k])) ?? null;

// Child rows that would go with a row undo deletes (ON DELETE CASCADE or SET
// NULL), beyond the ones this same undo removes: rows added since.
function laterChildren(db, change, changes) {
  const parent = change.t;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const child of tables) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${child})`).all()) {
      if (fk.table !== parent || !fk.to) continue;
      const v = change.a[fk.to];
      const n = db.prepare(`SELECT count(*) n FROM ${child} WHERE ${fk.from} = ?`).get(v).n;
      const planned = changes.filter((c) => c.t === child && c.b == null && c.a?.[fk.from] === v).length;
      if (n > planned) return child;
    }
  }
  return null;
}

// Puts the "before" side of every change back, inside one transaction, after
// checking each row is still what the write left. Returns the undo row.
export function applyUndo(db, token, { now }) {
  const row = typeof token === 'string' ? db.prepare('SELECT * FROM undo_log WHERE token_hash = ?').get(hash(token)) : null;
  if (!row) throw notFound('no such undo token');
  if (row.used_at) throw new HttpError(410, 'this undo has already been used');
  if (Date.parse(row.expires_at) <= now) throw new HttpError(410, 'this undo has expired (undo lasts 24 hours)');
  const changes = JSON.parse(row.changes);
  return tx(db, () => {
    for (const c of changes) {
      const spec = SPEC.get(c.t);
      if (!same(db, spec, current(db, spec, c.a ?? c.b), c.a)) throw new HttpError(409, `cannot undo: ${c.t.replace(/_/g, ' ')} changed since, so undoing would overwrite a later edit`);
      if (c.b == null) {
        const child = laterChildren(db, c, changes);
        if (child) throw new HttpError(409, `cannot undo: ${child.replace(/_/g, ' ')} were added since, and undoing would remove them too`);
      }
    }
    const sorted = changes.map((c) => ({ ...c, spec: SPEC.get(c.t) })).sort((x, y) => x.spec.order - y.spec.order);
    try {
      for (const c of sorted.filter((x) => x.b == null).reverse()) {
        db.prepare(`DELETE FROM ${c.t} WHERE ${where(c.spec)}`).run(...c.spec.key.map((k) => c.a[k]));
      }
      for (const c of sorted.filter((x) => x.b != null)) {
        const cols = colsOf(db, c.spec);
        if (c.a != null) {
          const set = cols.filter((k) => !c.spec.key.includes(k));
          db.prepare(`UPDATE ${c.t} SET ${set.map((k) => `${k} = ?`).join(', ')} WHERE ${where(c.spec)}`).run(...set.map((k) => c.b[k]), ...c.spec.key.map((k) => c.b[k]));
        } else {
          db.prepare(`INSERT INTO ${c.t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => c.b[k]));
        }
      }
    } catch (e) {
      if (/constraint/i.test(e?.message ?? '')) throw new HttpError(409, `cannot undo: something added since now clashes with it (${e.message.replace(/^.*?: /, '')})`);
      throw e;
    }
    if (!db.prepare('UPDATE undo_log SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(iso(now), row.token_hash).changes) {
      throw new HttpError(410, 'this undo has already been used');
    }
    return { op: row.op, summary: row.summary, counts: countsOf(changes) };
  });
}

// confirm

export function saveConfirm(db, { op, params, summary, counts, now }) {
  prune(db, now);
  const token = newToken('c');
  const expires_at = iso(now + CONFIRM_MS);
  db.prepare('INSERT INTO confirm_tokens (token_hash, op, params, summary, counts, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(hash(token), op, JSON.stringify(params), summary, JSON.stringify(counts), iso(now), expires_at);
  return { token, expires_at };
}

// Spends the token (one attempt per token, whatever happens next) and returns
// what it was issued for. `claimed` is the op the caller thinks it confirms.
export function takeConfirm(db, token, { now, claimed = null }) {
  const row = typeof token === 'string' ? db.prepare('SELECT * FROM confirm_tokens WHERE token_hash = ?').get(hash(token)) : null;
  if (!row) throw notFound('no such confirm token');
  if (row.used_at) throw new HttpError(410, 'this confirm has already been used');
  if (Date.parse(row.expires_at) <= now) throw new HttpError(410, 'this confirm has expired (confirm within 10 minutes), ask again for a fresh one');
  if (!db.prepare('UPDATE confirm_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(iso(now), row.token_hash).changes) {
    throw new HttpError(410, 'this confirm has already been used');
  }
  if (claimed != null && claimed !== row.op) throw new HttpError(409, `this confirm token is for ${row.op}, not ${String(claimed).slice(0, 40)}; it has been cancelled`);
  return { op: row.op, params: JSON.parse(row.params), counts: JSON.parse(row.counts), summary: row.summary };
}

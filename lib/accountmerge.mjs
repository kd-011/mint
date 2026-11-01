// One real bank account can reach Mint under two Redbark ids: a bank re-linked
// as a second connection issues fresh ids for the same accounts (and often a new
// display name), and the old ids stay in the list. A rename on its own keeps the
// id and is just an update (ingest.mjs). This folds the older row into the newer
// one so there is one row per real account.
//
// Nothing here runs by itself: a person runs scripts/merge-accounts.mjs, reads
// the dry run, then applies it. Matched on institution + masked number +
// currency + type, never on the name, and only across different connections: two
// accounts on one connection are two accounts. The retired row is never deleted:
// it is marked merged_into and status 'gone' and its transactions move onto the
// survivor. A transaction that is the same entry as one the survivor already
// holds (same date, amount and description) is not moved and not deleted: it
// stays on the retired row, which the spend, income, tax and transaction list
// queries skip (a.merged_into IS NULL). Its annotations (manual category, note,
// business flag) are copied to the surviving copy where that is empty, and its
// receipts, tax tag, owed payments and transfer pairs are re-pointed to it. Every change is recorded as before
// values, so undoMerge puts it all back, and an undone pair is never merged again.
import { tx } from './db.mjs';

const IDENT = /^\w+$/;
const ROLLBACK = Symbol('dry run');
const norm = (s) => String(s ?? '').trim().toLowerCase();
const keyOf = (a) => [norm(a.institution), a.number_masked, String(a.currency).toUpperCase(), a.type].join('|');
const txKey = (t) => `${t.date}|${t.amount}|${norm(t.description)}`;

function candidates(db) {
  return db.prepare(`SELECT a.*, c.status AS conn_status, (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS tx_count
    FROM accounts a LEFT JOIN connections c ON c.id = a.connection_id
    WHERE a.manual = 0 AND a.merged_into IS NULL AND a.number_masked IS NOT NULL`).all().filter((a) => /\d{3,}/.test(a.number_masked));
}

// The pairs to fold, as { survivor, loser } rows, plus groups left alone and why.
export function findDuplicates(db) {
  const vetoed = new Set(db.prepare('SELECT from_id, into_id FROM account_merges WHERE undone_at IS NOT NULL').all()
    .flatMap((m) => [`${m.from_id}>${m.into_id}`, `${m.into_id}>${m.from_id}`]));
  const groups = new Map();
  for (const a of candidates(db)) {
    const k = keyOf(a);
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const pairs = [];
  const skipped = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const live = rows.filter((a) => a.status !== 'gone');
    if (!live.length) continue;
    const conns = live.map((a) => a.connection_id).filter(Boolean);
    if (new Set(conns).size < conns.length) {
      skipped.push({ ids: rows.map((a) => a.id), reason: 'two live accounts on one connection, so not the same account' });
      continue;
    }
    // The link that is still in use wins: an active connection, then the newest row, then the fuller history.
    const rank = (a) => [a.conn_status === 'active' ? 1 : 0, a.created_at, a.tx_count];
    const survivor = [...live].sort((x, y) => {
      const [a, b] = [rank(x), rank(y)];
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? 1 : -1;
      return x.id < y.id ? -1 : 1;
    })[0];
    for (const loser of rows) {
      if (loser.id !== survivor.id && !vetoed.has(`${loser.id}>${survivor.id}`)) pairs.push({ survivor, loser });
    }
  }
  return { pairs, skipped };
}

// Every (table, column) that points at a transaction id, read from the schema.
function refsToTransactions(db) {
  const out = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    if (!IDENT.test(name)) continue;
    for (const f of db.prepare(`PRAGMA foreign_key_list(${name})`).all()) {
      if (f.table === 'transactions' && IDENT.test(f.from)) out.push({ table: name, col: f.from });
    }
  }
  return out;
}

function mergePair(db, { survivor, loser }, at, refs) {
  const ops = [];
  const sum = { moved: 0, duplicates_left: 0, annotations_carried: 0, links_repointed: 0, links_blocked: 0, snapshots_moved: 0, repointed: 0 };

  // Sets table.col = value on every row matching where, recording the before values.
  function setWhere(table, col, where, args, value) {
    const by = new Map();
    for (const { r, v } of db.prepare(`SELECT rowid r, ${col} v FROM ${table} WHERE ${where}`).all(...args)) {
      if (v === value) continue;
      by.set(v, [...(by.get(v) ?? []), r]);
    }
    const upd = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`);
    let n = 0;
    for (const [old, ids] of by) {
      for (const id of ids) { upd.run(value, id); n += 1; }
      const last = ops[ops.length - 1];
      if (last && last.t === table && last.c === col && last.old === old) last.ids.push(...ids);
      else ops.push({ t: table, c: col, old, ids });
    }
    return n;
  }

  // Transactions: the same entry as a survivor row (matched once each) stays put, the rest move.
  // What the owner attached to the retired copy follows to the surviving one, so the copy that shows is the annotated one.
  const have = new Map();
  for (const t of db.prepare('SELECT id, date, amount, description FROM transactions WHERE account_id = ?').all(survivor.id)) {
    have.set(txKey(t), [...(have.get(txKey(t)) ?? []), t.id]);
  }
  const moving = [];
  for (const t of db.prepare('SELECT * FROM transactions WHERE account_id = ? ORDER BY date, id').all(loser.id)) {
    const twin = have.get(txKey(t))?.shift();
    if (!twin) { moving.push(t.id); continue; }
    sum.duplicates_left += 1;
    carryAnnotations(t, twin);
  }
  function carryAnnotations(t, twinId) {
    const tw = db.prepare('SELECT category_id, category_source, is_business, note FROM transactions WHERE id = ?').get(twinId);
    let n = 0;
    // A manual category beats anything but another manual one; any category fills an empty one.
    if (t.category_id != null && (t.category_source === 'manual' ? tw.category_source !== 'manual' : tw.category_id == null)) {
      n += setWhere('transactions', 'category_id', 'id = ?', [twinId], t.category_id);
      n += setWhere('transactions', 'category_source', 'id = ?', [twinId], t.category_source);
    }
    if (tw.is_business == null && t.is_business != null) n += setWhere('transactions', 'is_business', 'id = ?', [twinId], t.is_business);
    if (tw.note == null && t.note != null) n += setWhere('transactions', 'note', 'id = ?', [twinId], t.note);
    // Receipts, tax tags, owed payments and transfer pairs: re-pointed one by one, a unique clash leaves that link where it was.
    for (const { table, col } of refs) {
      for (const { r } of db.prepare(`SELECT rowid r FROM ${table} WHERE ${col} = ?`).all(t.id)) {
        try { sum.links_repointed += tx(db, () => setWhere(table, col, 'rowid = ?', [r], twinId)); } catch { sum.links_blocked += 1; }
      }
    }
    sum.annotations_carried += n;
  }
  for (const id of moving) setWhere('transactions', 'account_id', 'id = ?', [id], survivor.id);
  sum.moved = moving.length;

  // Balance history the survivor has no row for (dates before the re-link) moves too.
  sum.snapshots_moved = setWhere('balance_snapshots', 'account_id',
    'account_id = ? AND date NOT IN (SELECT date FROM balance_snapshots WHERE account_id = ?)', [loser.id, survivor.id], survivor.id);

  for (const table of ['rules', 'income_sources', 'pay_plan', 'goals']) {
    sum.repointed += setWhere(table, 'account_id', 'account_id = ?', [loser.id], survivor.id);
  }
  if (!db.prepare('SELECT 1 FROM loan_inputs WHERE account_id = ?').get(survivor.id)) {
    sum.repointed += setWhere('loan_inputs', 'account_id', 'account_id = ?', [loser.id], survivor.id);
  }

  // the owner's own settings on the old row carry over; the survivor keeps what it already has.
  if (survivor.nickname == null && loser.nickname != null) setWhere('accounts', 'nickname', 'id = ?', [survivor.id], loser.nickname);
  if (survivor.spendable == null && loser.spendable != null) setWhere('accounts', 'spendable', 'id = ?', [survivor.id], loser.spendable);
  if (survivor.type_override == null && loser.type_override != null) {
    setWhere('accounts', 'type_override', 'id = ?', [survivor.id], loser.type_override);
    setWhere('accounts', 'type', 'id = ?', [survivor.id], loser.type_override);
  }
  if (loser.is_business && !survivor.is_business) setWhere('accounts', 'is_business', 'id = ?', [survivor.id], 1);
  if (loser.hidden && !survivor.hidden) setWhere('accounts', 'hidden', 'id = ?', [survivor.id], 1);
  if (loser.sort < survivor.sort) setWhere('accounts', 'sort', 'id = ?', [survivor.id], loser.sort);
  const span = db.prepare('SELECT MIN(date) lo, MAX(date) hi FROM transactions WHERE account_id = ?').get(survivor.id);
  setWhere('accounts', 'earliest_date', 'id = ?', [survivor.id], span.lo);
  setWhere('accounts', 'latest_date', 'id = ?', [survivor.id], span.hi);
  setWhere('accounts', 'merged_into', 'id = ?', [loser.id], survivor.id);
  setWhere('accounts', 'status', 'id = ?', [loser.id], 'gone');

  const summary = {
    from: loser.id, into: survivor.id, institution: survivor.institution, number: survivor.number_masked,
    from_name: loser.name, into_name: survivor.name, from_tx: loser.tx_count, into_tx: survivor.tx_count, ...sum,
  };
  db.prepare('INSERT INTO account_merges (from_id, into_id, merged_at, summary, ops) VALUES (?, ?, ?, ?, ?)')
    .run(loser.id, survivor.id, at, JSON.stringify(summary), JSON.stringify(ops));
  return summary;
}

// Folds every duplicate pair, in one transaction (all or nothing). dryRun does the
// same work, so the counts are exactly what an apply would do, then rolls it back.
export function mergeDuplicateAccounts(db, { now = new Date().toISOString(), dryRun = false } = {}) {
  const { pairs, skipped } = findDuplicates(db);
  if (!pairs.length) return { merges: [], skipped };
  const refs = refsToTransactions(db);
  const merges = [];
  try {
    tx(db, () => {
      for (const p of pairs) merges.push(mergePair(db, p, now, refs));
      if (dryRun) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return { merges, skipped };
}

// Puts a merge back: every changed value goes back to its before value, and the pair is never merged again.
export function undoMerge(db, id, { now = new Date().toISOString() } = {}) {
  const m = db.prepare('SELECT * FROM account_merges WHERE id = ?').get(id);
  if (!m) throw new Error(`no merge ${id}`);
  if (m.undone_at) throw new Error(`merge ${id} was already undone`);
  tx(db, () => {
    for (const op of JSON.parse(m.ops).reverse()) {
      if (!IDENT.test(op.t) || !IDENT.test(op.c)) throw new Error('bad merge record');
      const upd = db.prepare(`UPDATE ${op.t} SET ${op.c} = ? WHERE rowid = ?`);
      for (const r of op.ids) upd.run(op.old, r);
    }
    db.prepare('UPDATE account_merges SET undone_at = ? WHERE id = ?').run(now, id);
  });
  return JSON.parse(m.summary);
}

// Income streams. Every positive row that counts (not a transfer leg, not in a
// transfer or spending category, so refunds stay refunds) is one of:
//   salary         the pay that starts a pay cycle (lib/cycles.mjs)
//   regular        a recurring payer, like a fortnightly family payment
//   reimbursement  a friend paying the owner back: nets off spend, never income
//   other          gifts, interest, cashback, anything else: shown, not income
// Streams are rows in income_sources (first match by priority wins, nothing
// matching is other) and the owner can edit them or pin a row by hand. They are
// seeded once from the book: SALARY/WAGES deposits, the same payer paying the
// same amount about a fortnight apart, and small person-to-person credits.
import { tx, getSetting, setSetting } from './db.mjs';
import { bad, notFound } from './errors.mjs';
import { LINKED, COUNTS, BUSINESS, FROM, KIND } from './spend.mjs';
import { addDays, daysBetween, isIsoDate, zoneDate } from './dates.mjs';
import { anchorSource, paydays, listCycles, DEFAULT_CADENCE, MERGE_DAYS } from './cycles.mjs';
import { ownerTest } from './owner.mjs';
import { LIVE } from './live.mjs';

export const KINDS = ['salary', 'regular', 'reimbursement', 'other'];
const MATCHES = ['contains', 'starts', 'exact', 'regex', 'person'];
const FIELDS = ['description', 'merchant'];
export const REIMBURSE_MAX = 50000; // person-to-person credits up to $500 are friends paying back
const REGULAR_MIN = 50000; // a regular payer pays at least $500
const REGULAR_GAP = [10, 18];
const REGULAR_RECENT_DAYS = 45;
const SOURCE_COLS = 'id, name, kind, field, match, pattern, account_id, amount_min, amount_max, cadence_days, category_id, anchor, priority, source, created_at, updated_at';

// The rows the income pass looks at. rc is the row's own category.
const UNIVERSE = `SELECT t.id, t.account_id, a.type account_type, t.date, t.amount, t.description, COALESCE(t.merchant_override, t.merchant) merchant,
    COALESCE(t.is_business, a.is_business) business, t.income_source_id, t.income_kind, t.offset_category_id, t.income_manual
  FROM transactions t JOIN accounts a ON a.id = t.account_id AND a.merged_into IS NULL LEFT JOIN categories rc ON rc.id = t.category_id
  WHERE t.amount > 0 AND NOT ${LINKED} AND COALESCE(rc.kind, 'income') = 'income'`;

const TITLE = /^(MR|MRS|MS|MISS|DR|MSTR)\s+/i;
const NOT_PERSON = /\b(INTEREST|SALARY|WAGES|ROSTER|PAY|PAYMENTS?|TRANSFERS?|REFUND|CASH ?BACK|REVERSAL|BALANCE|DEPOSIT|REBATE|BONUS|ADJUSTMENT|CREDIT|DIVIDEND|ONLINE|EFTPOS|VISA|MASTERCARD|PAYPAL|ATM|FEES?|CHARGES?|CHRGS|ACCOUNT|BANK|PTY|LTD|ATO|CENTRELINK|MEDICARE|CONTRIBUTION|DRAWDOWN|LOAN)\b/i;
const GIFT = /(birthday|bday|b'day|gift|xmas|christmas|wedding|congrat|present)/i;

// "ALEX SAMPLEPERSONdinner", "MRS A PERSON", "Lachlan Lewis": a name, no
// digits up front, none of the words banks use for their own credits.
export function looksLikePerson(desc) {
  const s = String(desc ?? '').trim();
  if (!s || /\d/.test(s.slice(0, 24)) || NOT_PERSON.test(s)) return false;
  const words = s.replace(TITLE, '').split(/\s+/);
  return words.length >= 2 && words.slice(0, 2).every((w) => /^[A-Za-z][A-Za-z'.&-]*$/.test(w));
}

// What a reimbursement pays back, from the note a friend leaves.
const HINTS = [
  [/rent(\s|\+|$)|\bbond\b/i, 'Rent'],
  [/(thailand|bali|japan|trip|holiday|flight|airbnb|hotel|accom|travel)/i, 'Travel'],
  [/(dinner|lunch|brunch|breakfast|food|coffee|drinks|pizza|sushi|meal|restaurant|chinese|bbq|kebab|burger|ramen)/i, 'Eating out'],
  [/(grocer|groceries)/i, 'Groceries'],
  [/(padel|escape|movie|cinema|ticket|concert|bowling|golf)/i, 'Entertainment'],
  [/(petrol|fuel)/i, 'Fuel'],
  [/(uber|taxi)/i, 'Rideshare and taxis'],
];

function compile(s, isOwner = () => false) {
  const p = (s.pattern ?? '').toLowerCase();
  let re = null;
  if (s.match === 'regex') { try { re = new RegExp(s.pattern, 'i'); } catch { return () => false; } }
  return (r) => {
    if (s.account_id && r.account_id !== s.account_id) return false;
    if (s.amount_min != null && r.amount < s.amount_min) return false;
    if (s.amount_max != null && r.amount > s.amount_max) return false;
    const text = String((s.field === 'merchant' ? r.merchant : r.description) ?? '').trim();
    if (s.match === 'person') {
      return !r.business && r.account_type !== 'credit-card' && r.account_type !== 'loan'
        && looksLikePerson(text) && !GIFT.test(text) && !isOwner(text) && (!p || text.toLowerCase().includes(p));
    }
    if (re) return re.test(text);
    const t = text.toLowerCase();
    return s.match === 'contains' ? t.includes(p) : s.match === 'starts' ? t.startsWith(p) : t === p;
  };
}

const view = (s) => (s ? { ...s, anchor: !!s.anchor } : s);
const loadSources = (db) => {
  const isOwner = ownerTest(db);
  return db.prepare(`SELECT ${SOURCE_COLS} FROM income_sources ORDER BY priority, id`).all().map((s) => ({ ...s, test: compile(s, isOwner) }));
};

export function listSources(db) {
  return db.prepare(`SELECT ${SOURCE_COLS} FROM income_sources ORDER BY priority, id`).all().map(view);
}

const getSource = (db, id) => {
  const s = Number.isInteger(id) ? db.prepare(`SELECT ${SOURCE_COLS} FROM income_sources WHERE id = ?`).get(id) : null;
  if (!s) throw notFound('no such income stream');
  return s;
};

function validate(db, body, cur = null) {
  if (!body || typeof body !== 'object') throw bad('income stream must be an object');
  const v = { ...(cur ?? { field: 'description', match: 'contains', pattern: '', account_id: null, amount_min: null, amount_max: null, cadence_days: null, category_id: null, anchor: 0, priority: 100 }) };
  if (!cur || 'name' in body) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 60) throw bad('name must be 1 to 60 characters');
    v.name = body.name.trim();
  }
  if (!cur || 'kind' in body) {
    if (!KINDS.includes(body.kind)) throw bad(`kind must be one of ${KINDS.join(', ')}`);
    v.kind = body.kind;
  }
  if ('field' in body) { if (!FIELDS.includes(body.field)) throw bad(`field must be one of ${FIELDS.join(', ')}`); v.field = body.field; }
  if ('match' in body) { if (!MATCHES.includes(body.match)) throw bad(`match must be one of ${MATCHES.join(', ')}`); v.match = body.match; }
  if ('pattern' in body) {
    if (typeof body.pattern !== 'string' || body.pattern.trim().length > 200) throw bad('pattern must be up to 200 characters');
    v.pattern = body.pattern.trim();
  }
  if (v.match !== 'person' && !v.pattern) throw bad('pattern is required: the text to match, like SALARY/WAGES');
  if (v.match === 'regex') {
    try { new RegExp(v.pattern, 'i'); } catch (e) { throw bad(`pattern is not a valid regex: ${e.message}`); }
    if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(v.pattern)) throw bad('pattern nests repeats, like (a+)+, which can hang matching');
  }
  if ('account_id' in body) {
    if (body.account_id !== null && (typeof body.account_id !== 'string' || !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(body.account_id))) throw bad('no such account');
    v.account_id = body.account_id;
  }
  for (const k of ['amount_min', 'amount_max']) {
    if (!(k in body)) continue;
    if (body[k] !== null && (!Number.isInteger(body[k]) || Math.abs(body[k]) > 1e12)) throw bad(`${k} must be whole cents or null`);
    v[k] = body[k];
  }
  if (v.amount_min != null && v.amount_max != null && v.amount_min > v.amount_max) throw bad('amount_min is above amount_max');
  if ('cadence_days' in body) {
    if (body.cadence_days !== null && (!Number.isInteger(body.cadence_days) || body.cadence_days < 1 || body.cadence_days > 366)) throw bad('cadence_days must be 1 to 366 or null');
    v.cadence_days = body.cadence_days;
  }
  if ('category_id' in body) {
    if (body.category_id !== null && (!Number.isInteger(body.category_id) || !db.prepare("SELECT 1 FROM categories WHERE id = ? AND kind = 'expense'").get(body.category_id))) throw bad('category_id must be a spending category or null');
    v.category_id = body.category_id;
  }
  if ('anchor' in body) { if (typeof body.anchor !== 'boolean') throw bad('anchor must be true or false'); v.anchor = body.anchor ? 1 : 0; }
  if (v.anchor && v.kind !== 'salary') throw bad('only a salary stream can start the pay cycle');
  if ('priority' in body) {
    if (!Number.isInteger(body.priority) || body.priority < 1 || body.priority > 1000) throw bad('priority must be 1 to 1000');
    v.priority = body.priority;
  }
  return v;
}

const COLS = ['name', 'kind', 'field', 'match', 'pattern', 'account_id', 'amount_min', 'amount_max', 'cadence_days', 'category_id', 'anchor', 'priority'];

export function createSource(db, body, { source = 'manual' } = {}) {
  const v = validate(db, body);
  const at = new Date().toISOString();
  const id = tx(db, () => {
    if (v.anchor) db.prepare('UPDATE income_sources SET anchor = 0').run();
    return Number(db.prepare(`INSERT INTO income_sources (${COLS.join(', ')}, source, created_at, updated_at) VALUES (${COLS.map(() => '?').join(', ')}, ?, ?, ?)`)
      .run(...COLS.map((k) => v[k]), source, at, at).lastInsertRowid);
  });
  classifyIncome(db);
  return view(getSource(db, id));
}

export function updateSource(db, id, body) {
  const cur = getSource(db, id);
  const v = validate(db, body, cur);
  tx(db, () => {
    if (v.anchor && !cur.anchor) db.prepare('UPDATE income_sources SET anchor = 0').run();
    db.prepare(`UPDATE income_sources SET ${COLS.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...COLS.map((k) => v[k]), new Date().toISOString(), id);
  });
  classifyIncome(db);
  return view(getSource(db, id));
}

export function deleteSource(db, id) {
  getSource(db, id);
  tx(db, () => {
    db.prepare('DELETE FROM income_sources WHERE id = ?').run(id);
    db.prepare('UPDATE transactions SET income_source_id = NULL WHERE income_source_id = ?').run(id);
  });
  classifyIncome(db);
  return { deleted: true };
}

// What saving a stream (a new one, or an edit to stream `id`) would do to the
// book, without writing anything: the rows it claims, which of them change
// kind, and a few samples. Rows the owner pinned by hand never move, so they are
// counted apart. Same validation and matching as saving, so the two agree.
export function previewSource(db, body, { id = null, today } = {}) {
  const cur = id != null ? getSource(db, id) : null;
  const v = validate(db, body, cur);
  const isOwner = ownerTest(db);
  const rest = loadSources(db).filter((s) => s.id !== cur?.id);
  const cand = { ...v, id: cur?.id ?? -1, test: compile(v, isOwner) };
  const sources = [...rest, cand].sort((a, b) => a.priority - b.priority || a.id - b.id);
  const since = addDays(today ?? zoneDate(), -90);
  const out = { matches: 0, total: 0, last_90_days: 0, last_date: null, rows_changing: 0, pinned: 0, moves: [], samples: [] };
  const moves = new Map();
  const samples = [];
  for (const r of db.prepare(`${UNIVERSE} ORDER BY t.date DESC, t.id`).all()) {
    const winner = sources.find((s) => s.test(r));
    const mine = winner?.id === cand.id;
    const wasMine = cur != null && r.income_source_id === cur.id;
    if (!mine && !wasMine) continue;
    if (r.income_manual && r.income_kind) { if (mine || wasMine) out.pinned += 1; continue; }
    if (mine) {
      out.matches += 1;
      out.total += r.amount;
      if (r.date >= since) out.last_90_days += r.amount;
      if (!out.last_date || r.date > out.last_date) out.last_date = r.date;
    }
    const to = mine ? cand.kind : winner?.kind ?? 'other';
    const from = r.income_kind ?? 'other';
    if (from !== to) {
      out.rows_changing += 1;
      const m = moves.get(`${from}>${to}`) ?? { from, to, count: 0, total: 0 };
      m.count += 1;
      m.total += r.amount;
      moves.set(`${from}>${to}`, m);
    }
    if (mine && samples.length < 5) samples.push({ date: r.date, amount: r.amount, from, to });
  }
  out.moves = [...moves.values()].sort((a, b) => b.total - a.total);
  out.samples = samples;
  return out;
}

// the owner's pick for one row: a stream, a bare kind, or back to automatic.
export function setTransactionIncome(db, txId, body = {}) {
  const row = typeof txId === 'string' ? db.prepare('SELECT id, amount FROM transactions WHERE id = ?').get(txId) : null;
  if (!row) throw notFound('no such transaction');
  if (body.auto === true) {
    db.prepare('UPDATE transactions SET income_manual = 0 WHERE id = ?').run(txId);
  } else {
    if (row.amount <= 0) throw bad('only money in has an income stream');
    const own = db.prepare('SELECT c.kind FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?').get(txId).kind;
    if (own === 'expense' || own === 'transfer') throw bad(`this row is filed under a ${own === 'expense' ? 'spending category, so it already counts as a refund' : 'transfer category'}; change its category first`);
    let sourceId = null;
    let kind = body.kind;
    if (body.source_id != null) {
      const s = getSource(db, body.source_id);
      sourceId = s.id;
      kind = s.kind;
    } else if (!KINDS.includes(kind)) throw bad(`give a source_id, a kind (${KINDS.join(', ')}) or auto: true`);
    if (kind === 'salary' && sourceId == null) sourceId = anchorSource(db)?.id ?? null;
    db.prepare('UPDATE transactions SET income_manual = 1, income_kind = ?, income_source_id = ? WHERE id = ?').run(kind, sourceId, txId);
  }
  classifyIncome(db);
  return db.prepare('SELECT id, income_kind, income_source_id, offset_category_id, income_manual FROM transactions WHERE id = ?').get(txId);
}

function hintCategory(text, catIds) {
  for (const [re, name] of HINTS) if (re.test(text) && catIds.has(name)) return catIds.get(name);
  return null;
}

// Decide every row's stream. Cheap enough to run over the whole book after every sync.
export function classifyIncome(db) {
  const sources = loadSources(db);
  const byId = new Map(sources.map((s) => [s.id, s]));
  const catIds = new Map(db.prepare("SELECT id, name FROM categories WHERE kind = 'expense'").all().map((c) => [c.name, c.id]));
  const general = catIds.get('Reimbursements') ?? null;
  const rows = db.prepare(UNIVERSE).all();
  const seen = new Set();
  const counts = { scanned: rows.length, changed: 0, salary: 0, regular: 0, reimbursement: 0, other: 0 };
  const upd = db.prepare('UPDATE transactions SET income_source_id = ?, income_kind = ?, offset_category_id = ? WHERE id = ?');
  tx(db, () => {
    for (const r of rows) {
      seen.add(r.id);
      let src = null;
      let kind;
      if (r.income_manual && r.income_kind) {
        src = r.income_source_id != null ? byId.get(r.income_source_id) ?? null : null;
        kind = src?.kind ?? r.income_kind;
      } else {
        src = sources.find((s) => s.test(r)) ?? null;
        kind = src?.kind ?? 'other';
      }
      const offset = kind === 'reimbursement' ? (src?.category_id ?? hintCategory(r.description, catIds) ?? general) : null;
      const sourceId = src?.id ?? null;
      counts[kind] += 1;
      if (r.income_kind !== kind || r.income_source_id !== sourceId || r.offset_category_id !== offset) {
        upd.run(sourceId, kind, offset, r.id);
        counts.changed += 1;
      }
    }
    // A row filed under spending or a transfer category is no longer money in
    // (the owner's newer pick wins, his income pick goes). A row that is now one leg
    // of a linked transfer drops out of every total anyway, so a manual income
    // pick on it is kept for the day the link is rejected.
    const clear = db.prepare('UPDATE transactions SET income_source_id = NULL, income_kind = NULL, offset_category_id = NULL, income_manual = 0 WHERE id = ?');
    for (const r of db.prepare(`SELECT t.id, t.income_manual, rc.kind own FROM transactions t LEFT JOIN categories rc ON rc.id = t.category_id
        WHERE t.income_kind IS NOT NULL AND ${LIVE()}`).all()) {
      if (seen.has(r.id)) continue;
      if (r.income_manual && r.own !== 'expense' && r.own !== 'transfer') continue;
      clear.run(r.id);
      counts.changed += 1;
    }
  });
  return counts;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const snapCadence = (gap) => (gap == null ? DEFAULT_CADENCE : gap <= 9 ? 7 : gap <= 20 ? 14 : gap <= 45 ? 30 : gap);
const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const payerKey = (d) => d.toUpperCase().replace(/\d+/g, ' ').replace(/[^A-Z&' ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 5).join(' ');

function commonPrefix(list) {
  let p = list[0] ?? '';
  for (const s of list) while (!s.startsWith(p)) p = p.slice(0, -1);
  p = p.trimEnd();
  // Cut back to a whole word unless every description is exactly the prefix.
  if (!list.every((s) => s.trim() === p)) p = p.replace(/\s+\S*$/, '').trimEnd() || p;
  return p;
}

// Seed the streams once, the first time a salary is in the book.
export function seedIncomeSources(db, { today }) {
  if (getSetting(db, 'income_seeded')) return { seeded: false };
  const rows = db.prepare(`${UNIVERSE} ORDER BY t.date, t.id`).all();
  const salary = rows.filter((r) => /^SALARY\/WAGES\b/i.test(r.description.trim()));
  if (!salary.length) return { seeded: false, reason: 'no salary deposits yet' };
  // Any account: the pay account has moved before, and old salary still counts.
  const days = [];
  for (const r of salary) {
    if (!days.length || daysBetween(days.at(-1), r.date) > MERGE_DAYS) days.push(r.date);
  }
  const gaps = days.slice(1).map((d, i) => daysBetween(days[i], d)).slice(-8);
  const at = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO income_sources (name, kind, field, match, pattern, account_id, amount_min, amount_max, cadence_days, category_id, anchor, priority, source, created_at, updated_at)
    VALUES (?, ?, 'description', ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'seed', ?, ?)`);
  const made = [];
  tx(db, () => {
    ins.run('Salary', 'salary', 'starts', 'SALARY/WAGES', null, 1, null, snapCadence(median(gaps)), 1, 10, at, at);
    made.push('salary');
    // Regular payers: same payer, same account, near-identical amounts, about a fortnight apart, still paying.
    const groups = new Map();
    for (const r of rows) {
      if (r.amount < REGULAR_MIN || /^SALARY\/WAGES\b/i.test(r.description.trim()) || r.business) continue;
      const k = `${r.account_id}|${payerKey(r.description)}`;
      (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const run = list.slice(-6);
      const runGaps = run.slice(1).map((r, i) => daysBetween(run[i].date, r.date));
      const typical = median(run.map((r) => r.amount));
      if (!runGaps.every((g) => g >= REGULAR_GAP[0] && g <= REGULAR_GAP[1])) continue;
      if (!run.every((r) => Math.abs(r.amount - typical) <= typical * 0.02)) continue;
      if (daysBetween(run.at(-1).date, today) > REGULAR_RECENT_DAYS) continue;
      const pattern = commonPrefix(run.map((r) => r.description.trim()));
      if (pattern.length < 6) continue;
      const name = titleCase(pattern.replace(/^PAYMENT FROM\s+/i, '').replace(/\s*&.*$/, '')).slice(0, 60) || 'Regular payer';
      // Its own rhythm (17 days is not 14), so the next one is projected where it will land.
      ins.run(name, 'regular', 'starts', pattern, run[0].account_id, Math.round(typical * 0.9), Math.round(typical * 1.1), median(runGaps), 0, 20, at, at);
      made.push('regular');
    }
    ins.run('Friends paying back', 'reimbursement', 'person', '', null, null, REIMBURSE_MAX, null, 0, 200, at, at);
    made.push('reimbursement');
    setSetting(db, 'income_seeded', at);
  });
  return { seeded: true, made };
}

export function runIncome(db, { today }) {
  const seeded = seedIncomeSources(db, { today });
  return { seeded, ...classifyIncome(db) };
}

// ---------- read models ----------

const sumBy = (rows, pred) => rows.reduce((s, r) => s + (pred(r) ? r.amount : 0), 0);

export function incomeRows(db, from, to) {
  return db.prepare(`SELECT t.id, t.date, t.amount, t.income_kind kind, t.income_source_id source_id FROM transactions t JOIN accounts a ON a.id = t.account_id AND a.merged_into IS NULL
    WHERE t.income_kind IS NOT NULL AND COALESCE(t.is_business, a.is_business) = 0 AND t.date >= ? AND t.date <= ? ORDER BY t.date, t.id`).all(from, to);
}

function bucket(rows) {
  const by_source = {};
  for (const r of rows) if (r.source_id != null) by_source[r.source_id] = (by_source[r.source_id] ?? 0) + r.amount;
  const salary = sumBy(rows, (r) => r.kind === 'salary');
  const regular = sumBy(rows, (r) => r.kind === 'regular');
  return { salary, regular, income: salary + regular, reimbursed: sumBy(rows, (r) => r.kind === 'reimbursement'), other_in: sumBy(rows, (r) => r.kind === 'other'), by_source };
}

// Salary numbers: the expected pay is the median of the last four (recent
// enough to follow a pay change), the spread is over the last six.
export function salaryStats(db) {
  const pays = paydays(db);
  const last = pays.slice(-6).map((p) => p.amount);
  if (!last.length) return { count: 0, last: null, median: null, average: null, stddev: null, min: null, max: null, window: 0 };
  const avg = last.reduce((s, x) => s + x, 0) / last.length;
  const sd = Math.sqrt(last.reduce((s, x) => s + (x - avg) ** 2, 0) / last.length);
  return {
    count: pays.length, last: { date: pays.at(-1).date, amount: pays.at(-1).amount },
    median: median(last.slice(-4)), median_of: Math.min(4, last.length), average: Math.round(avg), stddev: Math.round(sd), min: Math.min(...last), max: Math.max(...last), window: last.length,
  };
}

// Regular payers in a cycle: what landed, and for the open cycle what is still
// due (projected from the last payment by the stream's cadence). A projected
// payment up to three days overdue is late and still counted; past that it is
// missed and not counted, so safe to spend never leans on money that is not coming.
export const REGULAR_GRACE_DAYS = 3;
export function regularInCycle(db, cycle, { today }) {
  const out = [];
  for (const s of db.prepare("SELECT id, name, cadence_days FROM income_sources WHERE kind = 'regular' ORDER BY priority, id").all()) {
    const rows = db.prepare("SELECT date, amount FROM transactions WHERE income_source_id = ? AND income_kind = 'regular' AND " + LIVE('transactions') + " ORDER BY date").all(s.id);
    if (!rows.length) continue;
    for (const r of rows) if (r.date >= cycle.start && r.date <= cycle.end) out.push({ source_id: s.id, name: s.name, date: r.date, amount: r.amount, status: 'received' });
    if (!cycle.open) continue;
    const cad = s.cadence_days || DEFAULT_CADENCE;
    const grace = REGULAR_GRACE_DAYS;
    const amount = median(rows.slice(-4).map((r) => r.amount));
    for (let next = addDays(rows.at(-1).date, cad); next <= cycle.end; next = addDays(next, cad)) {
      if (next < cycle.start) continue;
      const overdue = daysBetween(next, today);
      out.push({ source_id: s.id, name: s.name, date: next, amount, status: overdue > grace ? 'missed' : overdue > 0 ? 'late' : 'expected' });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Income received and expected in a cycle. The salary that opened it is in;
// regular payers are received plus still expected.
export function cycleIncome(db, cycle, { today }) {
  const rows = incomeRows(db, cycle.start, cycle.end < today ? cycle.end : today);
  const b = bucket(rows);
  const regular = regularInCycle(db, cycle, { today });
  const regularExpected = regular.filter((r) => r.status === 'expected' || r.status === 'late').reduce((s, r) => s + r.amount, 0);
  return {
    received: { salary: b.salary, regular: b.regular, total: b.income },
    expected: { salary: b.salary, regular: b.regular + regularExpected, total: b.income + regularExpected },
    regular_expected: regularExpected,
    regular,
    reimbursed: b.reimbursed,
    other_in: b.other_in,
  };
}

const nextMonth = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
};

const recentIn = (db, kind) => db.prepare(`SELECT t.id, t.date, t.amount, t.description, a.name account FROM transactions t JOIN accounts a ON a.id = t.account_id AND a.merged_into IS NULL
  WHERE t.income_kind = ? ORDER BY t.date DESC, t.id LIMIT 12`).all(kind).map((r) => ({ ...r }));

export function incomeReport(db, { today, cycles: nCycles = 8, months: nMonths = 6 } = {}) {
  if (!isIsoDate(today)) throw bad('today must be YYYY-MM-DD');
  if (!Number.isInteger(nCycles) || nCycles < 1 || nCycles > 60) throw bad('cycles must be 1 to 60');
  if (!Number.isInteger(nMonths) || nMonths < 1 || nMonths > 36) throw bad('months must be 1 to 36');
  const all = listCycles(db, { today });
  const cycles = all.slice(-nCycles);
  const sources = listSources(db);
  const spentIn = db.prepare(`SELECT COALESCE(-SUM(t.amount), 0) n FROM ${FROM} WHERE ${COUNTS} AND ${BUSINESS} = 0 AND ${KIND} = 'expense' AND t.date >= ? AND t.date <= ?`);
  const by_cycle = cycles.map((c) => ({ start: c.start, end: c.end, open: c.open, ...bucket(incomeRows(db, c.start, c.end)), spent: spentIn.get(c.start, c.end).n }));
  let m = today.slice(0, 7);
  for (let i = 1; i < nMonths; i++) { const [y, mo] = m.split('-').map(Number); m = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; }
  const by_month = [];
  for (let k = m; k <= today.slice(0, 7); k = nextMonth(k)) by_month.push({ month: k, ...bucket(incomeRows(db, `${k}-01`, addDays(`${nextMonth(k)}-01`, -1))) });
  const stats = salaryStats(db);
  const cur = all.at(-1) ?? null;
  const since = addDays(today, -90);
  const streams = sources.map((s) => {
    const agg = db.prepare(`SELECT count(*) n, COALESCE(SUM(amount), 0) total, COALESCE(SUM(CASE WHEN date >= ? THEN amount END), 0) recent, max(date) last_date
      FROM transactions WHERE income_source_id = ? AND income_kind IS NOT NULL AND ${LIVE('transactions')}`).get(since, s.id);
    return { ...s, count: agg.n, total: agg.total, last_90_days: agg.recent, last_date: agg.last_date };
  });
  const unmatched = db.prepare(`SELECT count(*) n, COALESCE(SUM(amount), 0) total FROM transactions WHERE income_kind = 'other' AND income_source_id IS NULL AND date >= ? AND ${LIVE('transactions')}`).get(since);
  return {
    as_of: today,
    streams,
    other_unmatched_90_days: { count: unmatched.n, total: unmatched.total },
    // The latest money in that counts as neither income nor a reimbursement, so a payer can be re-classified from the Income screen.
    other_recent: recentIn(db, 'other'),
    reimbursed_recent: recentIn(db, 'reimbursement'),
    salary: stats,
    next_payday: cur?.open ? { date: cur.next_payday, expected_amount: stats.median, late: cur.late, days_late: cur.days_late } : null,
    by_cycle,
    by_month,
    current: cur?.open ? { start: cur.start, end: cur.end, ...cycleIncome(db, cur, { today }) } : null,
    note: 'Cents. Income is salary plus regular payers. Reimbursements net off spend; other money in is shown, never counted as income.',
  };
}


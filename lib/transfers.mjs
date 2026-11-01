// Transfers between the owner's own accounts. Redbark has no transfer flag, so pair
// money out of one account with the same amount into another within a few
// days, scoring with provider_category as the hint. Clear pairs link
// automatically, doubtful ones wait in the review queue. A linked pair never
// counts as spend or income (see spend.mjs).
import { tx } from './db.mjs';
import { bad, notFound, HttpError } from './errors.mjs';
import { daysBetween } from './dates.mjs';
import { ownTransferTest } from './owner.mjs';

export const WINDOW_DAYS = 4;
const AUTO = 80;
const REVIEW = 35;
const STRONG = new Set(['TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS']);

// strong: the bank calls it a transfer; none: no category; conflict: the bank
// calls it a purchase or income, so it is not a transfer.
const hint = (pc) => (!pc ? 'none' : STRONG.has(String(pc).toUpperCase()) ? 'strong' : 'conflict');

// Bank reference tokens (ONLINE A1234567890 ...). Both legs carrying the same
// one is as good as a transfer flag.
const refs = (r) => new Set([...(`${r.description ?? ''} ${r.reference ?? ''}`.match(/\b[A-Z]?\d{8,}\b/g) ?? [])]);
const sharesRef = (o, i) => { const a = refs(o); return [...refs(i)].some((x) => a.has(x)); };

function score(o, i) {
  // the owner's own name on a transfer-worded leg is a transfer, whatever the bank
  // filed it as ("MS JANE ... CREDIT TO ACCOUNT" comes through as INCOME).
  let ho = o.own ? 'strong' : hint(o.provider_category);
  let hi = i.own ? 'strong' : hint(i.provider_category);
  // Money into a loan is a repayment (or the borrower's own funds at
  // settlement), whatever the bank called the debit that paid it.
  if (i.account_type === 'loan') { hi = 'strong'; if (ho === 'conflict') ho = 'none'; }
  if (ho === 'conflict' || hi === 'conflict') return 0;
  let s = 50;
  if (ho === 'strong' && hi === 'strong') s += 35;
  else if (ho === 'strong' || hi === 'strong') s += 20;
  if (i.account_type === 'loan') s += 20;
  if (sharesRef(o, i)) s += 30;
  s -= 5 * Math.abs(daysBetween(o.date, i.date));
  return s;
}

// A foreign-currency manual row (Wise) holds its AUD value at that day's rate in `amount`, so a transfer
// to or from it is two AUD figures a fee and a rate-day apart. Pair them inside this fraction of the
// larger one (Wise's fee is under 1%, the ECB rate drifts a little more), and by hand inside the wider one.
export const FX_TOLERANCE = 0.02;
export const FX_LINK_TOLERANCE = 0.05;
const fxGap = (a, b) => Math.abs(Math.abs(a) - Math.abs(b)) / Math.max(Math.abs(a), Math.abs(b));
const WISE_WORD = /\bwise\b|transferwise/i;
const wiseish = (r) => r.wise || WISE_WORD.test(`${r.description ?? ''} ${r.reference ?? ''}`);

// o is the money out, i the money in, one of them a foreign manual row. Money alone is never enough, and
// neither is the foreign side being a Wise balance (every card purchase on it is on one): the evidence has
// to be on the AUD row, Wise wording in its description or reference, or the row sitting on a Wise account
// (a Wise balance conversion). With that, the bank's transfer flag makes the pair clear; without it the
// pair goes to review. No AUD-side Wise evidence means no pair, whatever the hint.
function crossScore(o, i) {
  const aud = o.foreign ? i : o;
  if (!wiseish(aud)) return 0;
  const h = aud.own ? 'strong' : hint(aud.provider_category);
  return 50 + 20 + (h === 'strong' ? 20 : 0) - 5 * Math.abs(daysBetween(o.date, i.date)) - Math.round(fxGap(o.amount, i.amount) * 250);
}

const kindFor = (accountType) => (accountType === 'credit-card' ? 'card_repayment' : accountType === 'loan' ? 'loan_repayment' : 'transfer');

// A manual account in another currency (lib/manual.mjs) only pairs across currencies (crossScore): its
// AUD amounts come from a daily rate, so an equal AUD pair is chance, not evidence.
const CANDIDATES = `SELECT t.id, t.account_id, a.type account_type, (a.manual = 1 AND a.currency != 'AUD') foreign_ccy, a.wise_balance_id IS NOT NULL wise, t.date, t.amount, t.description, t.reference, t.provider_category, t.category_source, c.kind category_kind, t.income_manual
  FROM transactions t JOIN accounts a ON a.id = t.account_id AND a.merged_into IS NULL LEFT JOIN categories c ON c.id = t.category_id
  WHERE NOT EXISTS (SELECT 1 FROM transfers x WHERE x.out_tx = t.id OR x.in_tx = t.id)
`;

export function matchTransfers(db, { windowDays = WINDOW_DAYS } = {}) {
  // A row the owner filed by hand under a spending category is not a transfer.
  const rows = db.prepare(CANDIDATES).all().filter((r) => !(r.category_source === 'manual' && r.category_kind !== 'transfer'));
  // A row the owner pinned as income keeps the bank's word for it.
  const ownTransfer = ownTransferTest(db);
  for (const r of rows) { r.own = !r.income_manual && ownTransfer(r.description); r.foreign = !!r.foreign_ccy; r.wise = !!r.wise; }
  const ins = new Map();
  for (const r of rows) if (r.amount > 0 && !r.foreign) (ins.get(r.amount) ?? ins.set(r.amount, []).get(r.amount)).push(r);
  const credits = rows.filter((r) => r.amount > 0);
  const rejected = new Set(db.prepare('SELECT out_tx, in_tx FROM transfer_rejections').all().map((r) => `${r.out_tx}|${r.in_tx}`));

  const pairs = [];
  for (const o of rows) {
    if (o.amount >= 0) continue;
    const cross = credits.filter((i) => i.foreign !== o.foreign && fxGap(o.amount, i.amount) <= FX_TOLERANCE);
    for (const i of [...(o.foreign ? [] : ins.get(-o.amount) ?? []), ...cross]) {
      if (i.account_id === o.account_id || Math.abs(daysBetween(o.date, i.date)) > windowDays || rejected.has(`${o.id}|${i.id}`)) continue;
      const s = o.foreign || i.foreign ? crossScore(o, i) : score(o, i);
      if (s >= REVIEW) pairs.push({ o, i, s, gap: Math.abs(daysBetween(o.date, i.date)) });
    }
  }
  pairs.sort((a, b) => b.s - a.s || a.gap - b.gap || (a.o.id < b.o.id ? -1 : 1));

  const used = new Set();
  const out = { auto: 0, review: 0, scanned: pairs.length };
  const at = new Date().toISOString();
  const ins2 = db.prepare('INSERT INTO transfers (out_tx, in_tx, kind, status, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  tx(db, () => {
    for (const p of pairs) {
      if (used.has(p.o.id) || used.has(p.i.id)) continue;
      // Another counterpart nearly as good makes the pair doubtful, unless it
      // is a twin (same account, same day): then either pairing is the same.
      const rival = pairs.some((q) => q !== p && !used.has(q.o.id) && !used.has(q.i.id) && q.s >= p.s - 10
        && ((q.o.id === p.o.id && !(q.i.account_id === p.i.account_id && q.i.date === p.i.date))
          || (q.i.id === p.i.id && !(q.o.account_id === p.o.account_id && q.o.date === p.o.date))));
      const status = p.s >= AUTO && !rival ? 'auto' : 'review';
      ins2.run(p.o.id, p.i.id, kindFor(p.i.account_type), status, Math.min(1, p.s / 100), at);
      used.add(p.o.id);
      used.add(p.i.id);
      out[status] += 1;
    }
  });
  return out;
}

export function transferOf(db, txId) {
  return db.prepare('SELECT * FROM transfers WHERE out_tx = ? OR in_tx = ?').get(txId, txId) ?? null;
}

const LEG = (alias) => `${alias}.id ${alias}_id, ${alias}.account_id ${alias}_account_id, ${alias}a.name ${alias}_account_name, ${alias}.date ${alias}_date,
  ${alias}.description ${alias}_description, COALESCE(${alias}.merchant_override, ${alias}.merchant) ${alias}_merchant, ${alias}.amount ${alias}_amount, ${alias}.status ${alias}_status`;
const leg = (r, p) => (r[`${p}_id`] == null ? null : {
  id: r[`${p}_id`], account_id: r[`${p}_account_id`], account_name: r[`${p}_account_name`], date: r[`${p}_date`],
  description: r[`${p}_description`], merchant: r[`${p}_merchant`], amount: r[`${p}_amount`], status: r[`${p}_status`],
});

const STATUSES = ['auto', 'confirmed', 'review'];

export function listTransfers(db, { status = null, limit = 500 } = {}) {
  if (status && !STATUSES.includes(status)) throw bad(`status must be one of ${STATUSES.join(', ')}`);
  return db.prepare(`SELECT x.id, x.kind, x.status, x.confidence, x.principal, x.interest, x.created_at, ${LEG('o')}, ${LEG('i')}
    FROM transfers x
    LEFT JOIN transactions o ON o.id = x.out_tx LEFT JOIN accounts oa ON oa.id = o.account_id
    LEFT JOIN transactions i ON i.id = x.in_tx LEFT JOIN accounts ia ON ia.id = i.account_id
    ${status ? 'WHERE x.status = ?' : ''} ORDER BY COALESCE(o.date, i.date) DESC, x.id DESC LIMIT ?`).all(...(status ? [status, limit] : [limit]))
    .map((r) => ({
      id: r.id, kind: r.kind, status: r.status, confidence: r.confidence, principal: r.principal, interest: r.interest, created_at: r.created_at,
      amount: Math.abs(r.o_amount ?? r.i_amount), out: leg(r, 'o'), in: leg(r, 'i'),
    }));
}

const getTransfer = (db, id) => {
  const t = Number.isInteger(id) ? db.prepare('SELECT * FROM transfers WHERE id = ?').get(id) : null;
  if (!t) throw notFound('no such transfer');
  return t;
};

export function confirmTransfer(db, id) {
  getTransfer(db, id);
  db.prepare("UPDATE transfers SET status = 'confirmed', confidence = 1 WHERE id = ?").run(id);
  return getTransfer(db, id);
}

export function rejectTransfer(db, id) {
  const t = getTransfer(db, id);
  tx(db, () => {
    if (t.out_tx && t.in_tx) {
      db.prepare('INSERT INTO transfer_rejections (out_tx, in_tx, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(t.out_tx, t.in_tx, new Date().toISOString());
    }
    db.prepare('DELETE FROM transfers WHERE id = ?').run(id);
  });
  return { rejected: true };
}

// the owner pairs two legs by hand: no window, but the amounts must mirror.
export function linkTransfer(db, outId, inId) {
  const get = db.prepare("SELECT t.id, t.account_id, t.amount, a.type account_type, (a.manual = 1 AND a.currency != 'AUD') foreign_ccy FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?");
  const o = typeof outId === 'string' ? get.get(outId) : null;
  const i = typeof inId === 'string' ? get.get(inId) : null;
  if (!o || !i) throw notFound('no such transaction');
  if (o.account_id === i.account_id) throw bad('both legs are in the same account');
  // Across a foreign currency the two AUD values differ by the fee and the rate day, so they only need to be close.
  const across = !!o.foreign_ccy !== !!i.foreign_ccy;
  if (!(o.amount < 0 && i.amount > 0 && (across ? fxGap(o.amount, i.amount) <= FX_LINK_TOLERANCE : i.amount === -o.amount))) throw bad(across ? 'out_tx must be money out and in_tx about the same amount in, allowing for the exchange rate and fee' : 'out_tx must be money out and in_tx the same amount in');
  if (transferOf(db, o.id) || transferOf(db, i.id)) throw new HttpError(409, 'one of these is already linked');
  const { lastInsertRowid } = db.prepare("INSERT INTO transfers (out_tx, in_tx, kind, status, confidence, created_at) VALUES (?, ?, ?, 'confirmed', 1, ?)")
    .run(o.id, i.id, kindFor(i.account_type), new Date().toISOString());
  db.prepare('DELETE FROM transfer_rejections WHERE out_tx = ? AND in_tx = ?').run(o.id, i.id);
  return getTransfer(db, Number(lastInsertRowid));
}

// Principal and interest split of a loan repayment, only when the owner enters it.
export function setSplit(db, id, { principal = null, interest = null } = {}) {
  const t = getTransfer(db, id);
  if (t.kind !== 'loan_repayment') throw bad('only a loan repayment has a principal and interest split');
  if (principal !== null || interest !== null) {
    if (!Number.isInteger(principal) || !Number.isInteger(interest) || principal < 0 || interest < 0) throw bad('principal and interest must be whole cents, zero or more');
    const amount = db.prepare('SELECT abs(amount) n FROM transactions WHERE id = ?').get(t.out_tx ?? t.in_tx).n;
    if (principal + interest !== amount) throw bad('principal plus interest must equal the repayment');
  }
  db.prepare('UPDATE transfers SET principal = ?, interest = ? WHERE id = ?').run(principal, interest, id);
  return getTransfer(db, id);
}

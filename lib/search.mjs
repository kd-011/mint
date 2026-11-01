// Global search (the command palette's server half): a read-only look across
// transactions, categories, accounts and budgets. Screens and jump-to actions
// are the page's own list, so they work offline and never need this.
//
// A transaction matches on its description, merchant or merchant rename, or on
// its amount when the term reads as one ("42", "$42.50", "1,200"). A whole
// dollar figure matches any amount in that dollar; cents match exactly. The
// Transactions list uses the same clause for its q filter, so "see all" from
// the palette lands on the rows the palette counted.
import { bad } from './errors.mjs';
import { LIVE } from './live.mjs';

export const MAX_TERM = 100;
const MAX_DOLLARS = 99_999_999;

const likeOf = (term) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// A typed amount as the cents range it covers, or null when it is not a money figure.
export function amountRange(term) {
  const m = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(String(term ?? '').trim());
  if (!m) return null;
  const dollars = Number(m[1].replace(/,/g, ''));
  if (!Number.isSafeInteger(dollars) || dollars > MAX_DOLLARS) return null;
  if (m[2] == null) return [dollars * 100, dollars * 100 + 99];
  const cents = dollars * 100 + Number(m[2].padEnd(2, '0'));
  return [cents, cents];
}

// The WHERE fragment (aliased t) for a search term, with its arguments pushed onto args.
export function txTermClause(term, args) {
  const like = likeOf(term);
  const parts = ["t.description LIKE ? ESCAPE '\\'", "t.merchant LIKE ? ESCAPE '\\'", "t.merchant_override LIKE ? ESCAPE '\\'"];
  args.push(like, like, like);
  const r = amountRange(term);
  if (r) {
    parts.push('abs(t.amount) BETWEEN ? AND ?');
    args.push(r[0], r[1]);
  }
  return `(${parts.join(' OR ')})`;
}

export function searchAll(db, rawTerm, { txLimit = 8, limit = 5 } = {}) {
  const term = String(rawTerm ?? '').trim();
  if (!term) throw bad('q is required');
  if (term.length > MAX_TERM) throw bad('search too long');
  const like = likeOf(term);

  const args = [];
  const clause = txTermClause(term, args);
  const tx_ids = db.prepare(`SELECT t.id FROM transactions t WHERE ${clause} AND ${LIVE()} ORDER BY t.date DESC, t.id DESC LIMIT ?`).all(...args, txLimit).map((r) => r.id);
  const tx_total = db.prepare(`SELECT count(*) n FROM transactions t WHERE ${clause} AND ${LIVE()}`).get(...args).n;

  const categories = db.prepare(`SELECT id, name, grp, kind FROM categories WHERE archived = 0 AND (name LIKE ? ESCAPE '\\' OR grp LIKE ? ESCAPE '\\')
    ORDER BY (name LIKE ? ESCAPE '\\') DESC, name LIMIT ?`).all(like, like, `${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit);

  const accounts = db.prepare(`SELECT id, COALESCE(nickname, name) name, institution, type FROM accounts
    WHERE status IS NOT 'gone' AND (name LIKE ? ESCAPE '\\' OR nickname LIKE ? ESCAPE '\\' OR institution LIKE ? ESCAPE '\\')
    ORDER BY hidden, sort, name LIMIT ?`).all(like, like, like, limit);

  const budgets = db.prepare(`SELECT b.category_id, c.name, c.grp, b.cycle_target FROM budgets b JOIN categories c ON c.id = b.category_id
    WHERE c.archived = 0 AND (c.name LIKE ? ESCAPE '\\' OR c.grp LIKE ? ESCAPE '\\') ORDER BY c.name LIMIT ?`).all(like, like, limit);

  return { q: term, tx_ids, tx_total, categories, accounts, budgets };
}

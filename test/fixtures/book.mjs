// An in-memory Mint book for engine tests: invented accounts and a helper to
// add invented transactions. Nothing here is real account data.
import { openDb } from '../../lib/db.mjs';
import { seedCategories } from '../../lib/categories.mjs';
import { deriveMerchant } from '../../lib/merchant.mjs';

export const ACCOUNTS = [
  { id: 'acct_t_everyday', name: 'Everyday Test', type: 'transaction', conn: 'conn_t_alpha', balance: 100000 },
  { id: 'acct_t_savings', name: 'Savings Test', type: 'transaction', conn: 'conn_t_alpha', balance: 500000 },
  { id: 'acct_t_card', name: 'Test Platinum Card', type: 'credit-card', conn: 'conn_t_alpha', balance: -50000 },
  { id: 'acct_t_loan', name: 'Test Home Loan', type: 'loan', conn: 'conn_t_beta', balance: -40000000 },
  { id: 'acct_t_offset', name: 'Test Offset', type: 'transaction', conn: 'conn_t_beta', balance: 2500000 },
  { id: 'acct_t_biz', name: 'Business Test', type: 'transaction', conn: 'conn_t_alpha', balance: 300000, business: 1 },
];

export function book({ accounts = ACCOUNTS } = {}) {
  const db = openDb(':memory:');
  seedCategories(db);
  const at = '2026-10-01T00:00:00.000Z';
  db.prepare(`INSERT INTO connections (id, institution, status, consent_status, consent_expires_at, updated_at) VALUES
    ('conn_t_alpha', 'Alpha Bank', 'active', 'active', '2027-10-01T00:00:00.000Z', ?),
    ('conn_t_beta', 'Beta Mutual', 'active', 'active', '2027-10-01T00:00:00.000Z', ?)`).run(at, at);
  const insA = db.prepare(`INSERT INTO accounts (id, connection_id, name, type, institution, number_masked, is_business, balance_current, sort, created_at, updated_at, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  accounts.forEach((a, i) => insA.run(a.id, a.conn, a.name, a.type, a.conn === 'conn_t_beta' ? 'Beta Mutual' : 'Alpha Bank',
    `xxxx${1000 + i}`, a.business ?? 0, a.balance ?? null, i, at, at, '2026-10-17T01:00:00.000Z'));

  let seq = 0;
  const insT = db.prepare(`INSERT INTO transactions (id, account_id, status, date, post_date, description, amount, currency, direction,
      provider_category, merchant_name, merchant, first_seen_at, updated_at)
    VALUES (:id, :account_id, :status, :date, :date, :description, :amount, 'AUD', :direction, :provider_category, :merchant_name, :merchant, :at, :at)`);
  function add(account, date, amount, description, extra = {}) {
    seq += 1;
    const id = extra.id ?? `txn_t_${String(seq).padStart(5, '0')}`;
    insT.run({
      id, account_id: account, status: extra.status ?? 'posted', date, description, amount,
      direction: amount < 0 ? 'debit' : 'credit',
      provider_category: 'provider_category' in extra ? extra.provider_category : (amount < 0 ? 'MERCHANDISE' : 'INCOME'),
      merchant_name: extra.merchant_name ?? null,
      merchant: deriveMerchant(description, extra.merchant_name ?? null),
      at,
    });
    return id;
  }
  const cat = (name) => {
    const r = db.prepare('SELECT id FROM categories WHERE name = ?').get(name);
    if (!r) throw new Error(`no seed category ${name}`);
    return r.id;
  };
  const row = (id) => db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  return { db, add, cat, row };
}

// Same day-of-month N months back from an ISO date (clamped to month end).
export function monthsBack(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 - n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

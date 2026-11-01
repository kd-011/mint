// Mint's own category set: an Australian personal-finance taxonomy, with
// Redbark's provider_category mapped onto it as the fallback when no rule or
// model answer applies. Transfer-kind categories never count as spend or income.
import { tx } from './db.mjs';

export const SEED_CATEGORIES = [
  // [group, name, kind]
  ['Income', 'Salary', 'income'],
  ['Income', 'Interest', 'income'],
  ['Income', 'Refunds', 'income'],
  ['Income', 'Business income', 'income'],
  ['Income', 'Other income', 'income'],
  ['Transfers', 'Transfers', 'transfer'],
  ['Transfers', 'Card repayment', 'transfer'],
  ['Transfers', 'Loan repayment', 'transfer'],
  ['Transfers', 'Savings and investing', 'transfer'],
  ['Home', 'Rent', 'expense'],
  ['Home', 'Utilities', 'expense'],
  ['Home', 'Phone and internet', 'expense'],
  ['Home', 'Home and garden', 'expense'],
  ['Home', 'Insurance', 'expense'],
  ['Food', 'Groceries', 'expense'],
  ['Food', 'Eating out', 'expense'],
  ['Food', 'Takeaway and delivery', 'expense'],
  ['Food', 'Alcohol', 'expense'],
  ['Transport', 'Fuel', 'expense'],
  ['Transport', 'Parking and tolls', 'expense'],
  ['Transport', 'Public transport', 'expense'],
  ['Transport', 'Rideshare and taxis', 'expense'],
  ['Transport', 'Car maintenance', 'expense'],
  ['Transport', 'Rego', 'expense'],
  ['Transport', 'Transport', 'expense'],
  ['Shopping', 'Shopping', 'expense'],
  ['Shopping', 'Electronics', 'expense'],
  ['Shopping', 'Clothing', 'expense'],
  ['Health', 'Medical', 'expense'],
  ['Health', 'Pharmacy', 'expense'],
  ['Health', 'Fitness', 'expense'],
  ['Health', 'Personal care', 'expense'],
  ['Lifestyle', 'Entertainment', 'expense'],
  ['Lifestyle', 'Subscriptions', 'expense'],
  ['Lifestyle', 'Games', 'expense'],
  ['Lifestyle', 'Travel', 'expense'],
  ['Lifestyle', 'Gifts and donations', 'expense'],
  ['Lifestyle', 'Education', 'expense'],
  ['Lifestyle', 'Pets', 'expense'],
  ['Finance', 'Bank fees', 'expense'],
  ['Finance', 'Interest charged', 'expense'],
  ['Finance', 'Debt repayments', 'expense'],
  ['Finance', 'Government and fees', 'expense'],
  ['Finance', 'Cash', 'expense'],
  ['Business', 'Business expenses', 'expense'],
  ['Other', 'Services', 'expense'],
  ['Other', 'Other', 'expense'],
  // v2, appended so existing sort orders hold. A loan drawdown is the bank
  // lending money (settlement, construction progress claims), never spend.
  // Reimbursements is the general offset for friends paying the owner back.
  ['Transfers', 'Loan drawdown', 'transfer'],
  ['Other', 'Reimbursements', 'expense'],
  // A repayment into the home loan, counted as spend by budgets (lib/spend.mjs).
  // Home beside Rent: it is what owning costs, and a bill by nature.
  ['Home', 'Home loan', 'expense'],
  // Set balance on a manual account (lib/manual.mjs) records the difference
  // here: a correction, never spend or income.
  ['Transfers', 'Balance adjustment', 'transfer'],
];

// Redbark provider_category (Plaid-style) to a Mint category name.
export const PROVIDER_MAP = {
  FOOD_AND_DRINK: 'Eating out',
  TRANSFER_IN: 'Transfers',
  TRANSFER_OUT: 'Transfers',
  INCOME: 'Other income',
  MERCHANDISE: 'Shopping',
  GENERAL_MERCHANDISE: 'Shopping',
  ENTERTAINMENT: 'Entertainment',
  SERVICES: 'Services',
  GENERAL_SERVICES: 'Services',
  TRANSPORTATION: 'Transport',
  LOAN_PAYMENTS: 'Debt repayments',
  BANK_FEES: 'Bank fees',
  RENT_AND_UTILITIES: 'Utilities',
  MEDICAL: 'Medical',
  PERSONAL_CARE: 'Personal care',
  GOVERNMENT_AND_NON_PROFIT: 'Government and fees',
  HOME_IMPROVEMENT: 'Home and garden',
  TRAVEL: 'Travel',
};

// A few rules everyone needs, at a low precedence so the owner's own rules win.
const SEED_RULES = [
  { field: 'description', match: 'starts', pattern: 'SALARY', category: 'Salary', amount_min: 1 },
  { field: 'description', match: 'exact', pattern: 'INTEREST', category: 'Interest', amount_min: 1 },
  { field: 'description', match: 'exact', pattern: 'INTEREST', category: 'Interest charged', amount_max: -1 },
];

export function seedCategories(db) {
  tx(db, () => seed(db));
}

function seed(db) {
  const ins = db.prepare('INSERT INTO categories (name, grp, kind, sort) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO NOTHING');
  SEED_CATEGORIES.forEach(([grp, name, kind], i) => ins.run(name, grp, kind, i));
  if (db.prepare("SELECT value FROM settings WHERE key = 'seed_rules'").get()) return;
  const at = new Date().toISOString();
  const add = db.prepare(`INSERT INTO rules (field, match, pattern, category_id, amount_min, amount_max, priority, source, created_at)
    VALUES (?, ?, ?, (SELECT id FROM categories WHERE name = ?), ?, ?, 200, 'seed', ?)`);
  for (const r of SEED_RULES) add.run(r.field, r.match, r.pattern, r.category, r.amount_min ?? null, r.amount_max ?? null, at);
  db.prepare("INSERT INTO settings (key, value) VALUES ('seed_rules', '1')").run();
}

// A LOAN DRAWDOWN on a loan account is money lent, not spent. One rule per
// loan account, ahead of everything but the owner's own picks, made once: if the owner
// deletes it, it stays deleted.
export function seedLoanRules(db) {
  const cat = db.prepare("SELECT id FROM categories WHERE name = 'Loan drawdown'").get();
  if (!cat) return 0;
  const loans = db.prepare("SELECT id FROM accounts WHERE type = 'loan'").all();
  const done = db.prepare('SELECT value FROM settings WHERE key = ?');
  let n = 0;
  for (const a of loans) {
    const key = `loan_drawdown_rule:${a.id}`;
    if (done.get(key)) continue;
    tx(db, () => {
      db.prepare(`INSERT INTO rules (field, match, pattern, account_id, category_id, priority, source, created_at)
        VALUES ('description', 'starts', 'LOAN DRAWDOWN', ?, ?, 20, 'seed', ?)`).run(a.id, cat.id, new Date().toISOString());
      db.prepare("INSERT INTO settings (key, value) VALUES (?, '1')").run(key);
    });
    n += 1;
  }
  return n;
}

// Common AU merchants that the provider files under a broad category (petrol
// under Transport, supermarkets under Eating out). A versioned migration: the
// category seed runs once per book, so a new list bumps MERCHANT_RULES_VERSION.
// Priority 150 sits after anything the owner makes (manual 100, correction 50) and
// ahead of the base seeds at 200. Money out only, so a credit with a brand in
// its memo (a person paying the owner back) is never filed as that merchant. Each
// rule was checked against a copy of the live book: only rules that matched
// rows are here (no Aldi, DiDi or utility retailers: none in the book; Bunnings,
// Kmart, Big W and Target already file correctly, so they need no rule).
const MERCHANT_RULES_VERSION = 1;
const MERCHANT_RULE_PRIORITY = 150;
const MERCHANT_RULES = [
  // [field, match, pattern, category]
  ['merchant', 'regex', '^bp\\b', 'Fuel'],
  ['merchant', 'regex', '^shell\\b', 'Fuel'],
  ['merchant', 'starts', 'Reddy Express', 'Fuel'],
  ['merchant', 'starts', 'Ampol', 'Fuel'],
  ['merchant', 'starts', 'Caltex', 'Fuel'],
  ['merchant', 'starts', '7-Eleven', 'Fuel'],
  ['merchant', 'regex', '^united\\b(?!\\s+(airlines|nations))', 'Fuel'],
  ['merchant', 'starts', 'Puma Energy', 'Fuel'],
  ['merchant', 'starts', 'Liberty Oil', 'Fuel'],
  ['merchant', 'regex', '^vibe\\b(?!\\s+(hotels?|wireless))', 'Fuel'],
  ['merchant', 'starts', 'Eg Group', 'Fuel'],
  ['merchant', 'starts', 'Better Choice', 'Fuel'],
  ['merchant', 'starts', 'Woolworths', 'Groceries'],
  ['merchant', 'regex', '^coles\\b(?!\\s+express)', 'Groceries'],
  ['merchant', 'regex', '^(atwell fresh )?iga\\b', 'Groceries'],
  ['merchant', 'starts', 'Telstra', 'Phone and internet'],
  ['merchant', 'starts', 'Exetel', 'Phone and internet'],
  // Uber's merchant is one name for rides and Eats, so these read the description.
  ['description', 'regex', '^(?!.*uber[a-z_ *]{0,6}eats).*\\buber\\b', 'Rideshare and taxis'],
];

// Made once per version. A rule is skipped when the owner already has one with the
// same field, match and pattern (whatever its category), and a deleted seed
// rule stays deleted because the version key is set after the first run.
export function seedMerchantRules(db) {
  const key = 'au_merchant_rules';
  if (Number(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value) >= MERCHANT_RULES_VERSION) return 0;
  let made = 0;
  tx(db, () => {
    db.prepare("INSERT INTO categories (name, grp, kind, sort) VALUES ('Fuel', 'Transport', 'expense', ?) ON CONFLICT(name) DO NOTHING")
      .run(SEED_CATEGORIES.findIndex(([, n]) => n === 'Fuel'));
    const cat = db.prepare('SELECT id FROM categories WHERE name = ? AND archived = 0');
    const dupe = db.prepare('SELECT 1 FROM rules WHERE field = ? AND match = ? AND lower(pattern) = lower(?) AND account_id IS NULL');
    const add = db.prepare(`INSERT INTO rules (field, match, pattern, category_id, amount_max, priority, source, created_at)
      VALUES (?, ?, ?, ?, -1, ?, 'seed', ?)`);
    const at = new Date().toISOString();
    for (const [field, match, pattern, name] of MERCHANT_RULES) {
      const c = cat.get(name);
      if (!c || dupe.get(field, match, pattern)) continue;
      add.run(field, match, pattern, c.id, MERCHANT_RULE_PRIORITY, at);
      made += 1;
    }
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(MERCHANT_RULES_VERSION));
  });
  return made;
}

export const providerCategoryName = (pc) => (pc ? PROVIDER_MAP[String(pc).toUpperCase()] ?? null : null);
export const isTransferHint = (pc) => /^TRANSFER_/i.test(pc ?? '');

export function listCategories(db, { includeArchived = false } = {}) {
  return db.prepare(`SELECT id, name, grp, kind, color, sort, archived FROM categories ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY sort, name`).all();
}

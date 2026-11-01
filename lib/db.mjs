// SQLite schema for Mint. Money is integer minor units (cents) everywhere,
// dates are YYYY-MM-DD in the MINT_TZ zone (lib/dates.mjs), timestamps are ISO 8601 UTC.
// Redbark stores nothing, so this file is the only full copy of the history.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- One row per Redbark connection (a bank consent).
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  institution TEXT NOT NULL,
  provider TEXT,
  status TEXT NOT NULL,
  consent_id TEXT,
  consent_status TEXT,
  consent_expires_at TEXT,
  last_refreshed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  connection_id TEXT REFERENCES connections(id),
  name TEXT NOT NULL,
  nickname TEXT,
  type TEXT NOT NULL,
  institution TEXT NOT NULL,
  number_masked TEXT,
  currency TEXT NOT NULL DEFAULT 'AUD',
  status TEXT,
  is_business INTEGER NOT NULL DEFAULT 0 CHECK (is_business IN (0, 1)),
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  earliest_date TEXT,
  latest_date TEXT,
  backfill_done_at TEXT,
  last_synced_at TEXT,
  last_sync_error TEXT,
  balance_current INTEGER,
  balance_available INTEGER,
  balance_observed_at TEXT,
  balance_freshness TEXT,
  details_json TEXT,
  details_at TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  grp TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense', 'income', 'transfer')),
  color TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Transactions keyed on Redbark's provider id. Provider fields are refreshed on
-- every sync; the user fields (category, is_business, note) never are.
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'posted')),
  date TEXT NOT NULL,
  post_date TEXT,
  datetime TEXT,
  description TEXT NOT NULL DEFAULT '',
  reference TEXT,
  extended_description TEXT,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer'),
  currency TEXT NOT NULL,
  direction TEXT,
  provider_category TEXT,
  rb_category TEXT,
  merchant_name TEXT,
  mcc TEXT,
  merchant TEXT NOT NULL DEFAULT '',
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_source TEXT CHECK (category_source IN ('rule', 'ai', 'manual', 'provider')),
  is_business INTEGER CHECK (is_business IN (0, 1)),
  note TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tx_date ON transactions(date DESC, id DESC);
CREATE INDEX IF NOT EXISTS tx_account_date ON transactions(account_id, date DESC, id DESC);
CREATE INDEX IF NOT EXISTS tx_status ON transactions(account_id, status);

-- Redbark has no balance history, so Mint keeps one row per account per day.
CREATE TABLE IF NOT EXISTS balance_snapshots (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  current INTEGER,
  available INTEGER,
  observed_at TEXT,
  freshness TEXT,
  details_json TEXT,
  PRIMARY KEY (account_id, date)
);

-- Shares, super and anything else Redbark cannot see.
CREATE TABLE IF NOT EXISTS manual_assets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('shares', 'super', 'property', 'vehicle', 'cash', 'other')),
  is_liability INTEGER NOT NULL DEFAULT 0 CHECK (is_liability IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manual_snapshots (
  asset_id INTEGER NOT NULL REFERENCES manual_assets(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (typeof(value) = 'integer'),
  note TEXT,
  PRIMARY KEY (asset_id, date)
);

-- Categorising rules: match on merchant or description, optionally scoped to
-- one account. the owner's corrections become rules with source 'correction'.
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  field TEXT NOT NULL DEFAULT 'description' CHECK (field IN ('description', 'merchant')),
  match TEXT NOT NULL DEFAULT 'contains' CHECK (match IN ('contains', 'starts', 'exact', 'regex')),
  pattern TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  set_merchant TEXT,
  set_business INTEGER CHECK (set_business IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 100,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'correction', 'seed')),
  hits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL UNIQUE REFERENCES categories(id) ON DELETE CASCADE,
  monthly_target INTEGER NOT NULL CHECK (typeof(monthly_target) = 'integer' AND monthly_target >= 0),
  rollover INTEGER NOT NULL DEFAULT 0 CHECK (rollover IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Deductible spend, tagged with an ATO category. No GST anywhere.
CREATE TABLE IF NOT EXISTS tax_tags (
  transaction_id TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  ato_category TEXT NOT NULL,
  deductible_amount INTEGER CHECK (deductible_amount IS NULL OR typeof(deductible_amount) = 'integer'),
  note TEXT,
  created_at TEXT NOT NULL
);

-- Receipt files live under data/receipts with server-generated names.
CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY,
  transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  file TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- A transfer pairs money out of one of the owner's accounts with money into
-- another. Transfers never count as spend or income.
CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY,
  out_tx TEXT UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  in_tx TEXT UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'transfer' CHECK (kind IN ('transfer', 'card_repayment', 'loan_repayment')),
  status TEXT NOT NULL DEFAULT 'auto' CHECK (status IN ('auto', 'confirmed', 'review', 'rejected')),
  confidence REAL,
  principal INTEGER,
  interest INTEGER,
  created_at TEXT NOT NULL,
  CHECK (out_tx IS NOT NULL OR in_tx IS NOT NULL)
);

-- Alert dedupe: one row per (kind, key, period), e.g. a budget at 90% once a month.
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  period TEXT NOT NULL DEFAULT '',
  payload TEXT,
  created_at TEXT NOT NULL,
  pushed_at TEXT,
  dismissed_at TEXT,
  UNIQUE (kind, key, period)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  account_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER,
  fetched INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS sync_log_started ON sync_log(started_at DESC);

-- A pair the owner rejected as a transfer is never proposed again.
CREATE TABLE IF NOT EXISTS transfer_rejections (
  out_tx TEXT NOT NULL,
  in_tx TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (out_tx, in_tx)
);

-- The model's answer per merchant key, so each merchant is asked about once.
-- category_id NULL means it had no confident answer.
CREATE TABLE IF NOT EXISTS ai_cache (
  merchant_key TEXT PRIMARY KEY,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Model spend per local day: the daily cap reads this.
CREATE TABLE IF NOT EXISTS ai_usage (
  date TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  merchants INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0
);

-- Income streams (v2): every positive, non-transfer row is salary, a regular
-- payer, a reimbursement (nets off spend) or other money in. The first
-- matching source (lowest priority, then id) wins; unmatched rows are other.
-- match 'person' is the person-to-person heuristic in lib/income.mjs.
CREATE TABLE IF NOT EXISTS income_sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('salary', 'regular', 'reimbursement', 'other')),
  field TEXT NOT NULL DEFAULT 'description' CHECK (field IN ('description', 'merchant')),
  match TEXT NOT NULL DEFAULT 'contains' CHECK (match IN ('contains', 'starts', 'exact', 'regex', 'person')),
  pattern TEXT NOT NULL DEFAULT '',
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  amount_min INTEGER CHECK (amount_min IS NULL OR typeof(amount_min) = 'integer'),
  amount_max INTEGER CHECK (amount_max IS NULL OR typeof(amount_max) = 'integer'),
  cadence_days INTEGER,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  anchor INTEGER NOT NULL DEFAULT 0 CHECK (anchor IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 100,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'seed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The pay split: where each salary should go, a fixed amount or a percentage
-- (basis points) of the pay. Mint never moves money; it checks the transfers.
CREATE TABLE IF NOT EXISTS pay_plan (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'saving' CHECK (kind IN ('spending', 'saving', 'debt', 'business')),
  amount INTEGER CHECK (amount IS NULL OR (typeof(amount) = 'integer' AND amount >= 0)),
  percent_bp INTEGER CHECK (percent_bp IS NULL OR (typeof(percent_bp) = 'integer' AND percent_bp BETWEEN 0 AND 10000)),
  sort INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'suggested')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((amount IS NULL) != (percent_bp IS NULL))
);

-- Savings goals: progress from a linked account's balance, or from manual
-- contributions when no account is linked.
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  target_amount INTEGER CHECK (target_amount IS NULL OR (typeof(target_amount) = 'integer' AND target_amount >= 0)),
  target_date TEXT,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS goal_contributions (
  id INTEGER PRIMARY KEY,
  goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer'),
  note TEXT,
  created_at TEXT NOT NULL
);

-- Owed to me: money other people owe the owner, tallied by hand. Standalone ledger,
-- nothing here feeds net worth, safe to spend, budgets or the forecast. A debt
-- is settled when its repayments cover it, or closed by hand (settled or
-- written off). A repayment can name the incoming bank transaction it was.
CREATE TABLE IF NOT EXISTS owed (
  id INTEGER PRIMARY KEY,
  person TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount > 0),
  note TEXT,
  lent_on TEXT NOT NULL,
  due_on TEXT,
  closed TEXT CHECK (closed IS NULL OR closed IN ('settled', 'written_off')),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS owed_payments (
  id INTEGER PRIMARY KEY,
  owed_id INTEGER NOT NULL REFERENCES owed(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount > 0),
  note TEXT,
  transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owed_payments_owed ON owed_payments(owed_id);
CREATE INDEX IF NOT EXISTS idx_owed_payments_tx ON owed_payments(transaction_id);

-- Webhook idempotency: the delivery id (or event id) is the key.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  event_type TEXT,
  received_at TEXT NOT NULL,
  rows INTEGER NOT NULL DEFAULT 0,
  outcome TEXT
);
-- Shares and ETFs entered by hand. Unit prices are dollars (REAL, they can be
-- sub-cent); everything Mint adds up is whole cents. With lots, units and
-- avg_cost are derived from them.
CREATE TABLE IF NOT EXISTS holdings (
  id INTEGER PRIMARY KEY,
  ticker TEXT NOT NULL,
  exchange TEXT NOT NULL CHECK (exchange IN ('ASX', 'US')),
  name TEXT,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('au_shares', 'international', 'etf')),
  units REAL NOT NULL,
  avg_cost REAL NOT NULL,
  manual_price REAL,
  manual_price_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (ticker, exchange)
);
CREATE TABLE IF NOT EXISTS holding_lots (
  id INTEGER PRIMARY KEY,
  holding_id INTEGER NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  units REAL NOT NULL,
  price REAL NOT NULL,
  brokerage INTEGER NOT NULL DEFAULT 0
);
-- Latest quote per ticker (exchange FX holds AUD per USD). fetched_at is the
-- last good price; error and error_at record a later failed attempt, so the
-- last price stays and the screen can say why it is old.
CREATE TABLE IF NOT EXISTS quotes (
  ticker TEXT NOT NULL,
  exchange TEXT NOT NULL,
  price REAL,
  prev_close REAL,
  currency TEXT,
  source TEXT,
  fetched_at TEXT,
  error TEXT,
  error_at TEXT,
  PRIMARY KEY (ticker, exchange)
);
-- One row per day from the day holdings exist: portfolio value and cost in AUD cents.
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  date TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  cost INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
`;

// Additive migrations go here as ALTER TABLE ... ADD COLUMN, each in try/catch.
const MIGRATIONS = [
  // Rules can be limited to an amount range (signed cents, inclusive).
  'ALTER TABLE rules ADD COLUMN amount_min INTEGER',
  'ALTER TABLE rules ADD COLUMN amount_max INTEGER',
  // Which rule categorised a row, and a rule's merchant rename. Kept apart from
  // the derived merchant so a sync never fights a rename.
  'ALTER TABLE transactions ADD COLUMN rule_id INTEGER',
  'ALTER TABLE transactions ADD COLUMN merchant_override TEXT',
  'CREATE INDEX IF NOT EXISTS tx_category ON transactions(category_id, date)',
  // v2: the income stream a positive row belongs to (set by lib/income.mjs),
  // and for a reimbursement the spending category it pays back.
  'ALTER TABLE transactions ADD COLUMN income_source_id INTEGER',
  "ALTER TABLE transactions ADD COLUMN income_kind TEXT CHECK (income_kind IN ('salary', 'regular', 'reimbursement', 'other'))",
  'ALTER TABLE transactions ADD COLUMN offset_category_id INTEGER',
  'ALTER TABLE transactions ADD COLUMN income_manual INTEGER NOT NULL DEFAULT 0',
  'CREATE INDEX IF NOT EXISTS tx_income ON transactions(income_kind, date)',
  // v2: budgets run per pay cycle. monthly_target stays as the monthly
  // roll-up for Reports; existing rows convert x 12 / 26.
  'ALTER TABLE budgets ADD COLUMN cycle_target INTEGER',
  'ALTER TABLE budgets ADD COLUMN fixed INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE budgets ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'",
  'UPDATE budgets SET cycle_target = CAST(round(monthly_target * 12.0 / 26) AS INTEGER) WHERE cycle_target IS NULL',
  // v2: accounts the owner can spend from day to day (NULL = Mint's default guess).
  'ALTER TABLE accounts ADD COLUMN spendable INTEGER',
  // Save and Invest: what went into super since the previous snapshot (cents),
  // so growth can be told apart from contributions.
  'ALTER TABLE manual_snapshots ADD COLUMN contribution INTEGER',
  // Save and Invest: loan details Redbark does not give, entered by the owner. They
  // only fill gaps; whatever the bank gives wins.
  `CREATE TABLE IF NOT EXISTS loan_inputs (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    rate REAL,
    repayment INTEGER,
    frequency TEXT CHECK (frequency IN ('monthly', 'fortnightly', 'weekly')),
    end_date TEXT,
    updated_at TEXT NOT NULL
  )`,
  // Owed to me becomes a two-sided ledger: a debt is either owed to the owner (the
  // default, every existing row) or owed by him.
  "ALTER TABLE owed ADD COLUMN direction TEXT NOT NULL DEFAULT 'owed_to_me' CHECK (direction IN ('owed_to_me', 'i_owe'))",
  // Shares and ETFs: what the owner chose for an old manual 'shares' asset once
  // holdings exist (NULL = not asked yet, 'keep', 'convert').
  'ALTER TABLE manual_assets ADD COLUMN holdings_decision TEXT',
  // The chat door (lib/undo.mjs): an undo token per safe write holding the rows
  // it changed, before and after; a confirm token per bigger write holding the
  // operation and its parameters until the owner says yes. Only token hashes are kept.
  `CREATE TABLE IF NOT EXISTS undo_log (
    token_hash TEXT PRIMARY KEY,
    op TEXT NOT NULL,
    summary TEXT NOT NULL,
    changes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS confirm_tokens (
    token_hash TEXT PRIMARY KEY,
    op TEXT NOT NULL,
    params TEXT NOT NULL,
    summary TEXT NOT NULL,
    counts TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`,
  // The writes the assistant made during one chat question (lib/chatturn.mjs), so a resend
  // of the same question (the page's Retry after a dropped stream) gets the first
  // answer back instead of writing twice. body holds the write's answer, undo token
  // included, so the table is pruned with the undo window.
  `CREATE TABLE IF NOT EXISTS chat_turn_writes (
    rid TEXT NOT NULL,
    fp TEXT NOT NULL,
    n INTEGER NOT NULL,
    status INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (rid, fp, n)
  )`,
  // Merchant logos (lib/logos.mjs): one row per merchant grouping key. status is
  // ok (image cached), none (no domain or icon, retried after 30 days), error
  // (retried after 6 hours) or manual (the owner's own domain, or a cleared logo with
  // no domain; never overwritten). ai_day marks the one question put to the model.
  `CREATE TABLE IF NOT EXISTS merchant_logo (
    merchant_key TEXT PRIMARY KEY,
    domain TEXT,
    source TEXT CHECK (source IN ('map', 'desc', 'ai', 'manual')),
    status TEXT NOT NULL CHECK (status IN ('ok', 'none', 'error', 'manual')),
    attempts INTEGER NOT NULL DEFAULT 0,
    ai_day TEXT,
    error TEXT,
    fetched_at TEXT NOT NULL,
    image BLOB,
    content_type TEXT,
    etag TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS merchant_logo_domain ON merchant_logo(domain)',
  // Subscriptions the owner manages (lib/subscriptions.mjs). origin 'manual' is one he
  // typed in; origin 'detected' is a state on a subscription Mint found, keyed by
  // merchant_key (cancelled, or dismissed as not a subscription), with the name,
  // amount and cadence kept so a cancelled one still shows what it saves once
  // the charges stop. No row for a detected one means active, as before.
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY,
    origin TEXT NOT NULL CHECK (origin IN ('manual', 'detected')),
    merchant_key TEXT,
    name TEXT NOT NULL,
    amount INTEGER CHECK (amount IS NULL OR (typeof(amount) = 'integer' AND amount > 0)),
    cadence TEXT CHECK (cadence IS NULL OR cadence IN ('weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly')),
    next_date TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'dismissed')),
    cancelled_on TEXT,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_detected ON subscriptions(merchant_key) WHERE origin = 'detected'",
  // Saved views on Transactions (lib/views.mjs): a filter set under a name. The id is
  // picked by the page so a view made offline can be edited before it syncs.
  `CREATE TABLE IF NOT EXISTS saved_views (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    filters TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // Manual accounts (lib/manual.mjs): accounts Redbark cannot see, kept by hand,
  // in any currency. Every existing column keeps meaning AUD cents, so every
  // aggregate stays AUD by construction: balance_current and transactions.amount
  // are the AUD values, and the native figures sit beside them. Native amounts
  // are hundredths of the currency's unit whatever its decimals (JPY too).
  'ALTER TABLE accounts ADD COLUMN manual INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE accounts ADD COLUMN balance_native INTEGER',
  'ALTER TABLE accounts ADD COLUMN opening_balance INTEGER',
  'ALTER TABLE accounts ADD COLUMN opening_date TEXT',
  'ALTER TABLE accounts ADD COLUMN csv_mapping TEXT',
  'ALTER TABLE transactions ADD COLUMN amount_native INTEGER',
  'ALTER TABLE transactions ADD COLUMN fx_rate REAL',
  'ALTER TABLE transactions ADD COLUMN fx_date TEXT',
  'ALTER TABLE transactions ADD COLUMN import_id INTEGER',
  'ALTER TABLE transactions ADD COLUMN import_hash TEXT',
  'CREATE UNIQUE INDEX IF NOT EXISTS tx_import_hash ON transactions(account_id, import_hash) WHERE import_hash IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS tx_import ON transactions(import_id) WHERE import_id IS NOT NULL',
  'ALTER TABLE balance_snapshots ADD COLUMN native INTEGER',
  // Where the owner put a manual asset on Home (lib/homeorder.mjs). Accounts already carry `sort`.
  'ALTER TABLE manual_assets ADD COLUMN sort INTEGER NOT NULL DEFAULT 0',
  // Daily exchange rates (lib/fx.mjs): AUD per one unit of the currency, by the
  // ECB date Frankfurter gave it.
  `CREATE TABLE IF NOT EXISTS fx_rates (
    currency TEXT NOT NULL,
    date TEXT NOT NULL,
    rate REAL NOT NULL CHECK (rate > 0),
    source TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (currency, date)
  )`,
  // One row per CSV import into a manual account, so an import undoes as one.
  `CREATE TABLE IF NOT EXISTS manual_imports (
    id INTEGER PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    file_name TEXT,
    rows INTEGER NOT NULL,
    duplicates INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    from_date TEXT,
    to_date TEXT,
    created_at TEXT NOT NULL,
    undone_at TEXT
  )`,
  // Wise sync (lib/wisesync.mjs): a manual account that follows one Wise currency
  // balance. wise_balance_id is Wise's own balance id, what a re-sync finds the
  // account by; wise_statements is 'ok' when Wise hands over statement rows and
  // 'sca' when it refuses them (balances only, rows come from a CSV import).
  'ALTER TABLE accounts ADD COLUMN wise_balance_id TEXT',
  'ALTER TABLE accounts ADD COLUMN wise_statements TEXT',
  'CREATE UNIQUE INDEX IF NOT EXISTS accounts_wise_balance ON accounts(wise_balance_id) WHERE wise_balance_id IS NOT NULL',
  // A bank re-link gives the same real account a new Redbark id. lib/accountmerge.mjs
  // folds the old row into the new one: merged_into marks the retired row (it is also
  // set to status 'gone', never deleted) and account_merges holds what moved, as
  // before values, so a merge can be undone.
  'ALTER TABLE accounts ADD COLUMN merged_into TEXT',
  // the owner's override of the account type, for a bank that reports the wrong one (NAB savings arriving as
  // 'credit-card'). While type_override is set, accounts.type holds it (so every reader of a.type just works)
  // and the sync stops writing type; feed_type keeps what the bank last said, so clearing the override can
  // hand the type straight back without waiting for a sync.
  'ALTER TABLE accounts ADD COLUMN type_override TEXT',
  'ALTER TABLE accounts ADD COLUMN feed_type TEXT',
  `CREATE TABLE IF NOT EXISTS account_merges (
    id INTEGER PRIMARY KEY,
    from_id TEXT NOT NULL,
    into_id TEXT NOT NULL,
    merged_at TEXT NOT NULL,
    undone_at TEXT,
    summary TEXT NOT NULL,
    ops TEXT NOT NULL
  )`,
  // The fingerprint lock (lib/lock.mjs): enrolled passkeys (public keys only, as
  // SPKI) and the unlock sessions, keyed by a hash of the cookie's session id.
  `CREATE TABLE IF NOT EXISTS lock_credentials (
    id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    alg INTEGER NOT NULL,
    sign_count INTEGER NOT NULL DEFAULT 0,
    label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    last_used_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS lock_sessions (
    id TEXT PRIMARY KEY,
    credential_id TEXT,
    created_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL
  )`,
  // ATO Notices of Assessment, one per financial year (fy = the year it ends),
  // in cents. Only the figures, never a TFN or reference number (lib/noa.mjs).
  // refund is signed: an amount owing is negative.
  `CREATE TABLE IF NOT EXISTS tax_assessments (
    fy INTEGER PRIMARY KEY,
    taxable_income INTEGER NOT NULL,
    tax_withheld_payg INTEGER NOT NULL,
    assessed_tax INTEGER,
    medicare INTEGER,
    vet_repayment INTEGER,
    refund INTEGER,
    capital_gains INTEGER,
    source_file TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  for (const sql of MIGRATIONS) { try { db.exec(sql); } catch {} }
  return db;
}

// Nests: inside an open transaction it becomes a savepoint, so a write that
// runs its own tx() can sit inside the chat door's undo capture.
let depth = 0;
export function tx(db, fn) {
  if (db.isTransaction) {
    const sp = `sp_${++depth}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const out = fn();
      db.exec(`RELEASE ${sp}`);
      return out;
    } catch (e) {
      db.exec(`ROLLBACK TO ${sp}`);
      db.exec(`RELEASE ${sp}`);
      throw e;
    } finally { depth -= 1; }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const getSetting = (db, key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
export const setSetting = (db, key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value == null ? null : String(value));

// Invented Redbark fixtures. Nothing here is real account data: ids, names,
// amounts and descriptions are made up for tests.

export const TODAY = '2026-10-17';

export const connections = [
  {
    id: 'conn_test_alpha', object: 'connection', provider: 'fiskil', category: 'banking',
    institution: { id: 'inst_alpha', name: 'Alpha Bank', logo: null }, status: 'active',
    consent: { id: 'cons_alpha', status: 'active', expires_at: '2027-10-01T00:00:00.000Z' },
    accounts: null, account_count: 2, last_refreshed_at: '2026-10-17T01:00:00.000Z', ready_at: null,
    metadata: null, livemode: false, created: '2026-10-01T00:00:00.000Z', updated: '2026-10-17T01:00:00.000Z',
  },
  {
    id: 'conn_test_beta', object: 'connection', provider: 'fiskil', category: 'banking',
    institution: { id: 'inst_beta', name: 'Beta Mutual', logo: null }, status: 'expiring',
    consent: { id: 'cons_beta', status: 'expiring', expires_at: '2026-10-27T00:00:00.000Z' },
    accounts: null, account_count: 2, last_refreshed_at: '2026-10-17T01:00:00.000Z', ready_at: null,
    metadata: null, livemode: false, created: '2026-10-01T00:00:00.000Z', updated: '2026-10-17T01:00:00.000Z',
  },
];

const acct = (id, connection, name, type, inst, last4) => ({
  id, object: 'account_item', connection, provider: 'fiskil', category: 'banking', name, type,
  institution: { id: `inst_${inst.toLowerCase().split(' ')[0]}`, name: inst, logo: null },
  account_number: `xxxx${last4}`, currency: 'aud', status: 'available',
  last_updated_at: '2026-10-17T01:00:00.000Z', livemode: false,
  created: '2026-10-01T00:00:00.000Z', updated: '2026-10-17T01:00:00.000Z',
});

export const accounts = [
  acct('acct_test_everyday', 'conn_test_alpha', 'Everyday Test', 'transaction', 'Alpha Bank', '1111'),
  acct('acct_test_card', 'conn_test_alpha', 'Test Platinum Card', 'credit-card', 'Alpha Bank', '2222'),
  acct('acct_test_loan', 'conn_test_beta', 'Test Home Loan', 'loan', 'Beta Mutual', '3333'),
  acct('acct_test_offset', 'conn_test_beta', 'Test Offset', 'transaction', 'Beta Mutual', '4444'),
];

const money = (amount) => ({ amount, currency: 'aud' });
export const balances = {
  acct_test_everyday: { current: money(123456), available: money(123456) },
  acct_test_card: { current: money(-50000), available: money(950000) },
  acct_test_loan: { current: money(-40000000), available: money(0) },
  acct_test_offset: { current: money(2500000), available: money(2500000) },
};

export const details = {
  acct_test_loan: {
    object: 'account_details', account: 'acct_test_loan', product_name: 'Test Home Loan',
    deposit_rate: null, deposit_rates: [], lending_rate: '0.0599', lending_rates: [], fees: [], features: [],
    loan_details: {
      loan_end_date: '2055-01-01', repayment_type: 'PRINCIPAL_AND_INTEREST', repayment_frequency: 'P1M',
      next_instalment_date: '2026-11-01', max_redraw: '0.00', original_loan_amount: '450000.00',
      original_start_date: '2025-01-01', offset_account_enabled: true,
    },
    livemode: false,
  },
};

let seq = 0;
export function tx(account, date, amount, description, extra = {}) {
  seq += 1;
  return {
    id: extra.id ?? `txn_test_${account.slice(10)}_${String(seq).padStart(5, '0')}`,
    object: 'transaction', account, status: extra.status ?? 'posted', date,
    datetime: `${date}T03:00:00Z`, post_date: extra.status === 'pending' ? null : date, post_datetime: null,
    value_date: null, value_datetime: null, description, reference: null, extended_description: null,
    amount: money(amount), direction: amount < 0 ? 'debit' : 'credit',
    provider_category: extra.provider_category ?? (amount < 0 ? 'FOOD_AND_DRINK' : 'INCOME'),
    category: 'cat_test', merchant_name: extra.merchant_name ?? null, merchant_category_code: null, livemode: false,
  };
}

// Deterministic history: one row every 3 days per account, oldest first.
export function history(account, from, to, everyDays = 3) {
  const rows = [];
  let d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  let i = 0;
  while (d <= end) {
    const iso = d.toISOString().slice(0, 10);
    i += 1;
    rows.push(tx(account, iso, -((i % 17) + 1) * 137, `TEST CAFE ${i % 5}           TESTVILLE    AU`));
    d = new Date(d.getTime() + everyDays * 86400000);
  }
  return rows;
}

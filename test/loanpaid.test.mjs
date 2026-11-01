// The loan repayment the owner actually makes. An interest-only loan with no
// repayment figure from the bank: Mint shows what he pays (the latest
// repayment, never an average of two different ones that he never paid), when
// he last paid, the bank's figure beside it (the interest it charged), and
// whether the next instalment is already paid, on every loan surface. Money a
// parent pays into the offset and the owner forwards to the loan counts once, as the repayment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payBook, refreshMoney } from './fixtures/pay.mjs';
import { homeLoan } from '../lib/homeloan.mjs';
import { loanView } from '../lib/debt.mjs';
import { billsCalendar } from '../lib/bills.mjs';
import { safeToSpend } from '../lib/safe.mjs';
import { saveSummary, spendReport } from '../lib/assistant.mjs';

const TODAY = '2026-10-18';
const LOAN = 'acct_t_loan';
const OFFSET = 'acct_t_offset';

let ref = 0;
function toLoan(b, date, amount) {
  ref += 1;
  const r = `M${String(ref).padStart(10, '0')}`;
  b.add(OFFSET, date, -amount, `TEST M-BANKING FUNDS TFER ${r}`, { provider_category: 'TRANSFER_OUT' });
  b.add(LOAN, date, amount, `TEST M-BANKING TRANS ${r}`, { provider_category: 'TRANSFER_IN' });
}

function loanBook() {
  const b = payBook();
  b.db.prepare('UPDATE accounts SET balance_current = -35000000, details_json = ? WHERE id = ?').run(JSON.stringify({
    lending_rate: '0.0656',
    loan_details: { repayment_type: 'INTEREST_ONLY', repayment_frequency: 'P1M', next_instalment_date: '2026-10-29', original_start_date: '2026-07-29', loan_end_date: '2056-07-29', offset_account_enabled: true },
  }), LOAN);
  b.db.prepare('UPDATE accounts SET balance_current = 0 WHERE id = ?').run(OFFSET);
  b.add(LOAN, '2026-09-28', -188638, 'INTEREST', { provider_category: 'BANK_FEES' });
  b.add(OFFSET, '2026-09-28', 188216, 'PAYMENT FROM TEST PARENT & CO', { provider_category: 'INCOME' });
  toLoan(b, '2026-09-23', 217920);
  toLoan(b, '2026-10-14', 188216);
  refreshMoney(b, TODAY);
  return b;
}

const PAID = { due_date: '2026-10-29', status: 'paid', paid_on: '2026-10-14', amount: 188216 };

test('home loan: the repayment is what the owner paid last, with the date, the bank figure beside it, and the instalment marked paid', () => {
  const b = loanBook();
  const [l] = homeLoan(b.db, { today: TODAY }).items;
  assert.equal(l.repayment.amount, 188216, 'the latest repayment, not the average of 2,179.20 and 1,882.16');
  assert.equal(l.repayment.per_month, 188216);
  assert.equal(l.repayment.source, 'repayments', 'seen going in, not a figure from the bank');
  assert.deepEqual(l.repayment.last_paid, { date: '2026-10-14', amount: 188216 });
  assert.deepEqual(l.repayment.recent, [{ date: '2026-10-14', amount: 188216 }, { date: '2026-09-23', amount: 217920 }]);
  assert.deepEqual(l.repayment.scheduled, { amount: 188638, basis: 'last_interest_charge' });
  assert.deepEqual(l.instalment, PAID);
  // 1,882.16 a month is under the 1,913 of interest on $350,000 at 6.56%: the balance is not coming down.
  assert.equal(l.payoff.amortising, false);
});

test('plan debt view carries the same repayment, last paid date and paid instalment', () => {
  const b = loanBook();
  const [l] = loanView(b.db, { today: TODAY });
  assert.equal(l.repayment.amount, 188216);
  assert.deepEqual(l.repayment.last_paid, { date: '2026-10-14', amount: 188216 });
  assert.deepEqual(l.instalment, PAID);
  assert.equal(l.payoff.amortising, false);
});

test('bills: the instalment shows paid on the day with the amount paid', () => {
  const b = loanBook();
  const loan = billsCalendar(b.db, { today: TODAY }).items.filter((i) => i.kind === 'loan');
  assert.deepEqual(loan.map((i) => [i.date, i.status, i.paid_on, i.amount]), [['2026-10-29', 'paid', '2026-10-14', 188216]]);
});

test('assistant save read: the home loan carries the repayment the owner makes and the paid instalment', () => {
  const b = loanBook();
  const [l] = saveSummary(b.db, { today: TODAY }).home_loan;
  assert.equal(l.repayment_per_month, 188216);
  assert.deepEqual(l.last_paid, { date: '2026-10-14', amount: 188216 });
  assert.deepEqual(l.instalment, PAID);
});

test('money forwarded from the offset to the loan is not flexible spend, and counts once as the repayment', () => {
  const b = loanBook();
  const s = safeToSpend(b.db, { today: TODAY });
  assert.equal(s.flexible_spent, 0);
  const loanBills = s.breakdown.find((x) => x.key === 'bills').lines.filter((x) => x.kind === 'loan');
  assert.deepEqual(loanBills.map((x) => [x.date, x.amount, x.status]), [['2026-10-14', 188216, 'paid']]);
  const spend = spendReport(b.db, { from: '2026-09-01', to: TODAY }, TODAY);
  // Since Home loan spend (2026-10-19): the interest charge plus the two repayments the owner made into the loan, each once.
  assert.equal(spend.totals.spent, 188638 + 217920 + 188216, 'the interest charge and the two repayments, not the parent money forwarded twice');
});

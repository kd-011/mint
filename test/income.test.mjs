// v2 step 2: income streams. Every positive, non-transfer row is salary, a
// regular payer, a reimbursement (nets off spend) or other money in. Streams
// are rows in income_sources, seeded from the book and editable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payBook, refreshMoney, transfer, setCat, PAY_ACCOUNT, SALARY } from './fixtures/pay.mjs';
import { listSources, createSource, updateSource, setTransactionIncome, incomeReport, classifyIncome } from '../lib/income.mjs';
import { monthlyReport } from '../lib/reports.mjs';
import { spendReport } from '../lib/assistant.mjs';
import { setBudget, cycleBudgetProgress } from '../lib/budgets.mjs';
import { currentCycle } from '../lib/cycles.mjs';

const TODAY = '2026-10-17';

function incomeBook() {
  const b = payBook();
  const ids = {};
  // A regular payer: same payer, same amount, about a fortnight apart, into the offset.
  for (const d of ['2026-08-28', '2026-09-11', '2026-09-25', '2026-10-09']) {
    ids[`reg_${d}`] = b.add('acct_t_offset', d, 188216, 'PAYMENT FROM TEST PARENT & CO', { provider_category: 'INCOME' });
  }
  // Friends paying the owner back.
  ids.dinner = b.add(PAY_ACCOUNT, '2026-10-10', 4500, 'ALEX SAMPLEPERSONdinner', { provider_category: 'INCOME' });
  ids.padel = b.add(PAY_ACCOUNT, '2026-10-11', 7500, 'JORDAN EXAMPLE padel', { provider_category: 'INCOME' });
  ids.plain = b.add(PAY_ACCOUNT, '2026-10-12', 3000, 'SAM PLACEHOLDER', { provider_category: 'INCOME' });
  // Other money in: a gift, interest, card cashback, a big person credit.
  ids.gift = b.add(PAY_ACCOUNT, '2026-10-01', 30000, 'MR CASEY TESTHappy birthday from', { provider_category: 'INCOME' });
  ids.interest = b.add('acct_t_savings', '2026-09-30', 320, 'INTEREST', { provider_category: 'INCOME' });
  ids.cashback = b.add(PAY_ACCOUNT, '2026-09-30', 58, 'V0000 30/09 DEBIT PLAT CASH BACK 74900000000', { provider_category: 'INCOME' });
  ids.big = b.add(PAY_ACCOUNT, '2026-10-02', 406200, 'TAYLOR SAMPLE trip money', { provider_category: 'INCOME' });
  // A refund in a spending category is a refund, not money in.
  ids.bistro = b.add('acct_t_card', '2026-10-09', -12000, 'TEST BISTRO', { provider_category: 'FOOD_AND_DRINK' });
  ids.refund = b.add('acct_t_card', '2026-10-13', 2500, 'TEST GROCER REFUND', { provider_category: 'FOOD_AND_DRINK' });
  ids.groc = b.add('acct_t_card', '2026-10-08', -20000, 'TEST GROCER', { provider_category: 'FOOD_AND_DRINK' });
  setCat(b, ids.refund, 'Groceries');
  setCat(b, ids.groc, 'Groceries');
  ids.xfer = transfer(b, PAY_ACCOUNT, 'acct_t_savings', '2026-10-08', 50000);
  refreshMoney(b, TODAY);
  return { b, ids };
}

const kind = (b, id) => b.row(id).income_kind;

test('seeding finds the salary, the regular payer and a reimbursement stream', () => {
  const { b } = incomeBook();
  const sources = listSources(b.db);
  const salary = sources.find((s) => s.kind === 'salary');
  assert.ok(salary, 'salary stream');
  assert.equal(salary.account_id, null); // any account: the pay account has moved before
  assert.equal(salary.anchor, true);
  assert.equal(salary.cadence_days, 14);
  assert.match(salary.pattern, /SALARY\/WAGES/i);
  const regular = sources.find((s) => s.kind === 'regular');
  assert.ok(regular, 'regular payer stream');
  assert.equal(regular.account_id, 'acct_t_offset');
  assert.equal(regular.cadence_days, 14);
  assert.ok(regular.amount_min <= 188216 && regular.amount_max >= 188216);
  assert.ok(sources.some((s) => s.kind === 'reimbursement'));
});

test('every positive non-transfer row gets a kind; refunds and transfers stay out', () => {
  const { b, ids } = incomeBook();
  assert.equal(kind(b, ids['reg_2026-10-09']), 'regular');
  assert.equal(kind(b, ids.dinner), 'reimbursement');
  assert.equal(kind(b, ids.padel), 'reimbursement');
  assert.equal(kind(b, ids.plain), 'reimbursement');
  for (const k of ['gift', 'interest', 'cashback', 'big']) assert.equal(kind(b, ids[k]), 'other', k);
  assert.equal(kind(b, ids.refund), null);
  assert.equal(kind(b, ids.xfer.i), null);
  const salaryRows = b.db.prepare("SELECT count(*) n FROM transactions WHERE income_kind = 'salary'").get().n;
  assert.equal(salaryRows, 7);
  // Reimbursements land on the category they pay back, or a general offset.
  assert.equal(b.row(ids.dinner).offset_category_id, b.cat('Eating out'));
  assert.equal(b.row(ids.padel).offset_category_id, b.cat('Entertainment'));
  assert.equal(b.row(ids.plain).offset_category_id, b.cat('Reimbursements'));
});

test('reimbursements net off spend in reports, the assistant spend and cycle budgets, and never count as income', () => {
  const { b } = incomeBook();
  const oct = monthlyReport(b.db, { from: '2026-10', to: '2026-10' });
  // Income is salary plus the regular payer only.
  assert.equal(oct.months[0].income, 226000 + 188216);
  assert.equal(oct.months[0].other_in, 30000 + 406200);
  assert.equal(oct.months[0].reimbursed, 4500 + 7500 + 3000);
  const eat = oct.categories.find((c) => c.name === 'Eating out');
  assert.equal(eat.spent, 12000 - 4500);
  assert.equal(oct.months[0].spent, 12000 + 20000 - 2500 - 4500 - 7500 - 3000);
  assert.equal(spendReport(b.db, { category: 'Eating out', from: '2026-10-01', to: '2026-10-31' }).totals.spent, 7500);
  assert.equal(spendReport(b.db, { from: '2026-10-01', to: '2026-10-31' }).totals.income, 226000 + 188216);
  setBudget(b.db, b.cat('Eating out'), { cycle_target: 20000 });
  const cycle = currentCycle(b.db, { today: TODAY });
  const row = cycleBudgetProgress(b.db, cycle, { today: TODAY }).items.find((i) => i.name === 'Eating out');
  assert.equal(row.spent, 7500);
});

test('streams are editable and a manual pick sticks', () => {
  const { b, ids } = incomeBook();
  const reimb = listSources(b.db).find((s) => s.kind === 'reimbursement');
  updateSource(b.db, reimb.id, { amount_max: 4000 });
  classifyIncome(b.db);
  assert.equal(kind(b, ids.dinner), 'other');
  assert.equal(kind(b, ids.plain), 'reimbursement');
  setTransactionIncome(b.db, ids.plain, { kind: 'other' });
  classifyIncome(b.db);
  assert.equal(kind(b, ids.plain), 'other');
  setTransactionIncome(b.db, ids.plain, { auto: true });
  assert.equal(kind(b, ids.plain), 'reimbursement');
  // A new stream by hand: the big credit is a regular side gig.
  const gig = createSource(b.db, { name: 'Side gig', kind: 'regular', match: 'starts', pattern: 'TAYLOR SAMPLE', cadence_days: 28 });
  classifyIncome(b.db);
  assert.equal(b.row(ids.big).income_source_id, gig.id);
  assert.equal(kind(b, ids.big), 'regular');
  assert.throws(() => createSource(b.db, { name: 'x', kind: 'lottery', pattern: 'x' }), (e) => e.status === 400);
  assert.throws(() => updateSource(b.db, 9999, { name: 'x' }), (e) => e.status === 404);
});

test('income report: salary stats, next payday, per cycle and per month, received vs expected', () => {
  const { b } = incomeBook();
  const r = incomeReport(b.db, { today: TODAY });
  // Median and stats over the last six pays.
  assert.equal(r.salary.count, 7);
  assert.deepEqual(r.salary.last, { date: '2026-10-07', amount: 226000 });
  assert.equal(r.salary.median, (225000 + 226000) / 2); // the last four pays
  assert.equal(r.salary.average, Math.round((251000 + 250000 + 230000 + 220000 + 225000 + 226000) / 6));
  assert.ok(r.salary.stddev > 0);
  assert.deepEqual(r.next_payday, { date: '2026-10-21', expected_amount: (225000 + 226000) / 2, late: false, days_late: 0 });
  const cur = r.by_cycle.at(-1);
  assert.equal(cur.start, '2026-10-07');
  assert.equal(cur.salary, 226000);
  assert.equal(cur.regular, 188216);
  assert.equal(cur.income, 226000 + 188216);
  assert.equal(cur.reimbursed, 15000);
  assert.equal(cur.other_in, 0);
  assert.equal(r.by_cycle.at(-2).other_in, 320 + 58 + 30000 + 406200);
  assert.equal(r.by_month.find((m) => m.month === '2026-10').income, 226000 + 188216);
  assert.equal(r.current.received.total, 226000 + 188216);
  assert.equal(r.current.expected.total, 226000 + 188216);
  assert.ok(r.streams.every((s) => 'total' in s && 'last_date' in s));
});

test('money from the owner is never a reimbursement; housemates paying rent offset rent', () => {
  const b = payBook();
  const self = b.add(PAY_ACCOUNT, '2026-10-08', 20000, 'TEST PERSON clink');
  const initials = b.add(PAY_ACCOUNT, '2026-10-09', 15000, 'Person T H');
  const rent = b.add(PAY_ACCOUNT, '2026-10-10', 40000, 'MORGAN HOUSEMATERent + gas');
  const namesake = b.add(PAY_ACCOUNT, '2026-10-11', 5000, 'RILEY PERSON lunch'); // shares the surname only
  refreshMoney(b, TODAY);
  assert.equal(b.row(self).income_kind, 'other');
  assert.equal(b.row(initials).income_kind, 'other');
  assert.equal(b.row(rent).income_kind, 'reimbursement');
  assert.equal(b.row(rent).offset_category_id, b.cat('Rent'));
  assert.equal(b.row(namesake).income_kind, 'reimbursement');
});

test('salary in an older pay account still counts, and the pay account follows the latest salary', async () => {
  const { payAccount } = await import('../lib/plan.mjs');
  const b = payBook();
  for (const d of ['2026-06-03', '2026-06-17', '2026-07-01']) b.add('acct_t_savings', d, 240000, SALARY, { provider_category: 'INCOME' });
  refreshMoney(b, TODAY);
  assert.equal(b.db.prepare("SELECT count(*) n FROM transactions WHERE income_kind = 'salary'").get().n, 10);
  assert.equal(monthlyReport(b.db, { from: '2026-06', to: '2026-06' }).months[0].income, 480000);
  assert.equal(listSources(b.db).find((s) => s.kind === 'salary').account_id, null);
  assert.equal(payAccount(b.db).id, PAY_ACCOUNT);
});

test('a regular payer is projected on its own rhythm and stops counting three days late', async () => {
  const { regularInCycle } = await import('../lib/income.mjs');
  const { currentCycle } = await import('../lib/cycles.mjs');
  const b = payBook();
  for (const d of ['2026-09-11', '2026-09-28']) b.add('acct_t_offset', d, 188216, 'PAYMENT FROM TEST PARENT & CO', { provider_category: 'INCOME' });
  refreshMoney(b, TODAY);
  const reg = listSources(b.db).find((s) => s.kind === 'regular');
  assert.equal(reg.cadence_days, 17);
  const at = (today) => regularInCycle(b.db, currentCycle(b.db, { today }), { today }).map((r) => [r.date, r.status]);
  assert.deepEqual(at('2026-10-14'), [['2026-10-15', 'expected']]);
  assert.deepEqual(at('2026-10-17'), [['2026-10-15', 'late']]);
  assert.deepEqual(at('2026-10-19'), [['2026-10-15', 'missed']]);
});

test('a manual income pick on a row filed under spending is refused; a pick survives a transfer link', async () => {
  const { linkTransfer, rejectTransfer } = await import('../lib/transfers.mjs');
  const b = payBook();
  const spendy = b.add(PAY_ACCOUNT, '2026-10-10', 4000, 'ALEX SAMPLEPERSON');
  setCat(b, spendy, 'Groceries');
  refreshMoney(b, TODAY);
  assert.throws(() => setTransactionIncome(b.db, spendy, { kind: 'reimbursement' }), (e) => e.status === 400);
  const inn = b.add(PAY_ACCOUNT, '2026-10-11', 7000, 'JORDAN EXAMPLE');
  const out = b.add('acct_t_savings', '2026-10-11', -7000, 'SOMETHING');
  refreshMoney(b, TODAY);
  setTransactionIncome(b.db, inn, { kind: 'other' });
  const x = linkTransfer(b.db, out, inn);
  classifyIncome(b.db);
  rejectTransfer(b.db, x.id);
  classifyIncome(b.db);
  assert.equal(b.row(inn).income_kind, 'other');
  assert.equal(b.row(inn).income_manual, 1);
});

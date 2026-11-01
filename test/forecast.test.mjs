// Cashflow forecast over a book: the starting balance is the spendable
// accounts, income is the detected pay cycle (salary and regular payers that
// land in a spendable account), outflows are bills and subscriptions at their
// next expected dates, the pay split (card repayments capped at what is owed),
// and a baseline daily spend from the trailing eight weeks that leaves out
// recurring charges and transfers. No salary seen means a message, not a chart.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { payBook, refreshMoney, transfer, PAY_ACCOUNT } from './fixtures/pay.mjs';
import { book, monthsBack } from './fixtures/book.mjs';
import { setPlan } from '../lib/plan.mjs';
import { forecast, getFloor, setFloor } from '../lib/forecast.mjs';
import { createApi } from '../lib/api.mjs';
import { HttpError } from '../lib/errors.mjs';
import { addDays } from '../lib/dates.mjs';

const TODAY = '2026-10-08';

// Daily spend of $50 for the 56 days before today, a gym on the 12th each
// month ($80, a recurring bill that must stay out of the baseline), a transfer
// to savings in the window (also out), and $3,000 in the everyday account.
function forecastBook({ regularInto = null, balance = 300000 } = {}) {
  const b = payBook();
  for (let d = addDays(TODAY, -56); d < TODAY; d = addDays(d, 1)) b.add(PAY_ACCOUNT, d, -5000, `TEST SHOP ${d}`);
  for (let n = 1; n <= 6; n++) b.add(PAY_ACCOUNT, monthsBack('2026-09-12', n - 1), -8000, 'TEST GYM DD');
  transfer(b, PAY_ACCOUNT, 'acct_t_savings', '2026-09-20', 50000);
  if (regularInto) for (const d of ['2026-09-11', '2026-09-25']) b.add(regularInto, d, 188216, 'PAYMENT FROM TEST PARENT & CO', { provider_category: 'INCOME' });
  b.db.prepare('UPDATE accounts SET balance_current = ? WHERE id = ?').run(balance, PAY_ACCOUNT);
  refreshMoney(b, TODAY);
  return b;
}
const at = (f, label, date) => f.items.find((i) => i.label.toLowerCase().startsWith(label.toLowerCase()) && (!date || i.date === date));

test('forecast: balance from spendable accounts, pay on the cycle, a bill before pay, baseline spend', () => {
  const b = forecastBook();
  const f = forecast(b.db, { today: TODAY });
  assert.equal(f.available, true);
  assert.equal(f.start_balance, 300000);
  assert.equal(f.floor, 0);
  assert.equal(f.days.length, 31);
  assert.deepEqual([f.days[0].date, f.days.at(-1).date], [TODAY, '2026-11-07']);
  assert.equal(f.next_payday.date, '2026-10-21');
  assert.equal(f.next_payday.amount, 225500);
  // Recurring and transfers are out: 56 days of $50, nothing else.
  assert.deepEqual([f.baseline.daily, f.baseline.sd, f.baseline.days], [5000, 0, 56]);
  const gym = at(f, 'TEST GYM', '2026-10-12');
  assert.deepEqual([gym.amount, gym.kind], [-8000, 'bill']);
  const pay = at(f, 'Salary', '2026-10-21');
  assert.deepEqual([pay.amount, pay.kind], [225500, 'income']);
  const bal = (d) => f.days.find((x) => x.date === d).balance;
  // Day 0 to 10-11 is four days of $50; the gym comes off on the 12th.
  assert.equal(bal('2026-10-11'), 300000 - 4 * 5000);
  assert.equal(bal('2026-10-12'), 300000 - 5 * 5000 - 8000);
  assert.equal(bal('2026-10-21'), 300000 - 14 * 5000 - 8000 + 225500);
  assert.equal(f.status, 'ok');
  assert.deepEqual([f.lowest.date, f.lowest.balance, f.lowest.before_payday], ['2026-10-20', 300000 - 13 * 5000 - 8000, true]);
});

test('forecast: running balance on every item and the order is by date', () => {
  const f = forecast(forecastBook().db, { today: TODAY });
  const dates = f.items.map((i) => i.date);
  assert.deepEqual(dates, [...dates].sort());
  for (const i of f.items) assert.equal(i.balance_after, f.days.find((d) => d.date === i.date).balance, i.label);
});

test('forecast: breaching the floor warns, with the first date', () => {
  const b = forecastBook({ balance: 20000 });
  const f = forecast(b.db, { today: TODAY });
  assert.equal(f.status, 'breach');
  assert.ok(f.first_breach && f.first_breach < f.next_payday.date);
  assert.ok(f.lowest.balance < 0);
  setFloor(b.db, 500000);
  const g = forecast(b.db, { today: TODAY });
  assert.equal(g.floor, 500000);
  assert.equal(g.first_breach, TODAY);
});

test('forecast: the floor defaults to zero and is validated', () => {
  const b = forecastBook();
  assert.equal(getFloor(b.db), 0);
  assert.equal(setFloor(b.db, 12345), 12345);
  assert.equal(getFloor(b.db), 12345);
  for (const bad of [-1, 1.5, '12', null, 1e12]) assert.throws(() => setFloor(b.db, bad), /floor/);
});

test('forecast: a regular payer landing in a spendable account is income, in the offset it is not', () => {
  const into = forecast(forecastBook({ regularInto: PAY_ACCOUNT }).db, { today: TODAY });
  const reg = into.items.filter((i) => i.kind === 'income' && !i.label.startsWith('Salary'));
  assert.ok(reg.length >= 1 && reg.every((i) => i.amount === 188216), JSON.stringify(reg));
  const off = forecast(forecastBook({ regularInto: 'acct_t_offset' }).db, { today: TODAY });
  assert.deepEqual(off.items.filter((i) => i.kind === 'income' && !i.label.startsWith('Salary')), []);
});

test('forecast: the pay split comes off on payday, a card repayment is capped at what is owed, once', () => {
  const b = forecastBook();
  setPlan(b.db, { lines: [
    { account_id: 'acct_t_savings', kind: 'saving', amount: 50000 },
    { account_id: 'acct_t_card', kind: 'debt', amount: 80000 },
  ] });
  const f = forecast(b.db, { today: TODAY });
  const sav = f.items.find((i) => i.kind === 'split' && i.label.includes('Savings Test') && i.date === '2026-10-21');
  assert.equal(sav.amount, -50000);
  const card = f.items.filter((i) => i.kind === 'card');
  // The card owes $500 and this cycle's $800 is not moved yet: today's repayment clears it, payday has nothing left to pay.
  assert.deepEqual(card.map((i) => [i.date, i.amount]), [[TODAY, -50000]]);
  assert.match(card[0].label, /^Card repayment/);
});

test('forecast: a split not yet moved this cycle is still to come today', () => {
  const b = forecastBook();
  setPlan(b.db, { lines: [{ account_id: 'acct_t_savings', kind: 'saving', amount: 40000 }] });
  const f = forecast(b.db, { today: TODAY });
  const now = f.items.find((i) => i.kind === 'split' && i.date === TODAY);
  assert.equal(now.amount, -40000);
  transfer(b, PAY_ACCOUNT, 'acct_t_savings', '2026-10-07', 40000);
  refreshMoney(b, TODAY);
  assert.equal(forecast(b.db, { today: TODAY }).items.find((i) => i.kind === 'split' && i.date === TODAY), undefined);
});

test('forecast: pay that is late is counted for today, not dropped', () => {
  const b = forecastBook();
  const f = forecast(b.db, { today: '2026-10-22' });
  assert.equal(f.next_payday.late, true);
  assert.equal(f.next_payday.date, '2026-10-22');
});

test('forecast: no salary seen is a message, not a chart', () => {
  const b = book();
  const f = forecast(b.db, { today: TODAY });
  assert.equal(f.available, false);
  assert.match(f.reason, /salary/i);
  assert.equal(f.days, undefined);
});

test('forecast: no spending account is a message too', () => {
  const b = forecastBook();
  b.db.prepare("UPDATE accounts SET spendable = 0 WHERE id = ?").run(PAY_ACCOUNT);
  const f = forecast(b.db, { today: TODAY });
  assert.equal(f.available, false);
  assert.match(f.reason, /spending account/i);
});

test('forecast: the range is labelled an estimate and the assumptions are stated', () => {
  const f = forecast(forecastBook().db, { today: TODAY });
  assert.match(f.note, /estimate/i);
  assert.ok(f.assumptions.some((a) => /card/i.test(a)));
  assert.ok(f.days.every((d) => d.low <= d.balance && d.balance <= d.high));
});

// ---- cards, loans and the cash view ----
// Daily $100 on the Test Platinum Card for the same 56 days, and the card's $500 balance owed.
function withCardSpend(b) {
  for (let d = addDays(TODAY, -56); d < TODAY; d = addDays(d, 1)) b.add('acct_t_card', d, -10000, `TEST CARD SHOP ${d}`);
  refreshMoney(b, TODAY);
  return b;
}
const balOn = (f, d) => f.days.find((x) => x.date === d).balance;

test('forecast: a card on the pay split is repaid from the account, its purchases do not hit the balance', () => {
  const b = withCardSpend(forecastBook());
  setPlan(b.db, { lines: [{ account_id: 'acct_t_card', kind: 'debt', amount: 80000 }] });
  const f = forecast(b.db, { today: TODAY });
  assert.equal(f.baseline.daily, 5000);
  assert.equal(balOn(f, '2026-10-11'), 300000 - 4 * 5000 - 60000);
  const card = f.items.filter((i) => i.kind === 'card').map((i) => [i.date, i.amount]);
  // Owes $500 plus $100 a day of new spending: today's repayment is capped at $600, later ones are the plan's $800.
  assert.deepEqual(card, [[TODAY, -60000], ['2026-10-21', -80000], ['2026-11-04', -80000]]);
});

test('forecast: a card that is not on the pay split has its spending counted as it happens', () => {
  const f = forecast(withCardSpend(forecastBook()).db, { today: TODAY });
  assert.equal(f.baseline.daily, 15000);
  assert.equal(balOn(f, '2026-10-11'), 300000 - 4 * 15000);
  assert.ok(f.assumptions.some((a) => /Test Platinum Card/.test(a) && /as it happens/.test(a)));
});

test('forecast: loan interest charged on the loan account is not spending', () => {
  const b = forecastBook();
  const t = b.add('acct_t_loan', '2026-10-01', -188000, 'INTEREST');
  b.db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = ?").run(b.cat('Interest charged'), t);
  refreshMoney(b, TODAY);
  assert.equal(forecast(b.db, { today: TODAY }).baseline.daily, 5000);
});

test('forecast: a subscription charged to a repaid card is listed but does not move the balance', () => {
  const b = forecastBook();
  for (let n = 0; n < 6; n++) b.add('acct_t_card', monthsBack('2026-09-15', n), -1599, 'TESTFLIX');
  setPlan(b.db, { lines: [{ account_id: 'acct_t_card', kind: 'debt', amount: 10000 }] });
  refreshMoney(b, TODAY);
  const f = forecast(b.db, { today: TODAY });
  const flix = at(f, 'testflix', '2026-10-15');
  assert.deepEqual([flix.on_card, flix.amount, flix.charge], [true, 0, -1599]);
  assert.match(flix.note, /card repayment/i);
  assert.equal(balOn(f, '2026-10-14') - balOn(f, '2026-10-15'), 5000);
});

test('forecast: a split line not moved within three days of payday is treated as skipped', () => {
  const b = forecastBook();
  setPlan(b.db, { lines: [{ account_id: 'acct_t_savings', kind: 'saving', amount: 40000 }] });
  const f = forecast(b.db, { today: '2026-10-12' });
  assert.equal(f.items.find((i) => i.kind === 'split' && i.date === '2026-10-12'), undefined);
  assert.ok(f.assumptions.some((a) => /skipped/.test(a)));
});

test('forecast: a home loan on the pay split is taken off once, from its instalment dates', () => {
  const b = forecastBook();
  b.db.prepare("UPDATE accounts SET details_json = ? WHERE id = 'acct_t_loan'").run(JSON.stringify({
    lending_rate: '0.0599',
    loan_details: { repayment_type: 'PRINCIPAL_AND_INTEREST', repayment_frequency: 'P1M', next_instalment_date: '2026-10-29', loan_end_date: '2056-07-29' },
  }));
  transfer(b, PAY_ACCOUNT, 'acct_t_loan', '2026-09-29', 230000);
  setPlan(b.db, { lines: [{ account_id: 'acct_t_loan', kind: 'debt', amount: 230000 }] });
  refreshMoney(b, TODAY);
  const f = forecast(b.db, { today: TODAY });
  const loan = f.items.filter((i) => /loan/i.test(i.label));
  assert.deepEqual(loan.map((i) => [i.date, i.amount, i.kind]), [['2026-10-29', -230000, 'bill']]);
});

// ---- API ----
let srv, base, b;
before(async () => {
  b = forecastBook();
  const api = createApi({ db: b.db, engine: { refresh() {}, runAi() {} }, ai: null, dataDir: mkdtempSync(join(tmpdir(), 'mint-fc-')), log() {} });
  srv = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!(await api(req, res, url))) { res.writeHead(404); res.end('{}'); }
    } catch (e) {
      res.writeHead(e instanceof HttpError ? e.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv?.close());
const send = (method, p, body) => fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

test('GET /api/forecast answers, and an unavailable forecast is still a 200 with a reason', async () => {
  const r = await fetch(`${base}/api/forecast`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(typeof j.available === 'boolean');
  assert.equal(j.floor, 0);
});

test('PUT /api/forecast/floor stores the floor in cents; bad values are 400s', async () => {
  const ok = await send('PUT', '/api/forecast/floor', { floor: 25000 });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { floor: 25000 });
  assert.equal(getFloor(b.db), 25000);
  assert.equal((await (await fetch(`${base}/api/forecast`)).json()).floor, 25000);
  for (const bad of [{ floor: -5 }, { floor: 1.5 }, { floor: 'lots' }, {}]) assert.equal((await send('PUT', '/api/forecast/floor', bad)).status, 400, JSON.stringify(bad));
});

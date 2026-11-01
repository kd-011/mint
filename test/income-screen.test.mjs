// v2 screens: what the Income tab needs beyond the engine's report. Spend per
// pay cycle (for income vs spend and the savings rate), the recent "other money
// in" rows (so a payer can be re-classified from the screen), and a live
// preview of what an edited stream would do before it is saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payBook, refreshMoney, setCat, PAY_ACCOUNT } from './fixtures/pay.mjs';
import { listSources, updateSource, createSource, incomeReport, previewSource } from '../lib/income.mjs';

const TODAY = '2026-10-17';

function incomeBook() {
  const b = payBook();
  for (const d of ['2026-08-28', '2026-09-11', '2026-09-25', '2026-10-09']) b.add('acct_t_offset', d, 188216, 'PAYMENT FROM TEST PARENT & CO', { provider_category: 'INCOME' });
  b.add(PAY_ACCOUNT, '2026-10-10', 4500, 'ALEX SAMPLEPERSONdinner', { provider_category: 'INCOME' });
  b.add(PAY_ACCOUNT, '2026-10-11', 7500, 'JORDAN EXAMPLE padel', { provider_category: 'INCOME' });
  b.add(PAY_ACCOUNT, '2026-10-01', 30000, 'MR CASEY TESTHappy birthday from', { provider_category: 'INCOME' });
  b.add('acct_t_savings', '2026-09-30', 320, 'INTEREST', { provider_category: 'INCOME' });
  setCat(b, b.add('acct_t_card', '2026-10-08', -20000, 'TEST GROCER'), 'Groceries');
  setCat(b, b.add('acct_t_card', '2026-10-09', -12000, 'TEST BISTRO'), 'Eating out');
  setCat(b, b.add('acct_t_card', '2026-09-24', -50000, 'TEST GROCER'), 'Groceries');
  b.add('acct_t_biz', '2026-10-08', -99900, 'TEST SUPPLIER'); // business spend is not personal spend
  refreshMoney(b, TODAY);
  return b;
}

test('income report: every cycle carries personal spend net of reimbursements', () => {
  const b = incomeBook();
  const r = incomeReport(b.db, { today: TODAY });
  const open = r.by_cycle.at(-1);
  assert.equal(open.open, true);
  // 20000 groceries + 12000 eating out, less the 4500 and 7500 friends paid back (dinner -> Eating out), padel -> general offset.
  assert.equal(open.spent, 20000 + 12000 - 4500 - 7500);
  const prev = r.by_cycle.find((c) => c.start === '2026-09-23');
  assert.equal(prev.spent, 50000);
  for (const c of r.by_cycle) assert.equal(typeof c.spent, 'number');
});

test('income report lists the recent other money in so a payer can be re-classified', () => {
  const b = incomeBook();
  const r = incomeReport(b.db, { today: TODAY });
  assert.ok(Array.isArray(r.other_recent));
  const texts = r.other_recent.map((x) => x.description);
  assert.ok(texts.some((t) => /birthday/i.test(t)));
  assert.ok(texts.some((t) => /INTEREST/.test(t)));
  assert.ok(!texts.some((t) => /SALARY/.test(t)), 'salary is not other money in');
  const gift = r.other_recent.find((x) => /birthday/i.test(x.description));
  assert.deepEqual(Object.keys(gift).sort(), ['account', 'amount', 'date', 'description', 'id']);
  assert.ok(r.other_recent.length <= 12);
  // Newest first.
  const dates = r.other_recent.map((x) => x.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test('preview of an edited stream says what would move, and writes nothing', () => {
  const b = incomeBook();
  const reg = listSources(b.db).find((s) => s.kind === 'regular');
  const before = JSON.stringify(listSources(b.db));
  const p = previewSource(b.db, { kind: 'other' }, { id: reg.id, today: TODAY });
  assert.equal(p.matches, 4);
  assert.equal(p.rows_changing, 4);
  assert.deepEqual(p.moves, [{ from: 'regular', to: 'other', count: 4, total: 4 * 188216 }]);
  assert.equal(p.last_date, '2026-10-09');
  assert.ok(p.samples.length > 0 && p.samples.length <= 5);
  assert.equal(JSON.stringify(listSources(b.db)), before);
  assert.equal(b.db.prepare("SELECT count(*) n FROM transactions WHERE income_kind = 'regular'").get().n, 4);
});

test('preview of a new stream from an unmatched payer counts the rows it would claim', () => {
  const b = incomeBook();
  const p = previewSource(b.db, { name: 'Interest', kind: 'other', match: 'contains', pattern: 'INTEREST' }, { today: TODAY });
  assert.equal(p.matches, 1);
  assert.equal(p.rows_changing, 0, 'it is already other money in');
  const q = previewSource(b.db, { name: 'Birthday', kind: 'regular', match: 'contains', pattern: 'birthday' }, { today: TODAY });
  assert.deepEqual(q.moves, [{ from: 'other', to: 'regular', count: 1, total: 30000 }]);
});

test('preview rejects what saving would reject, and skips rows the owner pinned by hand', () => {
  const b = incomeBook();
  assert.throws(() => previewSource(b.db, { name: 'x', kind: 'nonsense', pattern: 'a' }, { today: TODAY }), (e) => e.status === 400);
  assert.throws(() => previewSource(b.db, { kind: 'other' }, { id: 99999, today: TODAY }), (e) => e.status === 404);
  const reg = listSources(b.db).find((s) => s.kind === 'regular');
  const row = b.db.prepare("SELECT id FROM transactions WHERE income_source_id = ? ORDER BY date LIMIT 1").get(reg.id).id;
  b.db.prepare("UPDATE transactions SET income_manual = 1 WHERE id = ?").run(row);
  const p = previewSource(b.db, { kind: 'other' }, { id: reg.id, today: TODAY });
  assert.equal(p.rows_changing, 3);
  assert.equal(p.pinned, 1);
});

test('the real edit agrees with the preview', () => {
  const b = incomeBook();
  const reg = listSources(b.db).find((s) => s.kind === 'regular');
  const p = previewSource(b.db, { kind: 'reimbursement' }, { id: reg.id, today: TODAY });
  updateSource(b.db, reg.id, { kind: 'reimbursement' });
  const now = b.db.prepare("SELECT count(*) n FROM transactions WHERE income_source_id = ? AND income_kind = 'reimbursement'").get(reg.id).n;
  assert.equal(now, p.matches);
});

// Cashflow forecast maths, pure: WA public holidays, payday shifting, the
// baseline daily spend and its spread, and the day by day projection with its
// range band, lowest point and floor check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { easterSunday, waHolidays, isBusinessDay, prevBusinessDay, upcomingPaydays, baselineFromDaily, projectCashflow } from '../lib/forecastmath.mjs';

test('easter sunday is computed, not tabled', () => {
  assert.equal(easterSunday(2026), '2026-04-05');
  assert.equal(easterSunday(2027), '2027-03-28');
  assert.equal(easterSunday(2024), '2024-03-31');
});

test('WA public holidays: fixed, Easter, first and last Mondays, weekend substitutes', () => {
  const h26 = waHolidays(2026);
  for (const d of ['2026-01-01', '2026-01-26', '2026-03-02', '2026-04-03', '2026-04-05', '2026-04-06', '2026-06-01', '2026-09-28', '2026-12-25', '2026-12-28']) assert.ok(h26.has(d), d);
  // Anzac Day 2026 is a Saturday: WA gives no substitute day.
  assert.ok(!h26.has('2026-04-27'));
  // 26 Jan 2025 was a Sunday, so Monday the 27th stands in.
  assert.ok(waHolidays(2025).has('2025-01-27'));
  // Anzac Day 2027 is a Sunday, so Monday the 26th stands in.
  assert.ok(waHolidays(2027).has('2027-04-26'));
  // Christmas 2027 is a Saturday and Boxing Day a Sunday: Monday and Tuesday.
  assert.ok(waHolidays(2027).has('2027-12-27') && waHolidays(2027).has('2027-12-28'));
});

test('business days skip weekends and holidays', () => {
  assert.equal(isBusinessDay('2026-10-16'), true); // Friday
  assert.equal(isBusinessDay('2026-10-17'), false); // Saturday
  assert.equal(isBusinessDay('2026-09-28'), false); // King's Birthday, a Monday
  assert.equal(prevBusinessDay('2026-10-17'), '2026-10-16');
  assert.equal(prevBusinessDay('2026-09-28'), '2026-09-25');
  assert.equal(prevBusinessDay('2026-10-16'), '2026-10-16');
});

test('payday on a weekend lands the Friday before', () => {
  const [p] = upcomingPaydays({ last: '2026-10-03', cadence: 14, today: '2026-10-12', until: '2026-11-10' });
  assert.deepEqual([p.nominal, p.date, p.shifted, p.late], ['2026-10-17', '2026-10-16', true, false]);
});

test('payday on a public holiday lands the business day before', () => {
  const [p] = upcomingPaydays({ last: '2026-09-14', cadence: 14, today: '2026-09-20', until: '2026-10-10' });
  assert.deepEqual([p.nominal, p.date], ['2026-09-28', '2026-09-25']);
});

test('payday after a weekend and holidays walks back over all of them', () => {
  // Fri 25 Dec, Sat 26 Dec and Mon 28 Dec (Boxing Day substitute) are not business days.
  const [p] = upcomingPaydays({ last: '2026-12-14', cadence: 14, today: '2026-12-15', until: '2026-12-31' });
  assert.deepEqual([p.nominal, p.date], ['2026-12-28', '2026-12-24']);
});

test('paydays repeat on the cadence inside the window, and an ordinary day is not shifted', () => {
  const ps = upcomingPaydays({ last: '2026-10-07', cadence: 14, today: '2026-10-08', until: '2026-11-07' });
  assert.deepEqual(ps.map((p) => p.date), ['2026-10-21', '2026-11-04']);
  assert.deepEqual(ps.map((p) => p.shifted), [false, false]);
});

test('a payday that should have landed already is late and counted for today', () => {
  const [p, q] = upcomingPaydays({ last: '2026-09-23', cadence: 14, today: '2026-10-09', until: '2026-10-30' });
  assert.deepEqual([p.nominal, p.date, p.late], ['2026-10-07', '2026-10-09', true]);
  assert.deepEqual([q.nominal, q.late], ['2026-10-21', false]);
});

test('baseline: mean and spread of daily spend, one-off spikes capped at the 95th percentile', () => {
  const flat = baselineFromDaily(Array(56).fill(5000));
  assert.deepEqual([flat.daily, flat.sd, flat.days], [5000, 0, 56]);
  const spiky = baselineFromDaily([...Array(55).fill(5000), 900000]);
  assert.ok(spiky.daily < 6000, `one-off should not drag the baseline: ${spiky.daily}`);
  assert.ok(spiky.capped >= 1);
  assert.deepEqual(baselineFromDaily([]), { daily: 0, sd: 0, days: 0, cap: 0, capped: 0 });
});

const base = { today: '2026-10-08', balance: 100000, days: 10, floor: 0, baseline: { daily: 0, sd: 0 } };

test('projection: no events and no baseline is a flat line, one point per day from today', () => {
  const p = projectCashflow({ ...base, events: [] });
  assert.equal(p.days.length, 11);
  assert.deepEqual([p.days[0].date, p.days.at(-1).date], ['2026-10-08', '2026-10-18']);
  assert.ok(p.days.every((d) => d.balance === 100000 && d.low === 100000 && d.high === 100000));
  assert.equal(p.status, 'ok');
});

test('projection: baseline spend comes off every day, today only for what is left of it', () => {
  const p = projectCashflow({ ...base, baseline: { daily: 1000, sd: 0 }, spentToday: 400, events: [] });
  assert.deepEqual(p.days.slice(0, 3).map((d) => d.balance), [99400, 98400, 97400]);
  const over = projectCashflow({ ...base, baseline: { daily: 1000, sd: 0 }, spentToday: 5000, events: [] });
  assert.equal(over.days[0].balance, 100000);
});

test('projection: a bill due before pay dips the line, then pay lifts it', () => {
  const p = projectCashflow({
    ...base, balance: 50000, floor: 0, next_payday: '2026-10-13',
    events: [
      { date: '2026-10-10', amount: -60000, label: 'Rent', kind: 'bill' },
      { date: '2026-10-13', amount: 250000, label: 'Salary', kind: 'income' },
    ],
  });
  assert.deepEqual([p.lowest.date, p.lowest.balance, p.lowest.before_payday], ['2026-10-10', -10000, true]);
  assert.equal(p.status, 'breach');
  assert.equal(p.first_breach, '2026-10-10');
  assert.equal(p.days.find((d) => d.date === '2026-10-13').balance, 240000);
  const rent = p.items.find((i) => i.label === 'Rent');
  assert.equal(rent.balance_after, -10000);
  assert.deepEqual(p.items.map((i) => i.label), ['Rent', 'Salary']);
});

test('projection: the floor is the line, not zero', () => {
  const ev = [{ date: '2026-10-10', amount: -30000, label: 'Bill', kind: 'bill' }];
  assert.equal(projectCashflow({ ...base, balance: 50000, floor: 10000, events: ev }).status, 'ok');
  const hit = projectCashflow({ ...base, balance: 50000, floor: 25000, events: ev });
  assert.equal(hit.status, 'breach');
  assert.equal(hit.first_breach, '2026-10-10');
});

test('projection: staying above the floor on the middle line but not the band is a possible dip', () => {
  const p = projectCashflow({ ...base, balance: 30000, baseline: { daily: 1000, sd: 1500 }, events: [] });
  // Last day middle: 30000 - 11 * 1000 = 19000; band: 1500 * sqrt(11) = 4975.
  assert.equal(p.status, 'ok');
  const tight = projectCashflow({ ...base, balance: 12000, baseline: { daily: 1000, sd: 1500 }, events: [] });
  assert.equal(tight.status, 'possible');
  assert.ok(tight.days.at(-1).balance > 0 && tight.days.at(-1).low < 0);
});

test('projection: the range band widens with the days of spending, and is zero with no spread', () => {
  const p = projectCashflow({ ...base, baseline: { daily: 1000, sd: 1000 }, events: [] });
  assert.equal(p.days[0].high - p.days[0].balance, p.days[0].balance - p.days[0].low);
  assert.ok(p.days[5].high - p.days[5].low > p.days[1].high - p.days[1].low);
  assert.equal(Math.round((p.days[3].high - p.days[3].balance) ** 2), Math.round(4 * 1000 ** 2));
});

test('projection: lowest point says if it falls after payday, and the lowest before payday is kept apart', () => {
  const p = projectCashflow({ ...base, balance: 10000, next_payday: '2026-10-09', events: [
    { date: '2026-10-09', amount: 50000, label: 'Salary', kind: 'income' },
    { date: '2026-10-15', amount: -55000, label: 'Insurance', kind: 'bill' },
  ] });
  assert.deepEqual([p.lowest.date, p.lowest.before_payday], ['2026-10-15', false]);
  assert.equal(p.lowest_before_payday.date, '2026-10-08');
});

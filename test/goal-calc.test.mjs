// The goal editor's calculator (public/goal-calc.js): date to amount, amount to date,
// three frequencies, saved balance, target met, the 10 year cap, month ends, round trips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { GoalCalc: G } = createRequire(import.meta.url)(join(ROOT, 'public', 'goal-calc.js'));
const T = '2026-10-22';
const base = { today: T, target: 500000, saved: 0 };

test('fortnightly date to amount matches the server per_cycle_needed (ceil(days / 14), ceil(remaining / cycles))', () => {
  const r = G.solve({ ...base, freq: 'fortnightly', driver: 'date', date: '2028-10-03' });
  assert.equal(r.status, 'ok');
  assert.equal(r.periods, Math.ceil(G.daysBetween(T, '2028-10-03') / 14));
  assert.equal(r.amount, Math.ceil(500000 / r.periods));
  assert.equal(r.periods, 51);
});

test('weekly and monthly date to amount', () => {
  const w = G.solve({ ...base, freq: 'weekly', driver: 'date', date: '2027-10-21' });
  assert.equal(w.periods, 52, '364 days is exactly 52 weeks');
  assert.equal(G.solve({ ...base, freq: 'weekly', driver: 'date', date: '2027-10-22' }).periods, 53);
  assert.equal(w.amount, Math.ceil(500000 / 52));
  const m = G.solve({ ...base, freq: 'monthly', driver: 'date', date: '2027-10-22' });
  assert.equal(m.periods, 12);
  assert.equal(m.amount, Math.ceil(500000 / 12));
  const part = G.solve({ ...base, freq: 'monthly', driver: 'date', date: '2027-10-23' });
  assert.equal(part.periods, 13, 'one day past the 12th month needs a 13th payment');
});

test('amount to date for each frequency', () => {
  assert.deepEqual(['weekly', 'fortnightly', 'monthly'].map((freq) => {
    const r = G.solve({ ...base, freq, driver: 'amount', amount: 50000 });
    return [r.status, r.periods, r.date];
  }), [['ok', 10, '2026-12-31'], ['ok', 10, '2027-03-11'], ['ok', 10, '2027-08-22']]);
});

test('saved balance counts toward the target', () => {
  const r = G.solve({ ...base, saved: 200000, freq: 'monthly', driver: 'amount', amount: 50000 });
  assert.equal(r.remaining, 300000);
  assert.equal(r.periods, 6);
  assert.equal(r.date, '2027-04-22');
  const d = G.solve({ ...base, saved: 200000, freq: 'monthly', driver: 'date', date: '2027-04-22' });
  assert.equal(d.amount, 50000);
});

test('target already met, and no usable target', () => {
  assert.equal(G.solve({ ...base, saved: 500000, freq: 'weekly', driver: 'date', date: '2027-01-01' }).status, 'met');
  assert.equal(G.solve({ ...base, saved: 900000, freq: 'weekly' }).status, 'met');
  assert.equal(G.solve({ ...base, target: null, freq: 'weekly' }).status, 'none');
  assert.equal(G.solve({ ...base, target: 0, freq: 'weekly' }).status, 'none');
});

test('nothing driven yet prompts; a date today or earlier is past', () => {
  assert.equal(G.solve({ ...base, freq: 'weekly' }).status, 'prompt');
  assert.equal(G.solve({ ...base, freq: 'weekly', driver: 'amount', amount: null }).status, 'prompt');
  assert.equal(G.solve({ ...base, freq: 'weekly', driver: 'date', date: T }).status, 'past');
  assert.equal(G.solve({ ...base, freq: 'weekly', driver: 'date', date: '2025-01-01' }).status, 'past');
});

test('a tiny amount that needs more than 10 years is beyond, a bigger one is not', () => {
  const tiny = G.solve({ ...base, freq: 'fortnightly', driver: 'amount', amount: 100 });
  assert.equal(tiny.status, 'beyond');
  assert.equal(tiny.date, undefined);
  assert.equal(G.solve({ ...base, freq: 'monthly', driver: 'amount', amount: 4166 }).status, 'beyond', '121 payments');
  assert.equal(G.solve({ ...base, freq: 'monthly', driver: 'amount', amount: 4167 }).status, 'ok', '120 payments lands exactly on the cap');
});

test('month ends clamp the way the detail sheet does', () => {
  assert.equal(G.dateAfter('monthly', '2027-01-31', 1), '2027-02-28');
  assert.equal(G.dateAfter('monthly', '2028-01-31', 1), '2028-02-29');
  assert.equal(G.periodsTo('monthly', '2027-01-31', '2027-02-28'), 1);
  assert.equal(G.periodsTo('monthly', '2027-01-31', '2027-03-01'), 2);
  assert.equal(G.periodsTo('monthly', '2027-01-31', '2027-03-31'), 2);
});

test('round trip: amount to date to amount never asks for more, and stays within one payment of the target', () => {
  for (const freq of G.FREQ_KEYS) {
    for (const target of [100000, 500000, 1234567]) {
      for (const amount of [2500, 9999, 19000, 50000, 123456]) {
        const fwd = G.solve({ today: T, saved: 0, target, freq, driver: 'amount', amount });
        if (fwd.status !== 'ok') continue;
        const back = G.solve({ today: T, saved: 0, target, freq, driver: 'date', date: fwd.date });
        assert.equal(back.periods, fwd.periods, `${freq} ${target} ${amount}`);
        assert.ok(back.amount <= amount, `${freq} ${target} ${amount}: ${back.amount}`);
        assert.ok(back.amount * back.periods >= target && back.amount * back.periods - target < back.periods, 'rounding is under a cent per payment');
        assert.ok(amount * fwd.periods - target < amount, 'overshoots by less than one payment');
      }
    }
  }
});

test('date slider runs tomorrow to ten years out', () => {
  const d = G.dateSlider(T);
  assert.equal(d.min, 1);
  assert.equal(G.dateAtDay(T, d.min), '2026-10-23');
  assert.equal(G.dateAtDay(T, d.max), '2036-10-22');
  assert.equal(G.dayOfDate(T, '2040-01-01'), d.max, 'clamps past the end');
  assert.equal(G.dayOfDate(T, '2026-10-30'), 8);
});

test('amount ladder scales with the remainder and the frequency, in tidy rungs', () => {
  const w = G.amountLadder('weekly', T, 500000);
  const m = G.amountLadder('monthly', T, 500000);
  assert.ok(w[0] < m[0], 'weekly starts lower than monthly');
  assert.equal(w.at(-1), 500000, 'the top rung pays it all at once');
  assert.ok(w.every((v, i) => i === 0 || v > w[i - 1]));
  assert.ok(w.length > 50 && w.length < 1500);
  assert.ok(G.amountLadder('weekly', T, 5000000)[0] > w[0], 'a bigger target starts higher');
  assert.deepEqual(G.amountLadder('weekly', T, 0), []);
  const tiny = G.amountLadder('monthly', T, 100);
  assert.ok(tiny.length >= 2 && tiny[0] >= 100);
  assert.equal(G.rungOf(w, w[7] + 1), 7);
  assert.equal(G.rungOf(w, 1e9), w.length - 1);
});

test('until words', () => {
  assert.equal(G.untilWords(T, '2026-10-23'), 'in 1 day');
  assert.equal(G.untilWords(T, '2026-11-05'), 'in 2 weeks');
  assert.equal(G.untilWords(T, '2027-12-22'), 'in 14 months');
  assert.equal(G.untilWords(T, '2029-01-22'), 'in 2 years 3 months');
  assert.equal(G.untilWords(T, T), '');
});

test('result line reads in plain words', () => {
  const fmt = (c) => `$${c / 100}`;
  const say = (o) => G.plainWords(G.resultWords(G.solve({ ...base, ...o }), fmt)).replaceAll('\u00a0', ' ');
  assert.equal(say({ freq: 'fortnightly', driver: 'amount', amount: 19000 }), '$190 a fortnight gets you there by 4 Nov 2027, 27 payments.');
  assert.equal(say({ freq: 'weekly', driver: 'amount', amount: 500000 }), '$5000 a week gets you there by 29 Oct 2026, 1 payment.');
  assert.equal(say({ freq: 'weekly', saved: 600000 }), 'Target already met, $6000 saved.');
  assert.equal(say({ freq: 'weekly' }), 'Pick a date or an amount and the other follows.');
  assert.equal(say({ freq: 'fortnightly', driver: 'amount', amount: 100 }), 'More than 10 years at $1 a fortnight.');
  assert.equal(say({ freq: 'weekly', driver: 'date', date: '2020-01-01' }), '');
  assert.equal(say({ freq: 'weekly', target: null }), '');
});

test('no em dashes in the module', async () => {
  const { readFileSync } = await import('node:fs');
  assert.ok(!readFileSync(join(ROOT, 'public', 'goal-calc.js'), 'utf8').includes('—'));
});

// Review of e5e5053, bug 1: switching frequency read the typed figure in the new unit.
test('switching frequency keeps the same money per day, whatever the status', () => {
  const day = (cents, freq) => cents / (G.FREQS[freq].days ?? G.daysBetween(T, G.dateAfter('monthly', T, 1)));
  const sw0 = (o) => G.switchFreq({ ...base, today: T, ...o });
  // beyond: $1 a fortnight is more than 10 years
  const beyond = sw0({ freq: 'fortnightly', to: 'weekly', driver: 'amount', amount: 100 });
  assert.equal(G.solve({ ...base, freq: 'fortnightly', driver: 'amount', amount: 100 }).status, 'beyond');
  assert.equal(beyond.driver, 'amount');
  assert.equal(beyond.amount, 50, '$1 a fortnight is 50c a week, not $1 a week');
  // a $500k target makes $50 a fortnight a 10 year plan too
  const sw = (o) => G.switchFreq({ ...base, target: 50000000, today: T, ...o });
  assert.equal(G.solve({ ...base, target: 50000000, freq: 'fortnightly', driver: 'amount', amount: 5000 }).status, 'beyond');
  const f2w = sw({ freq: 'fortnightly', to: 'weekly', driver: 'amount', amount: 5000 });
  assert.equal(f2w.amount, 2500);
  const w2f = sw({ freq: 'weekly', to: 'fortnightly', driver: 'amount', amount: 2500 });
  assert.equal(w2f.amount, 5000);
  const f2m = sw({ freq: 'fortnightly', to: 'monthly', driver: 'amount', amount: 5000 });
  assert.ok(Math.abs(f2m.amount - day(5000, 'fortnightly') * G.daysBetween(T, '2026-11-22')) <= 0.5, 'same per day to the cent');
  assert.ok(f2m.amount > 5000);
  // the plan keeps its meaning: same finish date either side of the switch (beyond stays beyond)
  const back = sw({ freq: 'weekly', to: 'fortnightly', driver: 'amount', amount: f2w.amount });
  assert.equal(back.amount, 5000);
  assert.equal(G.solve({ ...base, target: 50000000, freq: 'fortnightly', driver: 'amount', amount: back.amount }).status, 'beyond');
});

test('switching frequency with a good plan pins the date and the amount follows', () => {
  const ok = G.solve({ ...base, freq: 'fortnightly', driver: 'amount', amount: 19000 });
  assert.equal(ok.status, 'ok');
  const s = G.switchFreq({ ...base, today: T, freq: 'fortnightly', to: 'weekly', driver: 'amount', amount: 19000, date: ok.date });
  assert.equal(s.driver, 'date');
  const r = G.solve({ ...base, freq: 'weekly', driver: s.driver, date: ok.date, amount: s.amount });
  assert.equal(r.date, ok.date);
});

test('switching frequency leaves a date driver and an empty amount alone', () => {
  assert.deepEqual(G.switchFreq({ ...base, today: T, freq: 'weekly', to: 'monthly', driver: 'date', date: '2028-01-01', amount: 4000 }), { driver: 'date', amount: 4000 });
  assert.deepEqual(G.switchFreq({ ...base, today: T, freq: 'weekly', to: 'monthly', driver: 'amount', amount: null }), { driver: 'amount', amount: null });
});

// Review of e5e5053, bug 2: an amount-driven editor wiped the date it did not need to compute.
test('amount driver only writes a date when it computed one, and clears it only when none can exist', () => {
  const s = (o) => G.dateFromAmount(G.solve({ ...base, freq: 'fortnightly', driver: 'amount', amount: 19000, ...o }));
  assert.equal(s({}), '2027-11-04', 'ok: the computed finish');
  assert.equal(s({ amount: 100 }), '', 'beyond: no date can exist');
  assert.equal(s({ target: null }), null, 'target cleared: leave the date alone');
  assert.equal(s({ saved: 600000 }), null, 'target met: leave the date alone');
  assert.equal(s({ amount: null }), null, 'no amount: leave the date alone');
});

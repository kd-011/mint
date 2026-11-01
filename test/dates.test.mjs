import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoneDate, addDays, oldestAllowedFrom, fmtDMY, monthStart } from '../lib/dates.mjs';

test('zoneDate rolls over at Perth midnight, not UTC', () => {
  assert.equal(zoneDate(new Date('2026-10-16T15:59:00Z')), '2026-10-16');
  assert.equal(zoneDate(new Date('2026-10-16T16:30:00Z')), '2026-10-17');
});

test('addDays crosses months and years', () => {
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('oldestAllowedFrom is seven years back plus a week of margin', () => {
  assert.equal(oldestAllowedFrom('2026-10-17'), '2019-10-24');
  assert.equal(oldestAllowedFrom('2028-02-29'), '2021-03-07'); // 28/02/2021 plus 7 days
});

test('fmtDMY shows DD/MM/YYYY', () => {
  assert.equal(fmtDMY('2026-10-07'), '07/10/2026');
  assert.equal(fmtDMY(null), '');
});

test('monthStart', () => {
  assert.equal(monthStart('2026-10-17'), '2026-10-01');
});

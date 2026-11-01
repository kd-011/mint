// The tax return estimate over a book: detected salary reversed through the
// Schedule 1 scale and projected to 30 June, interest and business income from
// the feed, tagged deductions, and the owner's entered figures overriding all of it.
// Invented data only. Today is 17/10/2026 (FY2027, 7 fortnightly pays so far).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payBook, refreshMoney, setCat, PAY_AMOUNTS, PAYDAYS, PAY_ACCOUNT } from './fixtures/pay.mjs';
import { taxReturnEstimate, packEstimate } from '../lib/taxestimate.mjs';
import { setTaxInputs, setTaxTag, getTaxInputs } from '../lib/tax.mjs';
import { grossFromNet, computeReturn } from '../lib/taxcalc.mjs';
import { addDays } from '../lib/dates.mjs';
import { taxEstimate, taxReport } from '../lib/assistant.mjs';

const TODAY = '2026-10-17';
const FY = 2027;

function estBook() {
  const b = payBook();
  // Interest: two on the savings account, one on the offset, one on everyday, one last FY.
  setCat(b, b.add('acct_t_savings', '2026-10-01', 1234, 'INTEREST PAID', { provider_category: 'INTEREST' }), 'Interest');
  setCat(b, b.add('acct_t_savings', '2026-09-30', 1000, 'INTEREST PAID', { provider_category: 'INTEREST' }), 'Interest');
  setCat(b, b.add('acct_t_offset', '2026-10-02', 50, 'INTEREST PAID', { provider_category: 'INTEREST' }), 'Interest');
  setCat(b, b.add(PAY_ACCOUNT, '2026-10-03', 777, 'INTEREST PAID', { provider_category: 'INTEREST' }), 'Interest');
  setCat(b, b.add('acct_t_savings', '2026-06-30', 999, 'INTEREST PAID', { provider_category: 'INTEREST' }), 'Interest');
  // Business: $1,000 in, $300 out. Personal spend must not leak in.
  b.add('acct_t_biz', '2026-09-10', 100000, 'TEST CLIENT INVOICE', { provider_category: 'INCOME' });
  b.add('acct_t_biz', '2026-09-12', -30000, 'TEST SUPPLIER');
  b.add('acct_t_card', '2026-09-13', -9999, 'TEST GROCER');
  refreshMoney(b, TODAY);
  return b;
}

const fortnights = (from, to) => { let n = 0; for (let d = addDays(from, 14); d <= to; d = addDays(d, 14)) n += 1; return n; };
const gross = (net) => grossFromNet(FY, net, 'fortnightly');
const medianNet = (225000 + 226000) / 2; // the last four pays are 230000, 220000, 225000, 226000
const ytdGross = PAY_AMOUNTS.reduce((s, n) => s + gross(n), 0);
const ytdWithheld = PAY_AMOUNTS.reduce((s, n) => s + gross(n) - n, 0);
const remaining = fortnights(PAYDAYS.at(-1), '2027-06-30');

test('nothing entered: salary is reversed pay by pay through Schedule 1 and projected to 30 June', () => {
  const b = estBook();
  const e = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  assert.equal(e.status, 'ok');
  assert.equal(e.salary.ytd.pays, 7);
  assert.equal(e.salary.ytd.gross, ytdGross);
  assert.equal(e.salary.ytd.withheld, ytdWithheld);
  assert.equal(e.salary.projection.pays_remaining, remaining);
  assert.equal(e.salary.gross.amount, ytdGross + remaining * gross(medianNet));
  assert.equal(e.salary.withheld.amount, ytdWithheld + remaining * (gross(medianNet) - medianNet));
  assert.equal(e.salary.gross.source, 'estimated');
  assert.equal(e.salary.withheld.source, 'estimated');
  assert.equal(e.confidence.level, 'low');
  assert.match(e.confidence.reasons.join(' '), /net pay/i);
});

test('the working adds up: income, deductions, taxable income, each tax line, result', () => {
  const b = estBook();
  const e = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  const income = e.income.salary.amount + e.income.interest.amount + e.income.business.amount + e.income.other.amount;
  assert.equal(e.income.total, income);
  assert.equal(e.taxable_income, Math.max(0, income - e.deductions.total) - (Math.max(0, income - e.deductions.total) % 100));
  const again = computeReturn(FY, {
    salary: e.income.salary.amount, interest: e.income.interest.amount, business: e.income.business.amount, other: e.income.other.amount,
    deductions: e.deductions.total, d12: 0, withheld: e.withheld.amount, private_health: null, has_help: null,
  });
  for (const k of ['income_tax', 'lito', 'medicare', 'mls', 'help', 'tax_payable', 'result']) assert.equal(e.tax[k], again[k], k);
  assert.equal(e.result, e.withheld.amount - e.tax.tax_payable);
  assert.equal(e.headline.kind, e.result > 0 ? 'refund' : e.result < 0 ? 'owing' : 'even');
  assert.equal(e.headline.amount, Math.abs(e.result));
});

test('interest counts only what was paid in, on personal accounts, in this FY', () => {
  const b = estBook();
  const e = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  assert.equal(e.income.interest.ytd, 1234 + 1000 + 50 + 777);
  assert.equal(e.income.interest.source, 'estimated'); // projected to 30 June
  assert.ok(e.income.interest.amount > e.income.interest.ytd);
  const last = taxReturnEstimate(b.db, { fy: 2026, today: TODAY });
  assert.equal(last.income.interest.ytd, 999);
  assert.equal(last.income.interest.amount, 999, 'a finished year is not projected');
});

test('business net income comes from the business flags, to date, not projected', () => {
  const b = estBook();
  const e = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  assert.equal(e.income.business.amount, 100000 - 30000);
  assert.equal(e.income.business.source, 'feed');
});

test('deductions: tagged D items for the FY, by code; business labels and business-account rows are left out', () => {
  const b = estBook();
  const d5 = b.add(PAY_ACCOUNT, '2026-08-02', -20000, 'TEST OFFICE SUPPLIES');
  const d9 = b.add(PAY_ACCOUNT, '2026-08-03', -5000, 'TEST CHARITY');
  const old = b.add(PAY_ACCOUNT, '2026-05-03', -7000, 'TEST LAST YEAR');
  const bus = b.add(PAY_ACCOUNT, '2026-08-04', -3000, 'TEST BUSINESS LABEL');
  const bizAcct = b.add('acct_t_biz', '2026-08-05', -4000, 'TEST BIZ DOUBLE COUNT');
  setTaxTag(b.db, d5, { ato_category: 'D5', deductible_amount: 12000 });
  setTaxTag(b.db, d9, { ato_category: 'D9' });
  setTaxTag(b.db, old, { ato_category: 'D5' });
  setTaxTag(b.db, bus, { ato_category: 'BUS_OTHER' });
  setTaxTag(b.db, bizAcct, { ato_category: 'D5' });
  const e = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  assert.deepEqual(e.deductions.by_code.map((d) => [d.code, d.amount]), [['D5', 12000], ['D9', 5000]]);
  assert.equal(e.deductions.tagged, 17000);
  assert.equal(e.deductions.total, 17000);
  assert.equal(e.deductions.source, 'feed');
});

test('entered figures win: gross and withheld entered replace the net-pay estimate, projected by pay count', () => {
  const b = estBook();
  setTaxInputs(b.db, FY, { gross_salary: 2200000, tax_withheld: 450000, as_at: TODAY });
  const e = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  assert.equal(e.salary.gross.source, 'entered');
  assert.equal(e.salary.withheld.source, 'entered');
  assert.equal(e.salary.ytd.gross, 2200000);
  assert.equal(e.salary.ytd.withheld, 450000);
  assert.equal(e.salary.gross.amount, Math.round((2200000 * (7 + remaining)) / 7));
  assert.equal(e.salary.withheld.amount, Math.round((450000 * (7 + remaining)) / 7));
  assert.equal(e.confidence.level, 'high');
  assert.equal(e.salary.as_at, TODAY);
});

test('entered figures at the end of a finished year are taken as the whole year, no projection', () => {
  const b = estBook();
  setTaxInputs(b.db, 2026, { gross_salary: 9000000, tax_withheld: 1900000, as_at: '2026-06-30' });
  const e = taxReturnEstimate(b.db, { fy: 2026, today: TODAY });
  assert.equal(e.salary.gross.amount, 9000000);
  assert.equal(e.salary.withheld.amount, 1900000);
  assert.equal(e.status, 'ok');
  assert.equal(e.salary.projection.pays_remaining, 0);
});

test('only one of the pair entered: the other stays an estimate and each line says which it is', () => {
  const b = estBook();
  setTaxInputs(b.db, FY, { tax_withheld: 700000 });
  const withheldOnly = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  assert.equal(withheldOnly.salary.withheld.source, 'entered');
  assert.equal(withheldOnly.salary.gross.source, 'estimated');
  assert.equal(withheldOnly.salary.gross.amount, ytdGross + remaining * gross(medianNet));
  setTaxInputs(b.db, FY, { tax_withheld: null, gross_salary: 2000000, as_at: TODAY });
  const grossOnly = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  assert.equal(grossOnly.salary.gross.source, 'entered');
  assert.equal(grossOnly.salary.withheld.source, 'estimated');
  assert.ok(grossOnly.salary.withheld.amount > 0);
  assert.match(grossOnly.confidence.reasons.join(' '), /withheld/i);
});

test('entered other income and extra deductions are added and labelled entered', () => {
  const b = estBook();
  const before = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  setTaxInputs(b.db, FY, { other_income: 150000, extra_deductions: 40000 });
  const e = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  assert.equal(e.income.other.amount, 150000);
  assert.equal(e.income.other.source, 'entered');
  assert.equal(e.deductions.extra, 40000);
  assert.equal(e.deductions.total, before.deductions.total + 40000);
  assert.equal(e.income.total, before.income.total + 150000);
});

test('hospital cover and HELP: unknown assumes cover and no debt and shows the swing; known is applied', () => {
  const b = estBook();
  setTaxInputs(b.db, FY, { gross_salary: 4000000, tax_withheld: 800000, as_at: TODAY });
  const unknown = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  assert.ok(unknown.income.salary.amount > 123000_00, 'projected salary is in a surcharge tier');
  assert.equal(unknown.tax.mls, 0);
  assert.equal(unknown.tax.help, 0);
  assert.ok(unknown.swings.find((s) => s.key === 'private_health').amount > 0);
  assert.ok(unknown.swings.find((s) => s.key === 'has_help').amount > 0);
  assert.deepEqual(unknown.assumptions.map((a) => a.key).filter((k) => ['private_health', 'has_help'].includes(k)).sort(), ['has_help', 'private_health']);
  setTaxInputs(b.db, FY, { private_health: false, has_help: true });
  const known = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  assert.ok(known.tax.mls > 0);
  assert.ok(known.tax.help > 0);
  assert.equal(known.swings.length, 0);
  assert.equal(known.result, unknown.result - known.tax.mls - known.tax.help);
  setTaxInputs(b.db, FY, { private_health: true, has_help: false });
  const none = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  assert.equal(none.tax.mls, 0);
  assert.equal(none.result, unknown.result);
});

test('a HELP balance entered without the yes/no counts as yes', () => {
  const b = estBook();
  setTaxInputs(b.db, FY, { gross_salary: 4000000, tax_withheld: 800000, as_at: TODAY, help_debt: 100000 });
  const e = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  assert.equal(e.tax.help, 100000, 'capped at the balance');
  assert.equal(e.swings.find((s) => s.key === 'has_help'), undefined);
});

test('inputs: as_at is a date, has_help a boolean, both clearable', () => {
  const b = estBook();
  setTaxInputs(b.db, FY, { as_at: '2026-10-10', has_help: true });
  assert.deepEqual([getTaxInputs(b.db, FY).as_at, getTaxInputs(b.db, FY).has_help], ['2026-10-10', true]);
  assert.throws(() => setTaxInputs(b.db, FY, { as_at: '10/10/2026' }), /as_at/);
  assert.throws(() => setTaxInputs(b.db, FY, { has_help: 'yes' }), /has_help/);
  setTaxInputs(b.db, FY, { as_at: null, has_help: null });
  assert.equal(getTaxInputs(b.db, FY).as_at, null);
});

test('no salary found and nothing entered: says so instead of a refund of nothing', () => {
  const b = payBook({ paydays: [] });
  refreshMoney(b, TODAY);
  const e = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  assert.equal(e.status, 'no_data');
  assert.equal(e.salary.gross.amount, 0);
  assert.match(e.message, /salary/i);
  assert.ok(Array.isArray(e.lines));
});

test('a year without verified tables is declined plainly', () => {
  const b = estBook();
  const e = taxReturnEstimate(b.db, { fy: 2020, today: TODAY });
  assert.equal(e.status, 'unsupported');
  assert.match(e.message, /2026/);
  assert.equal(e.result, null);
});

test('a salary that has stopped is not projected past the last pay', () => {
  const b = payBook({ paydays: ['2026-07-15', '2026-07-29', '2026-08-12'], amounts: [250000] });
  refreshMoney(b, TODAY);
  const e = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  assert.equal(e.salary.projection.pays_remaining, 0);
  assert.match(e.confidence.reasons.join(' '), /last pay/i);
});

test('every line of the working says whether it was entered, estimated, from the feed or calculated', () => {
  const b = estBook();
  const e = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  assert.ok(e.lines.length >= 8);
  for (const l of e.lines) {
    assert.ok(['entered', 'estimated', 'feed', 'calculated'].includes(l.source), `${l.key}: ${l.source}`);
    assert.equal(typeof l.label, 'string');
    assert.ok(Number.isInteger(l.amount), l.key);
  }
  const keys = e.lines.map((l) => l.key);
  for (const k of ['salary', 'interest', 'business', 'other', 'deductions', 'taxable_income', 'income_tax', 'lito', 'medicare', 'withheld', 'result']) assert.ok(keys.includes(k), k);
  assert.match(e.note, /not tax advice/i);
});

test('the rate tables in use are cited with their ATO source', () => {
  const b = estBook();
  const e = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  assert.match(e.rates.income_tax.source, /^https:\/\/www\.ato\.gov\.au\//);
  assert.equal(e.rates.income_tax.second_bracket_rate, 0.15);
  assert.equal(taxReturnEstimate(b.db, { fy: 2026, today: TODAY }).rates.income_tax.second_bracket_rate, 0.16);
});

test('The assistant door: the tax estimate read carries the estimate object', () => {
  const b = estBook();
  const r = taxEstimate(b.db, { fy: FY, today: TODAY });
  assert.equal(r.fy, FY);
  assert.ok(r.estimate && r.estimate.status === 'ok');
  assert.equal(r.estimate.result, taxReturnEstimate(b.db, { fy: FY, today: TODAY }).result);
  assert.ok('inputs' in r && 'deductions' in r, 'the old fields are kept');
  assert.match(r.note, /not tax advice/i);
});

test('The assistant door: /tax (what mint_tax reads) carries the estimate object, with the old fields kept', () => {
  const b = estBook();
  const r = taxReport(b.db, { fy: FY }, TODAY);
  assert.equal(r.estimate.status, 'ok');
  assert.equal(r.estimate.result, taxReturnEstimate(b.db, { fy: FY, today: TODAY }).result);
  assert.match(r.estimate.note, /not tax advice/i);
  assert.ok(r.summary && Array.isArray(r.items) && Array.isArray(r.ato_categories));
});

test('the accountant pack gets the estimate as signed lines with their source, or nothing', () => {
  const b = estBook();
  const e = taxReturnEstimate(b.db, { fy: FY, today: TODAY });
  const p = packEstimate(e);
  assert.match(p.title, /2026-27/);
  const by = Object.fromEntries(p.lines.map((l) => [l.label.replace(/ \((entered|estimated|bank feed|feed|calculated)\)$/, ''), l]));
  assert.equal(by['Salary (gross)'].amount, e.income.salary.amount);
  assert.match(by['Salary (gross)'].label, /\(estimated\)/);
  assert.equal(by['Tax withheld'].amount, -e.withheld.amount);
  assert.match(p.note, /not tax advice/i);
  assert.equal(packEstimate(taxReturnEstimate(b.db, { fy: 2020, today: TODAY })), null);
});

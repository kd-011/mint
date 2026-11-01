// The tax return calculator, pure maths. Every expected figure is worked by
// hand from the ATO tables (rates, Medicare levy, LITO, MLS, HELP) or taken
// from an example the ATO prints (Schedule 1 withholding, the HELP and MLS
// worked examples). Amounts are cents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasRates, incomeTax, medicareLevy, lito, medicareLevySurcharge, helpRepayment,
  withholding, grossFromNet, computeReturn,
} from '../lib/taxcalc.mjs';

const $ = (n) => Math.round(n * 100);

test('only the years with verified tables are supported', () => {
  assert.equal(hasRates(2026), true);
  assert.equal(hasRates(2027), true);
  assert.equal(hasRates(2020), false);
  assert.equal(hasRates(2099), false);
});

test('income tax at every bracket edge, FY2026 (16% bracket)', () => {
  assert.equal(incomeTax(2026, $(0)), 0);
  assert.equal(incomeTax(2026, $(18200)), 0);
  assert.equal(incomeTax(2026, $(18201)), 16);
  assert.equal(incomeTax(2026, $(45000)), $(4288));
  assert.equal(incomeTax(2026, $(45001)), $(4288.3));
  assert.equal(incomeTax(2026, $(135000)), $(31288));
  assert.equal(incomeTax(2026, $(135001)), $(31288.37));
  assert.equal(incomeTax(2026, $(190000)), $(51638));
  assert.equal(incomeTax(2026, $(190001)), $(51638.45));
  assert.equal(incomeTax(2026, $(200000)), $(56138));
});

test('income tax at every bracket edge, FY2027 (15% bracket)', () => {
  assert.equal(incomeTax(2027, $(18200)), 0);
  assert.equal(incomeTax(2027, $(18201)), 15);
  assert.equal(incomeTax(2027, $(45000)), $(4020));
  assert.equal(incomeTax(2027, $(45001)), $(4020.3));
  assert.equal(incomeTax(2027, $(135000)), $(31020));
  assert.equal(incomeTax(2027, $(190000)), $(51370));
  assert.equal(incomeTax(2027, $(200000)), $(55870));
});

test('taxable income is taken in whole dollars, as the ATO assesses it', () => {
  assert.equal(incomeTax(2026, 4500099), incomeTax(2026, 4500000));
});

test('Medicare levy: nil under the lower threshold, 10c phase-in, then 2% of everything', () => {
  assert.equal(medicareLevy(2026, $(28011)), 0);
  assert.equal(medicareLevy(2026, $(29000)), $(98.9)); // the ATO worked example
  assert.equal(medicareLevy(2026, $(35000)), $(698.9));
  assert.equal(medicareLevy(2026, $(35013)), $(700.2)); // last dollar before 2% catches up
  assert.equal(medicareLevy(2026, $(35014)), $(700.28));
  assert.equal(medicareLevy(2026, $(50000)), $(1000));
  assert.equal(medicareLevy(2027, $(100000)), $(2000));
});

test('LITO: $700 to 37,500, 5c taper to 45,000 ($325), 1.5c taper to 66,667', () => {
  assert.equal(lito(2026, $(20000)), $(700));
  assert.equal(lito(2026, $(37500)), $(700));
  assert.equal(lito(2026, $(37501)), $(699.95));
  assert.equal(lito(2026, $(41250)), $(512.5));
  assert.equal(lito(2026, $(45000)), $(325));
  assert.equal(lito(2026, $(55000)), $(175));
  assert.equal(lito(2026, $(66667)), 0);
  assert.equal(lito(2026, $(80000)), 0);
  assert.equal(lito(2027, $(45000)), $(325));
});

test('Medicare levy surcharge (singles) by tier, both years, no cover', () => {
  assert.equal(medicareLevySurcharge(2026, $(101000)), 0);
  assert.equal(medicareLevySurcharge(2026, $(101001)), $(1010.01));
  assert.equal(medicareLevySurcharge(2026, $(118000)), $(1180));
  assert.equal(medicareLevySurcharge(2026, $(118001)), $(1475.01));
  assert.equal(medicareLevySurcharge(2026, $(158000)), $(1975));
  assert.equal(medicareLevySurcharge(2026, $(158001)), $(2370.02));
  assert.equal(medicareLevySurcharge(2027, $(105000)), 0);
  assert.equal(medicareLevySurcharge(2027, $(117000)), $(1170)); // the ATO worked example
  assert.equal(medicareLevySurcharge(2027, $(123001)), $(1537.51));
  assert.equal(medicareLevySurcharge(2027, $(164001)), $(2460.02));
});

test('HELP repayment is marginal from 2025-26, matching the ATO examples', () => {
  assert.equal(helpRepayment(2026, $(67000)), 0);
  assert.equal(helpRepayment(2026, $(100000)), $(4950));
  assert.equal(helpRepayment(2026, $(125000)), $(8700));
  assert.equal(helpRepayment(2026, $(150000)), $(12950));
  assert.equal(helpRepayment(2026, $(179286)), $(17928.6)); // 10% of the lot
  assert.equal(helpRepayment(2027, $(69528)), 0);
  assert.equal(helpRepayment(2027, $(86380)), $(2527.8)); // ATO example 1
  assert.equal(helpRepayment(2027, $(137064)), $(10276.99)); // ATO example 2
  assert.equal(helpRepayment(2027, $(254780)), $(25478)); // ATO example 3
});

test('Schedule 1 withholding matches the ATO published weekly table (2026-27, tax-free threshold)', () => {
  const expect = { 361: 0, 370: 1, 514: 23, 537: 26, 538: 27, 672: 60, 720: 68 };
  for (const [wk, w] of Object.entries(expect)) assert.equal(withholding(2027, $(Number(wk)), 'weekly'), $(w), `$${wk} a week`);
});

test('Schedule 1 worked examples from the instrument', () => {
  assert.equal(withholding(2027, $(1333.45), 'weekly'), $(245)); // example 1, before the levy adjustment
  assert.equal(withholding(2027, 540033, 'monthly'), $(940)); // example 3: 217 a week x 13 / 3
  // $1,299.30 a fortnight is $649 a week: x = 649.99, 0.25 x - 108.2135 = 54.28 -> $54, doubled
  assert.equal(withholding(2027, $(1299.3), 'fortnightly'), $(108));
});

test('Schedule 1 withholding, 2025-26 coefficients, hand worked', () => {
  // $1,000 a week: x = 1000.99, 0.3227 x - 180.0385 = 142.98 -> $143
  assert.equal(withholding(2026, $(1000), 'weekly'), $(143));
  // $2,000 a fortnight is $1,000 a week: $143 doubled
  assert.equal(withholding(2026, $(2000), 'fortnightly'), $(286));
  // $4,000 a month: x = floor(4000.01 x 3 / 13) = 923 -> 923.99 x 0.3227 - 180.0385 = 118.13 -> $118 x 13/3 = 511.33 -> $511
  assert.equal(withholding(2026, $(4000), 'monthly'), $(511));
});

test('reverse withholding round trip: net back to gross, then forward again gives the same net', () => {
  for (const fy of [2026, 2027]) {
    for (const period of ['weekly', 'fortnightly', 'monthly']) {
      const scale = { weekly: 1, fortnightly: 2, monthly: 4.33 }[period];
      for (const weekly of [450, 700, 950, 1400, 1900, 2800, 4200]) {
        const gross = Math.round(weekly * scale) * 100;
        const net = gross - withholding(fy, gross, period);
        const back = grossFromNet(fy, net, period);
        assert.equal(back - withholding(fy, back, period), net, `${fy} ${period} net ${net}`);
        // The ATO rounds withholding to a whole weekly dollar, so a net pay fits more than one gross: a dollar
        // either way on a weekly pay, two on a fortnightly one, up to five on a monthly one (a weekly dollar is $4.33 of monthly pay).
        assert.ok(Math.abs(back - gross) <= { weekly: 100, fortnightly: 200, monthly: 500 }[period], `${fy} ${period}: ${gross} came back as ${back}`);
      }
    }
  }
});

test('reverse withholding of a pay under the tax-free threshold is the pay itself', () => {
  assert.equal(grossFromNet(2027, $(300), 'weekly'), $(300));
});

// ---------- the whole return ----------

const base = { interest: 0, business: 0, other: 0, deductions: 0, d12: 0, private_health: true, has_help: false };

test('hand-worked return A, FY2026: 90,000 salary, 100 interest, 2,000 deductions -> refund of $20', () => {
  const r = computeReturn(2026, { ...base, salary: $(90000), interest: $(100), deductions: $(2000), withheld: $(19000) });
  assert.equal(r.taxable, $(88100));
  assert.equal(r.income_tax, $(17218)); // 4,288 + 30c x 43,100
  assert.equal(r.lito, 0);
  assert.equal(r.medicare, $(1762));
  assert.equal(r.mls, 0);
  assert.equal(r.help, 0);
  assert.equal(r.tax_payable, $(18980));
  assert.equal(r.result, $(20));
});

test('hand-worked return B, FY2027: 120,000, no hospital cover, HELP -> owing', () => {
  const r = computeReturn(2027, { ...base, salary: $(120000), deductions: $(3000), withheld: $(28000), private_health: false, has_help: true });
  assert.equal(r.taxable, $(117000));
  assert.equal(r.income_tax, $(25620)); // 4,020 + 30c x 72,000
  assert.equal(r.medicare, $(2340));
  assert.equal(r.mls, $(1170));
  assert.equal(r.help, $(7120.8)); // 15c x (117,000 - 69,528)
  assert.equal(r.tax_payable, $(36250.8));
  assert.equal(r.result, -$(8250.8));
});

test('hand-worked return C, FY2026: low income gets LITO and a part Medicare levy', () => {
  const r = computeReturn(2026, { ...base, salary: $(30000), withheld: $(1500) });
  assert.equal(r.income_tax, $(1888)); // 16c x 11,800
  assert.equal(r.lito, $(700));
  assert.equal(r.medicare, $(198.9));
  assert.equal(r.tax_payable, $(1386.9));
  assert.equal(r.result, $(113.1));
});

test('hand-worked return D, FY2027: LITO in the first taper', () => {
  const r = computeReturn(2027, { ...base, salary: $(41250), withheld: 0 });
  assert.equal(r.income_tax, $(3457.5));
  assert.equal(r.lito, $(512.5));
  assert.equal(r.medicare, $(825));
  assert.equal(r.tax_payable, $(3770));
  assert.equal(r.result, -$(3770));
});

test('LITO cannot take tax below zero and never touches the Medicare levy', () => {
  const r = computeReturn(2026, { ...base, salary: $(19000), withheld: 0 });
  assert.equal(r.income_tax, $(128)); // 16c x 800
  assert.equal(r.lito, $(128));
  assert.equal(r.lito_offered, $(700));
  assert.equal(r.medicare, 0);
  assert.equal(r.tax_payable, 0);
});

test('a business loss is not set against salary; deductions cannot push taxable income below zero', () => {
  const loss = computeReturn(2026, { ...base, salary: $(60000), business: -$(5000), withheld: 0 });
  assert.equal(loss.taxable, $(60000));
  const big = computeReturn(2026, { ...base, salary: $(1000), deductions: $(5000), withheld: 0 });
  assert.equal(big.taxable, 0);
});

test('personal super deductions count towards the surcharge and HELP income', () => {
  // taxable 100,000 after a 10,000 D12 deduction; MLS income 110,000 -> tier 1 (FY2026 118k edge not reached), no cover
  const r = computeReturn(2026, { ...base, salary: $(110000), deductions: $(10000), d12: $(10000), withheld: 0, private_health: false });
  assert.equal(r.taxable, $(100000));
  assert.equal(r.mls, $(1100)); // 1% of 110,000
});

test('unknown cover and unknown HELP: the estimate assumes cover and no debt, and says what each would cost', () => {
  const r = computeReturn(2027, { ...base, salary: $(120000), deductions: $(3000), withheld: $(28000), private_health: null, has_help: null });
  assert.equal(r.mls, 0);
  assert.equal(r.help, 0);
  assert.equal(r.result, $(28000) - $(25620) - $(2340));
  const mls = r.swings.find((s) => s.key === 'private_health');
  const help = r.swings.find((s) => s.key === 'has_help');
  assert.equal(mls.amount, $(1170));
  assert.equal(help.amount, $(7120.8));
  assert.match(mls.label, /hospital cover/i);
  assert.match(help.label, /HELP/);
});

test('an unknown that cannot matter at this income shows no swing', () => {
  // 60,000 is under the surcharge and the HELP thresholds: neither unknown costs anything
  const low = computeReturn(2027, { ...base, salary: $(60000), withheld: $(9000), private_health: null, has_help: null });
  assert.equal(low.swings.length, 0);
  // 80,000 is under the surcharge threshold but over the HELP one
  const mid = computeReturn(2027, { ...base, salary: $(80000), withheld: $(15000), private_health: null, has_help: null });
  assert.equal(mid.swings.find((s) => s.key === 'private_health'), undefined);
  assert.equal(mid.swings.find((s) => s.key === 'has_help').amount, $(1570.8)); // 15c x (80,000 - 69,528)
});

test('a known HELP debt with a known balance caps the repayment at the balance', () => {
  const r = computeReturn(2027, { ...base, salary: $(120000), withheld: 0, has_help: true, help_balance: $(2000) });
  assert.equal(r.help, $(2000));
});

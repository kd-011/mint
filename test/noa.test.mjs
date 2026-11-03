// Income by financial year against the ATO Notices of Assessment (lib/noa.mjs):
// the 1 July edge of the FY bucketing, the reconciliation maths, the one-time
// a fresh book holding no NoAs, a year with no NoA yet, and the API that edits them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.mjs';
import { createSource } from '../lib/income.mjs';
import { incomeByFy, reconcile, listAssessments, setAssessment, deleteAssessment } from '../lib/noa.mjs';
import { FAKE_KEY } from './fixtures/fake-redbark.mjs';
import { payBook, refreshMoney, PAY_ACCOUNT } from './fixtures/pay.mjs';
import { INVENTED_NOAS, seedNoas } from './fixtures/noa.mjs';
import { GATE_KEY } from './fixtures/gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = '2026-10-22';
const row = (r, fy) => r.years.find((y) => y.fy === fy);

// A book with fortnightly pays either side of 30 June / 1 July, and nothing else.
function edgeBook() {
  const b = payBook({ paydays: ['2023-06-29', '2023-06-30', '2023-07-01', '2023-07-02'], amounts: [100000, 110000, 120000, 130000] });
  refreshMoney(b, TODAY);
  return b;
}

test('FY bucketing: 30 June is the old year, 1 July the new one', () => {
  const b = edgeBook();
  const r = incomeByFy(b.db, { today: TODAY });
  assert.equal(row(r, 2023).salary, 100000 + 110000);
  assert.equal(row(r, 2024).salary, 120000 + 130000);
  assert.equal(row(r, 2023).from, '2022-07-01');
  assert.equal(row(r, 2023).to, '2023-06-30');
  assert.equal(row(r, 2024).from, '2023-07-01');
});

test('the years run from FY2020 to the current one, which is year to date', () => {
  const r = incomeByFy(edgeBook().db, { today: TODAY });
  assert.deepEqual(r.years.map((y) => y.fy), [2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027]);
  assert.equal(r.current_fy, 2027);
  assert.deepEqual(r.years.filter((y) => y.current).map((y) => y.fy), [2027]);
  // On 30 June the year is still open; on 1 July the next one starts.
  assert.equal(incomeByFy(edgeBook().db, { today: '2026-06-30' }).current_fy, 2026);
  assert.equal(incomeByFy(edgeBook().db, { today: '2026-07-01' }).current_fy, 2027);
});

test('regular streams are split from salary and both count as income', () => {
  const b = payBook({ paydays: ['2023-08-01'], amounts: [200000] });
  b.add(PAY_ACCOUNT, '2023-08-10', 90000, 'PAYMENT FROM TEST PARENT & CO', { provider_category: 'INCOME' });
  b.add(PAY_ACCOUNT, '2023-08-24', 90000, 'PAYMENT FROM TEST PARENT & CO', { provider_category: 'INCOME' });
  refreshMoney(b, TODAY);
  createSource(b.db, { name: 'Parent', kind: 'regular', match: 'starts', pattern: 'PAYMENT FROM TEST PARENT' });
  const y = row(incomeByFy(b.db, { today: TODAY }), 2024);
  assert.equal(y.salary, 200000);
  assert.equal(y.regular, 180000);
  assert.equal(y.income, 380000);
});

test('reconciliation: FY2023 net salary plus PAYG withheld against taxable income', () => {
  const r = reconcile({ salary: 3300000, payg: 1600000, taxable: 5000000 });
  assert.equal(r.est_gross, 4900000);
  assert.equal(r.gap, -100000);
  assert.equal(r.gap_pct, -2);
});

test('reconciliation: FY2024 is a visible gap, never papered over', () => {
  const r = reconcile({ salary: 4000000, payg: 2000000, taxable: 5000000 });
  assert.equal(r.est_gross, 6000000);
  assert.equal(r.gap, 1000000);
  assert.equal(r.gap_pct, 20);
});

test('reconciliation needs the NoA and a taxable figure to divide by', () => {
  for (const bad of [{ payg: null, taxable: null }, { payg: 100, taxable: null }, { payg: null, taxable: 100 }]) {
    assert.deepEqual(reconcile({ salary: 5000, ...bad }), { est_gross: null, gap: null, gap_pct: null });
  }
  // A zero taxable year has no percentage, only the dollars.
  assert.deepEqual(reconcile({ salary: 0, payg: 0, taxable: 0 }), { est_gross: 0, gap: 0, gap_pct: null });
  assert.equal(reconcile({ salary: 500, payg: 0, taxable: 0 }).gap_pct, null);
});

test('a fresh book holds no NoAs: nothing is seeded, the owner adds each year', () => {
  const db = openDb(':memory:');
  assert.deepEqual(listAssessments(db), []);
  assert.ok(!db.prepare("SELECT 1 FROM settings WHERE key = 'noa_seeded'").get());
});

test('NoAs are stored in cents and nothing sensitive is kept', () => {
  const db = openDb(':memory:');
  seedNoas(db);
  const all = listAssessments(db);
  assert.deepEqual(all.map((a) => a.fy), [2020, 2021, 2022, 2023, 2024]);
  const by = Object.fromEntries(all.map((a) => [a.fy, a]));
  for (const n of INVENTED_NOAS) for (const [k, v] of Object.entries(n)) assert.equal(by[n.fy][k], v, `FY${n.fy} ${k}`);
  assert.match(by[2023].source_file, /^NoA 22-23\.pdf$/);
  assert.ok(!JSON.stringify(all).match(/\b\d{9}\b/), 'no TFN or reference number sized digits');
});

test('NoAs persist across reopening: an edit is kept and a deleted year stays deleted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mint-noa-'));
  const path = join(dir, 'mint.db');
  let db = openDb(path);
  seedNoas(db);
  assert.equal(listAssessments(db).length, 5);
  setAssessment(db, 2023, { taxable_income: 5000100, tax_withheld_payg: 1600000 });
  deleteAssessment(db, 2021);
  db.close();
  db = openDb(path);
  const all = listAssessments(db);
  assert.equal(all.length, 4, 'the deleted year does not come back');
  assert.ok(!all.some((a) => a.fy === 2021));
  assert.equal(all.find((a) => a.fy === 2023).taxable_income, 5000100, 'an edit is not overwritten');
  db.close();
  db = openDb(path);
  assert.equal(listAssessments(db).length, 4);
  db.close();
});

test('a year with no NoA shows what Mint saw and no gap', () => {
  const b = payBook({ paydays: ['2024-08-01', '2024-08-15'], amounts: [150000, 150000] });
  refreshMoney(b, TODAY);
  const y = row(incomeByFy(b.db, { today: TODAY }), 2025);
  assert.equal(y.noa, null);
  assert.equal(y.salary, 300000);
  assert.equal(y.est_gross, null);
  assert.equal(y.gap, null);
  assert.equal(y.gap_pct, null);
});

test('with a NoA the row carries the reconciliation, and an edit moves it', () => {
  const b = payBook({ paydays: ['2023-08-01'], amounts: [3000000] });
  seedNoas(b.db);
  refreshMoney(b, TODAY);
  const y = row(incomeByFy(b.db, { today: TODAY }), 2024);
  assert.equal(y.noa.taxable_income, 5200000);
  assert.equal(y.est_gross, 3000000 + 1900000);
  assert.equal(y.gap, 3000000 + 1900000 - 5200000);
  setAssessment(b.db, 2024, { taxable_income: 4900000, tax_withheld_payg: 1900000 });
  assert.equal(row(incomeByFy(b.db, { today: TODAY }), 2024).gap, 0);
});

test('years before the bank history is real are marked partial, others are not', () => {
  const b = payBook({ paydays: ['2022-03-02', '2022-03-16', '2023-07-05', '2023-07-19'], amounts: [200000, 200000, 200000, 200000] });
  refreshMoney(b, TODAY);
  const r = incomeByFy(b.db, { today: TODAY });
  for (const fy of [2020, 2021, 2022]) assert.equal(row(r, fy).partial_bank, true, `FY${fy}`);
  assert.equal(row(r, 2024).partial_bank, false);
  assert.equal(row(r, 2025).partial_bank, false);
});

test('setAssessment validates: whole cents, a real year, nothing negative where it cannot be', () => {
  const db = openDb(':memory:');
  assert.throws(() => setAssessment(db, 2025, { taxable_income: 12.5, tax_withheld_payg: 0 }), /whole cents/);
  assert.throws(() => setAssessment(db, 2025, { taxable_income: -1, tax_withheld_payg: 0 }), /taxable_income/);
  assert.throws(() => setAssessment(db, 2025, { tax_withheld_payg: 100 }), /taxable_income/);
  assert.throws(() => setAssessment(db, 1999, { taxable_income: 1, tax_withheld_payg: 1 }), /fy/);
  assert.throws(() => setAssessment(db, 2025, { taxable_income: 1, tax_withheld_payg: 1, source_file: 'x'.repeat(300) }), /source_file/);
  const ok = setAssessment(db, 2025, { taxable_income: 6100000, tax_withheld_payg: 2200000, refund: -50000 });
  assert.equal(ok.fy, 2025);
  assert.equal(ok.refund, -50000, 'an amount owing is a negative refund');
  assert.equal(ok.assessed_tax, null);
  assert.throws(() => deleteAssessment(db, 2031), /no NoA/);
});

// the HTTP surface

let proc, base;
const H = { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY };
const send = (method, path, body) => fetch(base + path, { method, headers: { ...H, 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
const json = async (r, status = 200) => { assert.equal(r.status, status, await r.clone().text()); return r.json(); };

function start(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve({ p, url: `http://127.0.0.1:${m[1]}` });
    });
    p.stderr.on('data', (d) => { out += d; });
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000);
  });
}

before(async () => {
  const s = await start({ MINT_HOME: mkdtempSync(join(tmpdir(), 'mint-noa-api-')), MINT_PORT: '0', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', MINT_LOCK: 'off', MINT_USER: 'owner', REDBARK_API_KEY: FAKE_KEY, REDBARK_API_BASE: 'http://127.0.0.1:9' });
  proc = s.p;
  base = s.url;
});
after(() => proc?.kill('SIGTERM'));

test('GET /api/income/fy needs the gate identity and lists the years with their NoAs', async () => {
  assert.equal((await fetch(`${base}/api/income/fy`)).status, 401);
  const r = await json(await send('GET', '/api/income/fy'));
  assert.equal(r.years[0].fy, 2020);
  assert.equal(r.years.at(-1).current, true);
  assert.ok(r.years.every((y) => y.noa === null), 'a fresh book has no NoAs');
  for (const { fy, ...fields } of INVENTED_NOAS) await json(await send('PUT', `/api/income/assessments/${fy}`, fields));
  const after = await json(await send('GET', '/api/income/fy'));
  assert.equal(after.years.find((y) => y.fy === 2023).noa.taxable_income, 5000000);
  assert.equal(after.years.find((y) => y.fy === 2020).noa.taxable_income, 0);
});

test('PUT adds a year, DELETE removes it, bad input is a 400, an unknown year a 404', async () => {
  const put = await json(await send('PUT', '/api/income/assessments/2025', { taxable_income: 6100000, tax_withheld_payg: 2200000, source_file: 'NoA 24-25.pdf' }));
  assert.equal(put.fy, 2025);
  const after = await json(await send('GET', '/api/income/fy'));
  assert.equal(after.years.find((y) => y.fy === 2025).noa.taxable_income, 6100000);
  await json(await send('PUT', '/api/income/assessments/2025', { taxable_income: 6200000, tax_withheld_payg: 2200000 }));
  assert.equal((await json(await send('GET', '/api/income/fy'))).years.find((y) => y.fy === 2025).noa.taxable_income, 6200000);
  assert.equal((await send('PUT', '/api/income/assessments/2025', { taxable_income: 'lots', tax_withheld_payg: 1 })).status, 400);
  assert.equal((await send('PUT', '/api/income/assessments/20x5', { taxable_income: 1, tax_withheld_payg: 1 })).status, 404);
  assert.deepEqual(await json(await send('DELETE', '/api/income/assessments/2025')), { deleted: true });
  assert.equal((await json(await send('GET', '/api/income/fy'))).years.find((y) => y.fy === 2025).noa, null);
  assert.equal((await send('DELETE', '/api/income/assessments/2025')).status, 404);
});

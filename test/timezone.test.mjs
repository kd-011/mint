// Configurable timezone (MINT_TZ). Every date boundary in Mint follows one IANA zone,
// default Australia/Perth, so a user in Sydney (daylight saving) or Adelaide (a half-hour
// offset) gets the right days, pay cycles and schedules. All data below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zoneName, assertZone, zoneDate, zoneMinutes, zoneDayStart, zoneDayEnd, daysBetween, addDays } from '../lib/dates.mjs';
import { fyOf, fyRange } from '../lib/tax.mjs';
import { dueSync } from '../lib/schedule.mjs';
import { payBook, refreshMoney } from './fixtures/pay.mjs';
import { book } from './fixtures/book.mjs';
import { currentCycle, listCycles } from '../lib/cycles.mjs';
import { runAlerts } from '../lib/alerts.mjs';
import { GATE_KEY } from './fixtures/gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Run fn with MINT_TZ set (or unset for null), then put the old value back.
function inZone(tz, fn) {
  const old = process.env.MINT_TZ;
  if (tz == null) delete process.env.MINT_TZ; else process.env.MINT_TZ = tz;
  try { return fn(); } finally { if (old === undefined) delete process.env.MINT_TZ; else process.env.MINT_TZ = old; }
}
const at = (iso) => new Date(iso);

test('the zone defaults to Australia/Perth and reads MINT_TZ', () => {
  assert.equal(inZone(null, zoneName), 'Australia/Perth');
  assert.equal(inZone('', zoneName), 'Australia/Perth');
  assert.equal(inZone('Australia/Sydney', zoneName), 'Australia/Sydney');
  assert.equal(inZone('australia/adelaide', zoneName), 'Australia/Adelaide', 'canonical casing');
});

test('an invalid MINT_TZ throws and names the variable', () => {
  for (const bad of ['Mars/Olympus_Mons', 'Sydney', '+08:00', 'AEST', 'UTC+8']) {
    assert.throws(() => assertZone(bad), /MINT_TZ/, bad);
    assert.throws(() => inZone(bad, zoneName), /MINT_TZ/, bad);
  }
  assert.equal(assertZone('UTC'), 'UTC');
});

test('an invalid MINT_TZ fails startup with a message naming the variable', async () => {
  const out = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
      env: { PATH: process.env.PATH, MINT_HOME: mkdtempSync(join(tmpdir(), 'mint-tz-bad-')), MINT_PORT: '0', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', MINT_LOCK: 'off', REDBARK_API_KEY: 'rbk_test_invented', MINT_TZ: 'Mars/Olympus_Mons' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    p.stdout.on('data', (d) => { text += d; });
    p.stderr.on('data', (d) => { text += d; });
    p.on('exit', (code) => resolve({ code, text }));
    setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`server kept running: ${text}`)); }, 8000);
  });
  assert.notEqual(out.code, 0);
  assert.match(out.text, /MINT_TZ/);
  assert.match(out.text, /Mars\/Olympus_Mons/);
});

test('zoneDate and zoneMinutes: Perth, Sydney, Adelaide, Brisbane', () => {
  // 2026-07-01 is winter: Sydney +10, Adelaide +9:30, Perth +8, Brisbane +10.
  const winter = at('2026-06-30T14:30:00Z');
  assert.deepEqual(inZone('Australia/Perth', () => [zoneDate(winter), zoneMinutes(winter)]), ['2026-06-30', 22 * 60 + 30]);
  assert.deepEqual(inZone('Australia/Sydney', () => [zoneDate(winter), zoneMinutes(winter)]), ['2026-07-01', 30]);
  assert.deepEqual(inZone('Australia/Adelaide', () => [zoneDate(winter), zoneMinutes(winter)]), ['2026-07-01', 0]);
  assert.deepEqual(inZone('Australia/Brisbane', () => [zoneDate(winter), zoneMinutes(winter)]), ['2026-07-01', 30]);
  // Summer: Sydney +11, Adelaide +10:30, Brisbane stays +10.
  const summer = at('2026-12-31T13:30:00Z');
  assert.deepEqual(inZone('Australia/Sydney', () => [zoneDate(summer), zoneMinutes(summer)]), ['2027-01-01', 30]);
  assert.deepEqual(inZone('Australia/Adelaide', () => [zoneDate(summer), zoneMinutes(summer)]), ['2027-01-01', 0]);
  assert.deepEqual(inZone('Australia/Brisbane', () => [zoneDate(summer), zoneMinutes(summer)]), ['2026-12-31', 23 * 60 + 30]);
});

test('zoneDate and zoneMinutes around the Sydney daylight saving start (Sun 4 Oct 2026, 02:00 to 03:00)', () => {
  inZone('Australia/Sydney', () => {
    assert.deepEqual([zoneDate(at('2026-10-03T13:59:00Z')), zoneMinutes(at('2026-10-03T13:59:00Z'))], ['2026-10-03', 23 * 60 + 59]);
    assert.deepEqual([zoneDate(at('2026-10-03T14:00:00Z')), zoneMinutes(at('2026-10-03T14:00:00Z'))], ['2026-10-04', 0]);
    assert.equal(zoneMinutes(at('2026-10-03T15:59:00Z')), 119); // 01:59 AEST
    assert.equal(zoneMinutes(at('2026-10-03T16:00:00Z')), 180); // 03:00 AEDT, 02:00 never happened
  });
});

test('zoneDate and zoneMinutes around the Sydney daylight saving end (Sun 4 Apr 2027, 03:00 back to 02:00)', () => {
  inZone('Australia/Sydney', () => {
    assert.equal(zoneMinutes(at('2027-04-03T15:30:00Z')), 150); // 02:30 AEDT, first pass
    assert.equal(zoneMinutes(at('2027-04-03T16:30:00Z')), 150); // 02:30 AEST, second pass
    assert.equal(zoneDate(at('2027-04-03T15:30:00Z')), '2027-04-04');
    assert.equal(zoneDate(at('2027-04-03T16:30:00Z')), '2027-04-04');
    assert.equal(zoneDate(at('2027-04-04T13:59:00Z')), '2027-04-04'); // 23:59 AEST
    assert.equal(zoneDate(at('2027-04-04T14:00:00Z')), '2027-04-05');
  });
});

test('zoneDayStart and zoneDayEnd bound a local day, including the 23 and 25 hour ones', () => {
  inZone('Australia/Sydney', () => {
    assert.equal(zoneDayStart('2026-07-01').toISOString(), '2026-06-30T14:00:00.000Z');
    assert.equal(zoneDayEnd('2026-07-01').toISOString(), '2026-07-01T13:59:59.999Z');
    const short = zoneDayEnd('2026-10-04') - zoneDayStart('2026-10-04') + 1;
    assert.equal(short / 3600000, 23);
    const long = zoneDayEnd('2027-04-04') - zoneDayStart('2027-04-04') + 1;
    assert.equal(long / 3600000, 25);
  });
  inZone('Australia/Adelaide', () => {
    assert.equal(zoneDayStart('2026-07-01').toISOString(), '2026-06-30T14:30:00.000Z');
    assert.equal(zoneDayEnd('2026-07-01').toISOString(), '2026-07-01T14:29:59.999Z');
  });
  inZone('Australia/Brisbane', () => {
    assert.equal(zoneDayStart('2026-10-04').toISOString(), '2026-10-03T14:00:00.000Z');
    assert.equal(zoneDayEnd('2026-10-04') - zoneDayStart('2026-10-04') + 1, 24 * 3600000);
  });
  inZone('Australia/Perth', () => {
    assert.equal(zoneDayStart('2026-10-04').toISOString(), '2026-10-03T16:00:00.000Z');
  });
});

test('day stepping is calendar arithmetic across both Sydney transitions', () => {
  inZone('Australia/Sydney', () => {
    assert.equal(addDays('2026-10-03', 1), '2026-10-04');
    assert.equal(addDays('2026-10-04', 1), '2026-10-05');
    assert.equal(daysBetween('2026-10-03', '2026-10-05'), 2);
    assert.equal(daysBetween('2027-04-03', '2027-04-05'), 2);
    assert.equal(addDays('2027-04-03', 2), '2027-04-05');
    // Walking day by day from local noon never skips or repeats a date.
    for (const [from, n] of [['2026-09-28', 14], ['2027-03-28', 14]]) {
      let d = from;
      for (let i = 0; i < n; i++) { const next = addDays(d, 1); assert.equal(daysBetween(d, next), 1); d = next; }
    }
  });
});

test('financial year turns over on 1 July in the configured zone', () => {
  const justBefore = at('2027-06-30T13:59:00Z'); // 23:59 on 30 June in Sydney
  const justAfter = at('2027-06-30T14:00:00Z'); // 00:00 on 1 July in Sydney, 22:00 on 30 June in Perth
  assert.equal(inZone('Australia/Sydney', () => fyOf(zoneDate(justBefore))), 2027);
  assert.equal(inZone('Australia/Sydney', () => fyOf(zoneDate(justAfter))), 2028);
  assert.equal(inZone('Australia/Perth', () => fyOf(zoneDate(justAfter))), 2027);
  assert.equal(inZone('Australia/Perth', () => fyOf(zoneDate(at('2027-06-30T16:00:00Z')))), 2028);
  assert.deepEqual(fyRange(2028), { from: '2027-07-01', to: '2028-06-30' });
});

// Fortnightly pay on invented dates; the cycle that straddles each Sydney transition.
function cycles(paydays, today) {
  const b = payBook({ paydays });
  refreshMoney(b, today);
  return { b, list: listCycles(b.db, { today }) };
}

test('a pay cycle spanning the Sydney daylight saving start has the right start, end and day count', () => {
  inZone('Australia/Sydney', () => {
    const { list } = cycles(['2026-09-10', '2026-09-24', '2026-10-08', '2026-10-22'], '2026-10-25');
    const span = list.find((c) => c.start === '2026-09-24');
    assert.deepEqual({ start: span.start, end: span.end, days: span.days }, { start: '2026-09-24', end: '2026-10-07', days: 14 });
    assert.equal(daysBetween(span.start, span.end) + 1, 14);
  });
});

test('a pay cycle spanning the Sydney daylight saving end has the right start, end and day count', () => {
  inZone('Australia/Sydney', () => {
    const { list } = cycles(['2027-03-11', '2027-03-25', '2027-04-08', '2027-04-22'], '2027-04-25');
    const span = list.find((c) => c.start === '2027-03-25');
    assert.deepEqual({ start: span.start, end: span.end, days: span.days }, { start: '2027-03-25', end: '2027-04-07', days: 14 });
  });
});

test("'today' and days left to payday at 23:30 and 00:30 around the Sydney start", () => {
  inZone('Australia/Sydney', () => {
    // Fortnightly pay, last landed 21 Sep: the cycle runs to Sun 4 Oct and the next payday is Mon 5 Oct.
    const paydays = ['2026-08-10', '2026-08-24', '2026-09-07', '2026-09-21'];
    const left = (iso) => {
      const today = zoneDate(at(iso));
      const b = payBook({ paydays });
      refreshMoney(b, today);
      const c = currentCycle(b.db, { today });
      return { today, days_left: c.days_left, next: c.next_payday };
    };
    assert.deepEqual(left('2026-10-03T13:30:00Z'), { today: '2026-10-03', days_left: 2, next: '2026-10-05' }); // 23:30 AEST Sat
    assert.deepEqual(left('2026-10-03T14:30:00Z'), { today: '2026-10-04', days_left: 1, next: '2026-10-05' }); // 00:30 AEST Sun
    assert.deepEqual(left('2026-10-04T12:30:00Z'), { today: '2026-10-04', days_left: 1, next: '2026-10-05' }); // 23:30 AEDT Sun
    assert.deepEqual(left('2026-10-04T13:30:00Z'), { today: '2026-10-05', days_left: 1, next: '2026-10-05' }); // 00:30 AEDT Mon, payday due but not landed: the open cycle stretches to today
  });
});

test("'today' and days left to payday at 23:30 and 00:30 around the Sydney end", () => {
  inZone('Australia/Sydney', () => {
    const paydays = ['2027-02-01', '2027-02-15', '2027-03-01', '2027-03-15', '2027-03-29'];
    const left = (iso) => {
      const today = zoneDate(at(iso));
      const b = payBook({ paydays });
      refreshMoney(b, today);
      const c = currentCycle(b.db, { today });
      return { today, days_left: c.days_left, next: c.next_payday };
    };
    // Cycle runs 29 Mar to 11 Apr, next payday 12 Apr.
    assert.deepEqual(left('2027-04-03T12:30:00Z'), { today: '2027-04-03', days_left: 9, next: '2027-04-12' }); // 23:30 AEDT Sat
    assert.deepEqual(left('2027-04-03T13:30:00Z'), { today: '2027-04-04', days_left: 8, next: '2027-04-12' }); // 00:30 AEDT Sun
    assert.deepEqual(left('2027-04-04T13:30:00Z'), { today: '2027-04-04', days_left: 8, next: '2027-04-12' }); // 23:30 AEST Sun, the day was 25 hours
    assert.deepEqual(left('2027-04-04T14:30:00Z'), { today: '2027-04-05', days_left: 7, next: '2027-04-12' }); // 00:30 AEST Mon
  });
});

test('the 02:40 reconcile runs once per local day in Sydney, on both transition days', () => {
  inZone('Australia/Sydney', () => {
    const run = (now, lastReconcile, lastPoll = at(now).toISOString()) => dueSync({ now: at(now), lastReconcile, lastPoll });
    // Before 02:40 local: not yet.
    assert.equal(run('2026-10-02T15:30:00Z', '2026-10-01T16:45:00Z'), null); // 01:30 AEST on 3 Oct
    assert.equal(run('2026-10-02T16:30:00Z', '2026-10-01T16:45:00Z'), null); // 02:30 AEST on 3 Oct, before 02:40
    assert.equal(run('2026-10-02T16:45:00Z', '2026-10-01T16:45:00Z'), 'reconcile'); // 02:45 AEST on 3 Oct
    // Start of daylight saving: 02:40 never exists on 4 Oct, the run happens from 03:00.
    assert.equal(run('2026-10-03T15:59:00Z', '2026-10-02T16:45:00Z'), null); // 01:59 AEST
    assert.equal(run('2026-10-03T16:00:00Z', '2026-10-02T16:45:00Z'), 'reconcile'); // 03:00 AEDT
    assert.equal(run('2026-10-03T16:10:00Z', '2026-10-03T16:00:30Z'), null); // already ran this local day
    // End of daylight saving: 02:45 happens twice on 4 Apr, the second pass must not run it again.
    assert.equal(run('2027-04-03T15:45:00Z', '2027-04-02T15:45:00Z'), 'reconcile'); // 02:45 AEDT
    assert.equal(run('2027-04-03T16:45:00Z', '2027-04-03T15:45:30Z'), null); // 02:45 AEST, same local date
    // Next night it runs again.
    assert.equal(run('2027-04-04T16:45:00Z', '2027-04-03T15:45:30Z'), 'reconcile'); // 5 Apr 02:45 AEST
  });
});

test('the 30 minute poll is an elapsed-time rule, unaffected by the clock change', () => {
  inZone('Australia/Sydney', () => {
    const base = { lastReconcile: '2026-10-03T16:30:00Z' }; // already reconciled on 4 Oct local
    assert.equal(dueSync({ now: at('2026-10-03T16:29:00Z'), ...base, lastPoll: '2026-10-03T15:58:00Z' }), 'poll'); // 31 minutes, across 02:00 to 03:00
    assert.equal(dueSync({ now: at('2026-10-03T16:29:00Z'), ...base, lastPoll: '2026-10-03T16:00:00Z' }), null); // 29 minutes
    assert.equal(dueSync({ now: at('2026-10-03T16:29:00Z'), ...base, lastPoll: null }), 'poll');
  });
});

test('alert dedupe periods and consent dates are local days in the configured zone', () => {
  const body = (tz) => inZone(tz, () => {
    const b = book();
    // 01:30 on 1 Nov in Sydney, still 31 Oct 22:30 in Perth.
    b.db.prepare("UPDATE connections SET consent_expires_at = '2026-10-31T14:30:00.000Z' WHERE id = 'conn_t_beta'").run();
    const out = runAlerts(b.db, { now: at('2026-10-17T02:00:00Z') });
    const a = out.find((x) => x.type === 'consent_expiring');
    return { period: a.period, body: a.body };
  });
  assert.equal(body('Australia/Perth').period, '2026-10-31');
  assert.match(body('Australia/Perth').body, /31\/10\/2026/);
  assert.equal(body('Australia/Sydney').period, '2026-11-01');
  assert.match(body('Australia/Sydney').body, /01\/11\/2026/);
});

test('the default zone gives byte-identical results to the Perth-only build', () => {
  // Golden from the pre-MINT_TZ perthDate/perthMinutes and the fixed +08:00 Wise window.
  const out = inZone(null, () => {
    const rows = [];
    for (let t = Date.UTC(2025, 0, 1); t < Date.UTC(2028, 0, 1); t += (7 * 60 + 13) * 60000) {
      const d = new Date(t);
      rows.push([zoneDate(d), zoneMinutes(d)]);
    }
    for (const d of ['2025-02-28', '2026-07-01', '2026-10-04', '2027-04-04', '2028-02-29']) rows.push([zoneDayStart(d).toISOString(), zoneDayEnd(d).toISOString()]);
    return rows;
  });
  assert.equal(out.length, 3647);
  assert.equal(createHash('sha256').update(JSON.stringify(out)).digest('hex'), 'c183c1ecbed77d9e230e3219ab9bb317969cfa61018fb220c8f5b1e75f7b673d'); // scan-allow (a sha256 of invented output)
});

// Start the real server on a throwaway home and return the stamped core.js the browser would get.
async function servedCore(tz) {
  const env = { PATH: process.env.PATH, MINT_HOME: mkdtempSync(join(tmpdir(), 'mint-tz-')), MINT_PORT: '0', MINT_GATE_KEY: GATE_KEY, MINT_SCHEDULER: 'off', MINT_LOCK: 'off', MINT_USER: 'owner', REDBARK_API_KEY: 'rbk_test_invented', ...(tz ? { MINT_TZ: tz } : {}) };
  const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise((resolve, reject) => {
      let out = '';
      const onData = (d) => { out += d; const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out); if (m) resolve(m[1]); };
      p.stdout.on('data', onData);
      p.stderr.on('data', (d) => { out += d; });
      p.on('exit', () => reject(new Error(`server exited: ${out}`)));
      setTimeout(() => reject(new Error(`server did not start: ${out}`)), 8000);
    });
    const r = await fetch(`${base}/core.js`, { headers: { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY } });
    const sw = await fetch(`${base}/`, { headers: { 'remote-user': 'owner', 'x-mint-gate': GATE_KEY } });
    return { core: await r.text(), html: await sw.text() };
  } finally { p.kill('SIGTERM'); }
}

test('the browser is told the configured zone: stamped into core.js, default Perth', async () => {
  const sydney = await servedCore('Australia/Sydney');
  assert.match(sydney.core, /const MINT_TZ = 'Australia\/Sydney';/);
  assert.ok(!sydney.core.includes('__TZ__'));
  const dflt = await servedCore(null);
  assert.match(dflt.core, /const MINT_TZ = 'Australia\/Perth';/);
  const version = (h) => /core\.js\?v=([0-9a-f]+)/.exec(h.html)[1];
  assert.notEqual(version(sydney), version(dflt), 'the asset version changes with the zone, so cached shells are replaced');
});

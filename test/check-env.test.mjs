// The deploy preflight: fails by name when an opted-in setting is missing, passes when all
// are present, passes for a plain local instance with no flags, and never prints a value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEnv } from '../lib/envcheck.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CERT = Array.from({ length: 32 }, (_, i) => ((i * 7 + 3) % 256).toString(16).padStart(2, '0')).join(':');
const keyFile = join(mkdtempSync(join(tmpdir(), 'mint-checkenv-key-')), 'k');
const RECIPIENT = /Public key: (age1\S+)/.exec(spawnSync('age-keygen', ['-o', keyFile], { encoding: 'utf8' }).stderr)[1];
const FULL = { MINT_REQUIRE_OFFBOX: '1', MINT_REQUIRE_ANDROID: '1', MINT_BACKUP_HOST: 'a-host', MINT_BACKUP_AGE_RECIPIENT: RECIPIENT, MINT_ANDROID_CERT_SHA256: CERT };

function preflight(env) {
  const home = mkdtempSync(join(tmpdir(), 'mint-checkenv-'));
  writeFileSync(join(home, '.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  return spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-env.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH, MINT_HOME: home } });
}

test('with the flags set and every key present it passes', () => {
  assert.deepEqual(checkEnv(FULL), { checked: ['MINT_BACKUP_HOST', 'MINT_BACKUP_AGE_RECIPIENT', 'MINT_ANDROID_CERT_SHA256'], missing: [], ok: true });
  const r = preflight(FULL);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MINT_BACKUP_HOST, MINT_BACKUP_AGE_RECIPIENT, MINT_ANDROID_CERT_SHA256 present and valid/);
});

test('with the flags set, each missing or malformed key fails by name only', () => {
  for (const [drop, bad] of [['MINT_BACKUP_HOST', ''], ['MINT_BACKUP_AGE_RECIPIENT', 'age1notakey'], ['MINT_ANDROID_CERT_SHA256', 'not-a-fingerprint']]) {
    const env = { ...FULL, [drop]: bad };
    const r = preflight(env);
    assert.equal(r.status, 1, drop);
    assert.match(r.stderr, new RegExp(drop));
    for (const secret of [RECIPIENT, CERT, 'a-host', bad].filter(Boolean)) assert.ok(!(r.stdout + r.stderr).includes(secret), `${drop}: no value is printed`);
  }
  const none = preflight({ MINT_REQUIRE_OFFBOX: '1', MINT_REQUIRE_ANDROID: '1' });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /MINT_BACKUP_HOST, MINT_BACKUP_AGE_RECIPIENT, MINT_ANDROID_CERT_SHA256/);
});

test('each flag only checks its own keys', () => {
  assert.deepEqual(checkEnv({ MINT_REQUIRE_OFFBOX: '1' }).missing, ['MINT_BACKUP_HOST', 'MINT_BACKUP_AGE_RECIPIENT']);
  assert.deepEqual(checkEnv({ MINT_REQUIRE_ANDROID: 'true' }).missing, ['MINT_ANDROID_CERT_SHA256']);
});

test("a stranger's local instance with no flags passes without anything configured", () => {
  const r = preflight({ MINT_ORIGIN: 'http://localhost:8970', REDBARK_API_KEY: 'rbk_live_xxx' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing required/);
  assert.equal(checkEnv({}).ok, true);
  assert.equal(checkEnv({ MINT_REQUIRE_OFFBOX: '0' }).ok, true);
});

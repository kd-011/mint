// Encrypted off-box backups: the NAS copy and the receipts mirror leave this
// box as age files only, the local VACUUM snapshots stay as they are, and the
// restore test decrypts with the private key and still checks integrity and
// row counts. ssh and rsync are stood in for by scripts that run against a
// local "NAS" directory, so the real scripts run end to end.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { book } from './fixtures/book.mjs';
import { encryptFile, decryptFile, mirrorEncrypted, isAgeFile, validRecipient } from '../lib/backupcrypt.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RSYNC = spawnSync('sh', ['-c', 'command -v rsync'], { encoding: 'utf8' }).stdout.trim();
let work, bin, keyFile, wrongKey, recipient;

function keygen(path) {
  const r = spawnSync('age-keygen', ['-o', path], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return /Public key: (age1\S+)/.exec(r.stderr)[1];
}

// A Mint home with a small book and two receipts.
function mintHome() {
  const home = mkdtempSync(join(work, 'home-'));
  mkdirSync(join(home, 'data', 'receipts'), { recursive: true });
  const b = book();
  for (let i = 1; i <= 25; i++) b.add('acct_t_everyday', `2026-09-${String(i).padStart(2, '0')}`, -1000 * i, `TEST SHOP ${i}`);
  b.db.prepare("INSERT INTO balance_snapshots (account_id, date, current) VALUES ('acct_t_everyday', '2026-10-16', 100000)").run();
  b.db.exec(`VACUUM INTO '${join(home, 'data', 'mint.db')}'`);
  writeFileSync(join(home, 'data', 'receipts', `${'a'.repeat(32)}.pdf`), '%PDF-1.4 invented receipt one');
  writeFileSync(join(home, 'data', 'receipts', `${'b'.repeat(32)}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));
  return home;
}

function run(script, env) {
  return spawnSync(process.execPath, [join(ROOT, 'scripts', script)], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: work, MINT_BACKUP_HOST: 'fakenas', ...env },
  });
}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mint-backup-'));
  bin = join(work, 'bin');
  mkdirSync(bin);
  // ssh -o A -o B host 'cmd' runs cmd here; rsync drops -e and the host: prefix.
  writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nwhile [ "$1" = "-o" ]; do shift 2; done\nshift\nexec sh -c "$*"\n');
  writeFileSync(join(bin, 'rsync'), `#!/bin/sh\nskip=\nfor a; do\n  shift\n  if [ -n "$skip" ]; then skip=; continue; fi\n  case "$a" in -e) skip=1; continue;; fakenas:*) a="\${a#fakenas:}";; esac\n  set -- "$@" "$a"\ndone\nexec ${RSYNC} "$@"\n`);
  chmodSync(join(bin, 'ssh'), 0o755);
  chmodSync(join(bin, 'rsync'), 0o755);
  keyFile = join(work, 'mint-backup-age.key');
  recipient = keygen(keyFile);
  wrongKey = join(work, 'other.key');
  keygen(wrongKey);
});

test('recipient check accepts an age public key and nothing else', () => {
  assert.equal(validRecipient(recipient), true);
  for (const bad of ['', 'age1short', 'ssh-ed25519 AAAA', `${recipient}x`, `AGE-SECRET-KEY-1${'Q'.repeat(58)}`]) assert.equal(validRecipient(bad), false, bad);
});

test('encrypt and decrypt round trip, and the wrong key fails', () => {
  const dir = mkdtempSync(join(work, 'rt-'));
  writeFileSync(join(dir, 'plain'), 'invented bank history');
  encryptFile(join(dir, 'plain'), join(dir, 'plain.age'), recipient);
  assert.equal(isAgeFile(join(dir, 'plain.age')), true);
  assert.equal(isAgeFile(join(dir, 'plain')), false);
  assert.doesNotMatch(readFileSync(join(dir, 'plain.age'), 'latin1'), /invented bank history/);
  decryptFile(join(dir, 'plain.age'), join(dir, 'back'), keyFile);
  assert.equal(readFileSync(join(dir, 'back'), 'utf8'), 'invented bank history');
  assert.throws(() => decryptFile(join(dir, 'plain.age'), join(dir, 'nope'), wrongKey));
});

test('the receipts mirror encrypts new files once and drops removed ones', () => {
  const src = mkdtempSync(join(work, 'rsrc-'));
  const stage = join(work, `rstage-${Date.now()}`);
  writeFileSync(join(src, 'one.pdf'), '%PDF one');
  writeFileSync(join(src, 'two.pdf'), '%PDF two');
  assert.deepEqual(mirrorEncrypted(src, stage, recipient), { added: 2, removed: 0, total: 2 });
  const before = statSync(join(stage, 'one.pdf.age')).mtimeMs;
  assert.deepEqual(mirrorEncrypted(src, stage, recipient), { added: 0, removed: 0, total: 2 });
  assert.equal(statSync(join(stage, 'one.pdf.age')).mtimeMs, before, 'an unchanged receipt is not re-encrypted');
  spawnSync('rm', [join(src, 'two.pdf')]);
  assert.deepEqual(mirrorEncrypted(src, stage, recipient), { added: 0, removed: 1, total: 1 });
  assert.deepEqual(readdirSync(stage), ['one.pdf.age']);
  assert.equal(statSync(stage).mode & 0o077, 0);
});

test('backup sends only age files to the NAS and keeps the local snapshot', () => {
  const home = mintHome();
  const nas = join(work, 'nas-ok');
  mkdirSync(nas);
  writeFileSync(join(nas, 'mint-2026-10-01.db.gz'), 'an old unencrypted copy');
  const r = run('backup.mjs', { MINT_HOME: home, MINT_BACKUP_DIR: nas, MINT_BACKUP_AGE_RECIPIENT: recipient });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const files = readdirSync(nas).sort();
  const enc = files.filter((f) => /^mint-\d{4}-\d{2}-\d{2}\.db\.gz\.age$/.test(f));
  assert.equal(enc.length, 1, files.join(', '));
  assert.ok(files.includes('mint-2026-10-01.db.gz'), 'old unencrypted copies are left for the owner');
  assert.equal(isAgeFile(join(nas, enc[0])), true);
  assert.notEqual(spawnSync('gunzip', ['-t', join(nas, enc[0])]).status, 0, 'a plain gunzip must fail');
  assert.ok(!files.some((f) => /^mint-\d{4}-\d{2}-\d{2}\.db\.gz$/.test(f) && f !== 'mint-2026-10-01.db.gz'), 'no new plaintext copy');
  assert.equal(existsSync(join(nas, 'receipts')), false, 'no plaintext receipts mirror');
  const receipts = readdirSync(join(nas, 'receipts-age')).sort();
  assert.deepEqual(receipts, [`${'a'.repeat(32)}.pdf.age`, `${'b'.repeat(32)}.png.age`]);
  for (const f of receipts) assert.equal(isAgeFile(join(nas, 'receipts-age', f)), true, f);
  const local = readdirSync(join(home, 'backups'));
  assert.ok(local.some((f) => /^mint-\d{4}-\d{2}-\d{2}\.db$/.test(f)), 'the local VACUUM snapshot stays');
  assert.ok(!local.some((f) => /\.gz$/.test(f)), 'no gzip left behind');
  assert.doesNotMatch(r.stdout + r.stderr, /AGE-SECRET-KEY/);

  const ok = run('restore-test.mjs', { MINT_HOME: home, MINT_BACKUP_DIR: nas, MINT_BACKUP_AGE_KEY: keyFile });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(ok.stdout, /integrity ok/);
  assert.match(ok.stdout, /transactions: restored 25, live 25/);
  assert.match(ok.stdout, /balance_snapshots: restored 1, live 1/);
  assert.match(ok.stdout, /receipts: 2 off-box, 2 live/);
  assert.doesNotMatch(ok.stdout + ok.stderr, /AGE-SECRET-KEY/);

  const bad = run('restore-test.mjs', { MINT_HOME: home, MINT_BACKUP_DIR: nas, MINT_BACKUP_AGE_KEY: wrongKey });
  assert.notEqual(bad.status, 0, 'the wrong key cannot restore');
  const none = run('restore-test.mjs', { MINT_HOME: home, MINT_BACKUP_DIR: nas, MINT_BACKUP_AGE_KEY: join(work, 'missing.key') });
  assert.notEqual(none.status, 0);
});

test('backup refuses the off-box copy without a recipient, but still snapshots locally', () => {
  const home = mintHome();
  const nas = join(work, 'nas-none');
  mkdirSync(nas);
  const r = run('backup.mjs', { MINT_HOME: home, MINT_BACKUP_DIR: nas });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MINT_BACKUP_AGE_RECIPIENT/);
  assert.deepEqual(readdirSync(nas), []);
  assert.ok(readdirSync(join(home, 'backups')).some((f) => /^mint-.*\.db$/.test(f)));
});

test('backup reads the recipient from the Mint .env', () => {
  const home = mintHome();
  const nas = join(work, 'nas-env');
  mkdirSync(nas);
  writeFileSync(join(home, '.env'), `MINT_BACKUP_AGE_RECIPIENT=${recipient}\n`);
  const r = run('backup.mjs', { MINT_HOME: home, MINT_BACKUP_DIR: nas });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(readdirSync(nas).some((f) => f.endsWith('.db.gz.age')));
});

test('a malformed recipient is refused before anything leaves the box', () => {
  const home = mintHome();
  const nas = join(work, 'nas-bad');
  mkdirSync(nas);
  const r = run('backup.mjs', { MINT_HOME: home, MINT_BACKUP_DIR: nas, MINT_BACKUP_AGE_RECIPIENT: 'age1notakey' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(readdirSync(nas), []);
});

test('a recipient with no MINT_BACKUP_HOST fails loudly, so the timer goes red instead of green without an off-box copy', () => {
  const home = mintHome();
  const r = run('backup.mjs', { MINT_HOME: home, MINT_BACKUP_HOST: '', MINT_BACKUP_AGE_RECIPIENT: recipient });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MINT_BACKUP_HOST is not/);
  assert.ok(readdirSync(join(home, 'backups')).some((f) => /^mint-.*\.db$/.test(f)), 'the local snapshot is still made');
});

test('with neither a host nor a recipient it makes the local snapshot only and exits 0', () => {
  const home = mintHome();
  const r = run('backup.mjs', { MINT_HOME: home, MINT_BACKUP_HOST: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /local snapshot only/);
});

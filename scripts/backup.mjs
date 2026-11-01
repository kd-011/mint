// Mint backup, systemd user oneshot (mint-backup.timer, daily 00:45).
// 1. VACUUM INTO snapshot of data/mint.db into backups/, keep newest 14.
// 2. Off-box copy, encrypted with age to MINT_BACKUP_AGE_RECIPIENT before it
//    leaves: the gzipped snapshot as mint-<date>.db.gz.age on the host named
//    by MINT_BACKUP_HOST (over ssh and rsync, keep 14), and data/receipts/ as
//    an encrypted mirror in receipts-age/. No MINT_BACKUP_HOST, no off-box
//    copy: only the local snapshot is made. A host but no recipient, no
//    off-box copy: nothing goes out in the clear. Exits non-zero when the
//    off-box copy fails so the unit shows red.
//    Older unencrypted mint-*.db.gz copies on the backup host are left alone.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, unlinkSync, statSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/env.mjs';
import { encryptFile, mirrorEncrypted, validRecipient } from '../lib/backupcrypt.mjs';

process.umask(0o077);
const ROOT = process.env.MINT_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));
const KEEP = 14;
const REMOTE_HOST = (process.env.MINT_BACKUP_HOST ?? '').trim(); // an ssh host name, e.g. from ~/.ssh/config
const REMOTE_DIR = (process.env.MINT_BACKUP_DIR ?? '').trim() || 'mint-backups'; // relative to the ssh login's home unless absolute
const RECIPIENT = (process.env.MINT_BACKUP_AGE_RECIPIENT ?? '').trim();
const SSH = 'ssh -o ConnectTimeout=10 -o BatchMode=yes';
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) console.error(`${cmd} failed: ${String(r.stderr ?? '').trim().slice(0, 300)}`);
  return r;
};

const backups = join(ROOT, 'backups');
mkdirSync(backups, { recursive: true, mode: 0o700 });
const stamp = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Perth' });
const target = join(backups, `mint-${stamp}.db`);
try { unlinkSync(target); } catch {}
const db = new DatabaseSync(join(ROOT, 'data', 'mint.db'), { readOnly: true });
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();
chmodSync(target, 0o600);
console.log(`snapshot ${target} (${(statSync(target).size / 1024).toFixed(0)}KB)`);

const old = readdirSync(backups).filter((f) => /^mint-.*\.db$/.test(f)).sort().reverse().slice(KEEP);
for (const f of old) { unlinkSync(join(backups, f)); console.log(`pruned ${f}`); }

if (!REMOTE_HOST) {
  if (RECIPIENT) {
    // An install that was set up for off-box copies must not go quietly green without them.
    console.error('MINT_BACKUP_AGE_RECIPIENT is set but MINT_BACKUP_HOST is not: no off-box copy was made. Set MINT_BACKUP_HOST (and MINT_BACKUP_DIR) in .env.');
    process.exit(1);
  }
  console.log('MINT_BACKUP_HOST is not set: local snapshot only, no off-box copy');
  process.exit(0);
}
if (!validRecipient(RECIPIENT)) {
  console.error(`MINT_BACKUP_AGE_RECIPIENT ${RECIPIENT ? 'is not an age public key' : 'is not set'}: no off-box copy made, nothing leaves unencrypted`);
  process.exit(1);
}

const gzPath = `${target}.gz`;
const agePath = `${gzPath}.age`;
const receipts = join(ROOT, 'data', 'receipts');
const stage = join(backups, 'receipts-age');
let mirror = null;
try {
  if (run('gzip', ['-kf', target]).status !== 0) throw new Error('gzip failed');
  encryptFile(gzPath, agePath, RECIPIENT);
  if (existsSync(receipts)) mirror = mirrorEncrypted(receipts, stage, RECIPIENT);
} catch (e) {
  console.error(`encryption failed: ${e.message}`);
  for (const f of [gzPath, agePath]) try { unlinkSync(f); } catch {}
  process.exit(1);
}
unlinkSync(gzPath);

const sshArgs = SSH.split(' ').slice(1);
const prune = `cd ${REMOTE_DIR} && ls -t mint-*.db.gz.age 2>/dev/null | tail -n +${KEEP + 1} | xargs -r rm --`;
const ok =
  run('ssh', [...sshArgs, REMOTE_HOST, `mkdir -p -m 700 ${REMOTE_DIR}`]).status === 0 &&
  run('rsync', ['-a', '--chmod=F600', '-e', SSH, agePath, `${REMOTE_HOST}:${REMOTE_DIR}/`]).status === 0 &&
  (!mirror || run('rsync', ['-a', '--delete', '--chmod=D700,F600', '-e', SSH, `${stage}/`, `${REMOTE_HOST}:${REMOTE_DIR}/receipts-age/`]).status === 0) &&
  run('ssh', [...sshArgs, REMOTE_HOST, prune]).status === 0;
unlinkSync(agePath);
if (!ok) {
  console.error(`off-box copy failed (${REMOTE_HOST} unreachable or rsync failed)`);
  process.exit(1);
}
console.log(`off-box copy (age) -> ${REMOTE_HOST}:${REMOTE_DIR}/${mirror ? `, receipts ${mirror.total} (${mirror.added} new, ${mirror.removed} dropped)` : ''}`);

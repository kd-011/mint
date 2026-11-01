// Restore test (BAK-2): pull the newest off-box backup (MINT_BACKUP_HOST), decrypt it with the age
// private key (MINT_BACKUP_AGE_KEY, default ~/.secrets/mint-backup-age.key),
// unpack it to a temp dir, check integrity, and compare row counts with the
// live database. Then check the encrypted receipts mirror: file count against
// data/receipts and one receipt decrypted and compared byte for byte. Read
// only on both sides. Run: node scripts/restore-test.mjs
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptFile } from '../lib/backupcrypt.mjs';
import { loadEnv } from '../lib/env.mjs';

const ROOT = process.env.MINT_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));
const HOST = (process.env.MINT_BACKUP_HOST ?? '').trim();
const DIR = (process.env.MINT_BACKUP_DIR ?? '').trim() || 'mint-backups';
const KEY = process.env.MINT_BACKUP_AGE_KEY || join(homedir(), '.secrets', 'mint-backup-age.key');
const ssh = ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes'];
const remoteLines = (cmd) => {
  const r = spawnSync('ssh', [...ssh, HOST, cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : null;
};
const pull = (remote, dir) => {
  if (spawnSync('rsync', ['-a', '-e', `ssh ${ssh.join(' ')}`, `${HOST}:${remote}`, `${dir}/`]).status !== 0) throw new Error(`rsync of ${remote} failed`);
  return join(dir, remote.split('/').pop());
};

if (!HOST) { console.error('MINT_BACKUP_HOST is not set: nothing to restore from'); process.exit(1); }
if (!existsSync(KEY)) { console.error(`no age private key at ${KEY}`); process.exit(1); }
const remote = (remoteLines(`ls -t ${DIR}/mint-*.db.gz.age | head -1`) ?? [])[0];
if (!remote) { console.error(`no encrypted backup found on ${HOST}:${DIR}`); process.exit(1); }
const tmp = mkdtempSync(join(tmpdir(), 'mint-restore-'));
let ok = false;
try {
  const enc = pull(remote, tmp);
  const gz = enc.replace(/\.age$/, '');
  decryptFile(enc, gz, KEY);
  if (spawnSync('gunzip', [gz]).status !== 0) throw new Error('gunzip failed');
  const restored = new DatabaseSync(gz.replace(/\.gz$/, ''), { readOnly: true });
  const live = new DatabaseSync(join(ROOT, 'data', 'mint.db'), { readOnly: true });
  const integrity = restored.prepare('PRAGMA integrity_check').get().integrity_check;
  console.log(`${remote}: decrypted, integrity ${integrity}`);
  ok = integrity === 'ok';
  for (const t of ['connections', 'accounts', 'transactions', 'balance_snapshots']) {
    const r = restored.prepare(`SELECT count(*) n FROM ${t}`).get().n;
    const l = live.prepare(`SELECT count(*) n FROM ${t}`).get().n;
    console.log(`${t}: restored ${r}, live ${l}`);
    if (r === 0 && l > 0) ok = false;
  }
  restored.close();
  live.close();

  const liveDir = join(ROOT, 'data', 'receipts');
  const liveReceipts = existsSync(liveDir) ? readdirSync(liveDir) : [];
  const nas = remoteLines(`cd ${DIR}/receipts-age 2>/dev/null && ls -t | grep '\\.age$' || true`);
  if (nas === null) throw new Error('could not list the receipts mirror');
  console.log(`receipts: ${nas.length} off-box, ${liveReceipts.length} live`);
  if (!nas.length && liveReceipts.length) ok = false;
  const sample = nas.find((f) => liveReceipts.includes(f.replace(/\.age$/, '')));
  if (sample) {
    const out = join(tmp, 'receipt-check');
    decryptFile(pull(`${DIR}/receipts-age/${sample}`, tmp), out, KEY);
    const same = readFileSync(out).equals(readFileSync(join(liveDir, sample.replace(/\.age$/, ''))));
    console.log(`receipt sample: decrypted, ${same ? 'matches' : 'DOES NOT match'} the live file`);
    if (!same) ok = false;
  }
} catch (e) {
  console.error(`restore failed: ${e.message}`);
  ok = false;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (!ok) process.exit(1);

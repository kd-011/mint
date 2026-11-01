// Break glass for the fingerprint lock (lost or reset phone). Needs a shell on
// the box, which is the bar: the web side never clears the last fingerprint.
//   node scripts/lock-reset.mjs              shows what is enrolled, changes nothing
//   node scripts/lock-reset.mjs --yes        removes every fingerprint and unlock
//                                            session and rotates the cookie secret;
//                                            the lock stays on and the next open of
//                                            Mint offers "Set up fingerprint" again
//   node scripts/lock-reset.mjs --yes --disable
//                                            the same, and forgets that the lock was
//                                            ever enabled, so MINT_LOCK=off in .env is
//                                            honoured on the next start
// Safe with mint.service running (sessions are checked against the table on
// every request). [--db path] picks another database.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getSetting } from '../lib/db.mjs';
import { createLock } from '../lib/lock.mjs';
import { loadEnv } from '../lib/env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const path = flag('--db') ? args[args.indexOf('--db') + 1] : join(process.env.MINT_HOME || ROOT, 'data', 'mint.db');

loadEnv(join(process.env.MINT_HOME || ROOT, '.env'));
const db = openDb(path);
// The origin only names the rp id for the fingerprint rows; use the one Mint serves from.
const lock = createLock({ db, origin: (process.env.MINT_ORIGIN || '').trim().replace(/\/+$/, '') || 'http://localhost' });
const creds = lock.credentials();
const sessions = db.prepare('SELECT count(*) n FROM lock_sessions').get().n;
console.log(`${path}: ${creds.length} fingerprint(s), ${sessions} session(s), lock enabled since ${getSetting(db, 'lock_enabled_at') ?? 'never'}`);
for (const c of creds) console.log(`  ${c.label} (added ${c.created_at.slice(0, 10)}, last used ${c.last_used_at?.slice(0, 10) ?? 'never'})`);

if (!flag('--yes')) {
  console.log('dry run: pass --yes to clear them (and --disable to let MINT_LOCK=off switch the lock off)');
} else {
  lock.reset();
  if (flag('--disable')) db.prepare("DELETE FROM settings WHERE key = 'lock_enabled_at'").run();
  console.log(`cleared: fingerprints and sessions gone, cookie secret rotated.${flag('--disable') ? ' Lock marked never enabled: MINT_LOCK=off is honoured on the next start.' : ' The lock stays on; the next open of Mint offers set up.'}`);
}
db.close();

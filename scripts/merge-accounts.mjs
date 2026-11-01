// Folds accounts that are the same real bank account under two Redbark ids (see
// lib/accountmerge.mjs). The sync only reports them; this is the one way to merge,
// look first, apply second, and to take one back.
//   node scripts/merge-accounts.mjs [--db path]            dry run: counts, nothing written
//   node scripts/merge-accounts.mjs --apply [--db path]    snapshot to backups/, then merge
//   node scripts/merge-accounts.mjs --undo <merge id> [--db path]
//   node scripts/merge-accounts.mjs --list [--db path]     merges made so far
// The dry run works on a VACUUM INTO copy of the database; the live file is only
// opened for writing by --apply and --undo.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/db.mjs';
import { mergeDuplicateAccounts, undoMerge } from '../lib/accountmerge.mjs';

process.umask(0o077); // the pre-merge snapshot is a full copy of the book

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const src = flag('--db') ? args[args.indexOf('--db') + 1] : join(process.env.MINT_HOME || ROOT, 'data', 'mint.db');
const sq = (p) => p.replace(/'/g, "''");

function show({ merges, skipped }, label) {
  if (!merges.length) console.log(`${label}: no duplicate accounts`);
  for (const m of merges) {
    console.log(`${label}: ${m.institution} ${m.number}: ${m.from} (${m.from_tx} tx) into ${m.into} (${m.into_tx} tx)`
      + ` | ${m.moved} tx move, ${m.duplicates_left} duplicate tx stay on the retired row (${m.annotations_carried} annotations carried, ${m.links_repointed} links re-pointed, ${m.links_blocked} blocked), ${m.snapshots_moved} balance days move, ${m.repointed} account links (rules, goals, pay plan) re-pointed`);
  }
  for (const s of skipped) console.log(`left alone: ${s.ids.join(', ')}: ${s.reason}`);
  const t = (k) => merges.reduce((n, m) => n + m[k], 0);
  console.log(`total: ${merges.length} account(s), ${t('moved')} tx move, ${t('duplicates_left')} duplicate tx left on the retired row`);
}

if (flag('--undo')) {
  const db = openDb(src);
  const m = undoMerge(db, Number(args[args.indexOf('--undo') + 1]));
  console.log(`undone: ${m.from} restored, ${m.moved} tx back. It will not be merged again.`);
} else if (flag('--list')) {
  const db = openDb(src);
  for (const r of db.prepare('SELECT id, from_id, into_id, merged_at, undone_at, summary FROM account_merges ORDER BY id').all()) {
    const s = JSON.parse(r.summary);
    console.log(`#${r.id} ${r.merged_at} ${r.from_id} -> ${r.into_id} (${s.moved} tx moved, ${s.duplicates_left} left)${r.undone_at ? ` UNDONE ${r.undone_at}` : ''}`);
  }
} else if (flag('--apply')) {
  const backups = join(process.env.MINT_HOME || ROOT, 'backups');
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  const db = openDb(src);
  const snap = join(backups, `mint-premerge-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.exec(`VACUUM INTO '${sq(snap)}'`);
  console.log(`snapshot ${snap}`);
  show(mergeDuplicateAccounts(db), 'merged');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'mint-merge-'));
  try {
    const copy = join(dir, 'copy.db');
    new DatabaseSync(src, { readOnly: true }).exec(`VACUUM INTO '${sq(copy)}'`);
    show(mergeDuplicateAccounts(openDb(copy), { dryRun: true }), 'dry run');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

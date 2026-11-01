// Encryption for everything that leaves this box in a backup, with age
// (/usr/bin/age). Only the recipient (public key) is configured, in .env as
// MINT_BACKUP_AGE_RECIPIENT; the private key sits in
// ~/.secrets/mint-backup-age.key (mode 600, or MINT_BACKUP_AGE_KEY) and is only
// read by the restore test. Neither key is ever logged.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, unlinkSync, existsSync, openSync, readSync, closeSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const HEADER = 'age-encryption.org/v1\n';
// bech32: "age1" then 58 characters of the data alphabet.
const RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;

export const validRecipient = (r) => RECIPIENT.test(String(r ?? ''));

function age(args) {
  const r = spawnSync('age', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.error) throw new Error(`age could not run: ${r.error.code ?? r.error.message}`);
  if (r.status !== 0) throw new Error(`age failed: ${String(r.stderr ?? '').trim().slice(0, 200)}`);
}

export function encryptFile(src, dst, recipient) {
  if (!validRecipient(recipient)) throw new Error('not an age recipient');
  age(['-r', recipient, '-o', dst, src]);
  chmodSync(dst, 0o600);
}

export function decryptFile(src, dst, keyFile) {
  if (!existsSync(keyFile)) throw new Error(`no private key at ${keyFile}`);
  try {
    age(['-d', '-i', keyFile, '-o', dst, src]);
  } catch (e) {
    try { unlinkSync(dst); } catch {}
    throw e;
  }
}

export function isAgeFile(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(HEADER.length);
    return readSync(fd, buf, 0, buf.length, 0) === buf.length && buf.toString('latin1') === HEADER;
  } finally {
    closeSync(fd);
  }
}

// An encrypted mirror of a flat directory: each file becomes <name>.age in
// stageDir. Receipts never change once written (random names, written once),
// so a file is encrypted the first time it is seen and its .age is kept; that
// keeps rsync from re-sending the whole mirror every night. Files gone from
// srcDir are dropped from the mirror.
export function mirrorEncrypted(srcDir, stageDir, recipient) {
  if (!validRecipient(recipient)) throw new Error('not an age recipient');
  mkdirSync(stageDir, { recursive: true, mode: 0o700 });
  chmodSync(stageDir, 0o700);
  const src = existsSync(srcDir) ? readdirSync(srcDir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name) : [];
  const want = new Set(src.map((f) => `${f}.age`));
  let added = 0;
  let removed = 0;
  for (const f of src) {
    const out = join(stageDir, `${f}.age`);
    if (existsSync(out)) continue;
    const tmp = `${out}.part`;
    encryptFile(join(srcDir, f), tmp, recipient);
    renameSync(tmp, out);
    added += 1;
  }
  for (const f of readdirSync(stageDir)) {
    if (want.has(f)) continue;
    unlinkSync(join(stageDir, f));
    if (!f.endsWith('.part')) removed += 1;
  }
  return { added, removed, total: want.size };
}

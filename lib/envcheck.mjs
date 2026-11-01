// Preflight for a configured install: which required settings are missing from the
// environment. Pure, and it only ever returns variable NAMES, never values.
//
// Nothing is required by default (a trial or a stranger's local instance needs none of
// this). An install that depends on off-box backups or on the Android app opts in:
//   MINT_REQUIRE_OFFBOX=1    needs MINT_BACKUP_HOST and a valid MINT_BACKUP_AGE_RECIPIENT
//   MINT_REQUIRE_ANDROID=1   needs a valid MINT_ANDROID_CERT_SHA256
// so a deploy with the wrong .env stops loudly instead of quietly dropping backups or passkeys.
import { validRecipient } from './backupcrypt.mjs';

const on = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const FINGERPRINT = /^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/;

export function checkEnv(env) {
  const checked = [];
  const missing = [];
  const need = (name, ok) => { checked.push(name); if (!ok) missing.push(name); };
  if (on(env.MINT_REQUIRE_OFFBOX)) {
    need('MINT_BACKUP_HOST', String(env.MINT_BACKUP_HOST ?? '').trim() !== '');
    need('MINT_BACKUP_AGE_RECIPIENT', validRecipient(String(env.MINT_BACKUP_AGE_RECIPIENT ?? '').trim()));
  }
  if (on(env.MINT_REQUIRE_ANDROID)) need('MINT_ANDROID_CERT_SHA256', FINGERPRINT.test(String(env.MINT_ANDROID_CERT_SHA256 ?? '').trim()));
  return { checked, missing, ok: missing.length === 0 };
}

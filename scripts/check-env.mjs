// Preflight: node scripts/check-env.mjs
// Loads .env the way server.mjs does (MINT_HOME or the repo folder) and exits 1, printing
// variable names only, never values, when a setting this install opted into (see
// lib/envcheck.mjs) is missing or malformed. Exit 0 and a one-line summary otherwise.
// The maintainer's mint.service runs it as ExecStartPre, so a restart with the wrong
// .env fails loudly. With no MINT_REQUIRE_* flag set it checks nothing and passes.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/env.mjs';
import { checkEnv } from '../lib/envcheck.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(process.env.MINT_HOME || ROOT, '.env'));
const r = checkEnv(process.env);
if (!r.ok) {
  console.error(`env check failed: missing or invalid in .env: ${r.missing.join(', ')}`);
  process.exit(1);
}
console.log(r.checked.length ? `env check ok: ${r.checked.join(', ')} present and valid` : 'env check ok: nothing required (no MINT_REQUIRE_* flag set)');

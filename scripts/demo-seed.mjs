// A throwaway Mint over made-up data, for a first look or a screenshot. No bank
// account, no Redbark key and no existing data needed: it starts a fake Redbark,
// a real server.mjs in an empty temp directory, seeds budgets, goals, assets,
// shares, subscriptions and a few debts, and serves the result on one local port.
//
//   node scripts/demo-seed.mjs [port] [--empty] [--home DIR]
//
// Then open http://127.0.0.1:<port>/ (default 8980). Everything is invented, dated
// relative to today (Perth). Ctrl-C stops it and deletes the temp directory.
// It is the engine in scripts/ui-fixture.mjs with the demo defaults.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const hasPort = args.some((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--home');
const child = spawn(process.execPath, [join(here, 'ui-fixture.mjs'), ...(hasPort ? [] : ['8980']), '--today', 'now', '--browse', ...args], { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));

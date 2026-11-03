// Your own book on this machine, with no login proxy and no Redbark account: the real server, kept behind
// a small front that lets in this machine's browser and nothing else (lib/localfront.mjs).
//
//   node scripts/local.mjs                       http://127.0.0.1:8981/ (MINT_PORT changes it)
//   docker compose --profile local up -d         the same in a container, with the book in a volume
//
// Unlike scripts/demo-seed.mjs nothing here is invented and nothing is deleted on exit: the book is
// MINT_HOME/data/mint.db. Anyone with an account on this machine can open that port. For a phone, or
// anything beyond this machine, use a real login proxy instead: docs/self-hosting.md.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createFront } from '../lib/localfront.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.MINT_PORT || 8981);
const freePort = () => new Promise((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const inner = await freePort();
// Fresh each run. It only has to be something Mint's gate can check: nothing but the front ever sends it.
const gate = randomBytes(24).toString('hex');
const origin = `http://127.0.0.1:${PORT}`;
let up = false;

const server = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
  env: { ...process.env, MINT_PORT: String(inner), MINT_HOST: '127.0.0.1', MINT_USER: 'owner', MINT_GATE_KEY: gate, MINT_LOCK: 'off', MINT_ORIGIN: origin, NODE_NO_WARNINGS: '1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
// Mint's own log, minus the lines about features that make no sense here.
createInterface({ input: server.stdout }).on('line', (l) => { if (!/^(android|chat): |^mint listening/.test(l)) console.log(l); });

const front = createFront({ innerPort: inner, gate, upstreamOrigin: origin, ready: () => up })
  .listen(PORT, process.env.MINT_LOCAL_BIND || '127.0.0.1');

const stop = () => { front.close(); server.kill('SIGTERM'); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
server.on('exit', (code) => process.exit(code ?? 0));

for (let i = 0; i < 150 && !up; i++) {
  try { up = (await fetch(`http://127.0.0.1:${inner}/healthz`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
}
console.log(up ? `ready: open ${origin}/ (Ctrl-C stops Mint, your book stays)` : 'Mint did not answer in 30 seconds, see the errors above');

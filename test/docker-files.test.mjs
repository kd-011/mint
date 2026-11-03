// The Docker files only mean something if they point at real paths. No docker needed here: this
// reads Dockerfile, docker-compose.yml and .dockerignore and checks them against the tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const dockerfile = () => read('Dockerfile');
const copies = () => [...dockerfile().matchAll(/^COPY\s+(?:--\S+\s+)*(.+?)\s+(\S+)$/gm)].flatMap((m) => m[1].split(/\s+/));

test('the three Docker files exist', () => {
  for (const f of ['Dockerfile', 'docker-compose.yml', '.dockerignore']) assert.ok(existsSync(join(ROOT, f)), `${f} exists`);
});

test('every COPY source in the Dockerfile is a real path', () => {
  const srcs = copies();
  assert.ok(srcs.length >= 5, 'the Dockerfile copies the server, lib, public, scripts and fixtures');
  for (const s of srcs) assert.ok(existsSync(join(ROOT, s)), `COPY source ${s} exists`);
});

test('the image runs as a non-root user, has a healthcheck and a data volume', () => {
  const d = dockerfile();
  assert.match(d, /^FROM node:22/m);
  assert.match(d, /^USER node$/m);
  assert.match(d, /^HEALTHCHECK .*\n?.*\/healthz/m);
  assert.match(d, /^VOLUME \/data$/m);
  assert.match(d, /MINT_HOME=\/data/);
  assert.match(d, /^CMD \["node", "server\.mjs"\]$/m);
  assert.ok(!/^RUN .*npm (install|ci)/m.test(d), 'no npm install: Mint has no dependencies');
});

test('.dockerignore keeps secrets and data out but not anything the Dockerfile copies', () => {
  const ign = read('.dockerignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const must of ['.git', '.env', 'data', 'backups', 'node_modules']) assert.ok(ign.includes(must), `${must} is ignored`);
  for (const s of copies()) assert.ok(!ign.includes(s) && !ign.includes(s.replace(/\/$/, '')), `${s} is copied, so it must not be ignored`);
  // the demo needs the fake Redbark, so the test fixtures must survive the ignore patterns
  assert.ok(!ign.includes('test') && !ign.includes('test/fixtures'));
});

test('compose: a demo that runs by default, and local and real services behind profiles, all on host loopback', () => {
  const c = read('docker-compose.yml');
  assert.match(c, /^services:\n {2}demo:/m);
  assert.match(c, /^ {2}mint:\n(?:.*\n)*? {4}profiles: \["real"\]/m);
  const ports = [...c.matchAll(/^\s+- "([^"]+)"$/gm)].map((m) => m[1]).filter((p) => /:\d+:\d+$/.test(p));
  assert.equal(ports.length, 3);
  for (const p of ports) assert.match(p, /^127\.0\.0\.1:/, `${p} publishes on the host's loopback only`);
  assert.match(c, /mint-data:\/data/);
  // the demo command points at a real script
  const cmd = /command: \["node", "([^"]+)"/.exec(c);
  assert.ok(cmd && existsSync(join(ROOT, cmd[1])), 'the demo command runs a real script');
});

test('the bind address stays loopback unless MINT_HOST is set, and only the image sets it', () => {
  assert.match(read('server.mjs'), /const HOST = \(process\.env\.MINT_HOST \|\| '127\.0\.0\.1'\)\.trim\(\);/);
  assert.match(read('server.mjs'), /server\.listen\(PORT, HOST,/);
  assert.match(dockerfile(), /MINT_HOST=0\.0\.0\.0/);
  assert.match(read('scripts/ui-fixture.mjs'), /process\.env\.MINT_DEMO_HOST \|\| '127\.0\.0\.1'/);
});

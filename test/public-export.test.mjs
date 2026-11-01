// scripts/export-public.mjs: the exclude list and the secret scan keep private files and
// secrets out of the public copy. Everything here runs on a throwaway git repo with
// invented content; the secret-looking strings are assembled at run time so this file
// itself holds none.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_KEY = ['rbk', 'live', 'Q7m2Zk9pLw4Xv8Rn3T'].join('_'); // not a real key
const FAKE_NAME = 'Quillfeather'; // an invented surname, standing in for the owner's name on the test denylist
const FAKE_EMAIL = ['pat.quillfeather', ['gmail', 'com'].join('.')].join('@'); // a personal mailbox, built at run time
const PUBLIC_ID = 'kd-011 229900447+kd-011@users.noreply.github.com kd-011 229900447+kd-011@users.noreply.github.com';
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.com', GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.com' };

let work, repo, denyFile;
const put = (root, rel, body) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { env: GIT_ENV, encoding: 'utf8' }).trim();

// A repo whose tracked files include things that must never be published.
function makeRepo(dir, { leak = false, denied = false, named = false, mailed = false } = {}) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test Author');
  git(dir, 'config', 'user.email', 'author@example.com');
  put(dir, 'README.md', '# Demo\n');
  put(dir, 'server.mjs', 'console.log("hi");\n');
  put(dir, 'lib/thing.mjs', 'export const x = 1;\n');
  put(dir, '.env.example', 'REDBARK_API_KEY=rbk_live_xxx\n');
  // tracked on purpose: the exclude list must still keep these out
  put(dir, '.env', `REDBARK_API_KEY=${FAKE_KEY}\n`);
  put(dir, 'data/mint.db', 'fake database bytes');
  put(dir, 'data/receipts/r1.jpg', 'fake receipt');
  put(dir, 'backups/mint-2026-01-01.db', 'fake backup');
  put(dir, 'android-shell/mint-upload.keystore', 'fake keystore');
  put(dir, 'android-shell/keystore.properties', 'storeFile=mint-upload.keystore\n');
  put(dir, '.shots/home.png', 'fake shot');
  put(dir, 'docs/demo-mode/m-home.png', 'fake shot of a real book');
  if (leak) put(dir, 'lib/leaky.mjs', `export const KEY = '${FAKE_KEY}';\n`);
  if (denied) put(dir, 'lib/host.mjs', '// served from my-private-host.invalid\n');
  if (named) put(dir, 'lib/credit.mjs', `// written for ${FAKE_NAME}\n`);
  if (mailed) put(dir, 'lib/contact.mjs', `// questions to ${FAKE_EMAIL}\n`);
  git(dir, 'add', '-A', '-f');
  git(dir, 'commit', '-q', '-m', 'private history');
}

const run = (script, args, cwd = ROOT) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, MINT_DENYLIST: denyFile } });
const exporter = join(ROOT, 'scripts', 'export-public.mjs');

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mint-export-test-'));
  repo = join(work, 'src');
  denyFile = join(work, 'denylist.txt');
  writeFileSync(denyFile, `# test denylist\nmy-private-host.invalid\n${FAKE_NAME.toLowerCase()}\nre:\\bquill ?feather\\b\n`);
});
after(() => rmSync(work, { recursive: true, force: true }));

// The script resolves its source repo from its own location, so run a copy of scripts/ that sits inside the throwaway repo.
function exportFrom(srcRepo, out, extra = [], scriptsDir = join(ROOT, 'scripts')) {
  const dest = join(srcRepo, '.export-scripts');
  rmSync(dest, { recursive: true, force: true });
  cpSync(scriptsDir, dest, { recursive: true });
  // the copy lives in <repo>/.export-scripts, so its `..` is the repo
  return { ...run(join(dest, 'export-public.mjs'), ['--out', out, ...extra]), dest };
}

test('a clean repo exports as one commit, no remote, without data, env, keystores, shots or old screenshot folders', () => {
  const src = join(work, 'clean');
  makeRepo(src);
  const out = join(work, 'out-clean');
  const r = exportFrom(src, out);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(git(out, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(git(out, 'remote'), '');
  for (const keep of ['README.md', 'server.mjs', 'lib/thing.mjs', '.env.example']) assert.ok(existsSync(join(out, keep)), `${keep} is kept`);
  for (const gone of ['.env', 'data', 'backups', 'android-shell/mint-upload.keystore', 'android-shell/keystore.properties', '.shots', 'docs/demo-mode']) {
    assert.ok(!existsSync(join(out, gone)), `${gone} was omitted`);
  }
  assert.ok(!git(out, 'log', '--all', '--format=%s').includes('private history'), 'no private history');
  assert.ok(!git(out, 'ls-files').split('\n').some((f) => /^(data|backups|\.shots)\/|^\.env$|keystore/.test(f)), 'none of it is tracked either');
  assert.match(r.stdout, /one commit/);
});

test('a planted secret in a tracked file makes the export refuse: non-zero, nothing written, the secret never printed', () => {
  const src = join(work, 'leaky');
  makeRepo(src, { leak: true });
  const out = join(work, 'out-leaky');
  const r = exportFrom(src, out);
  assert.notEqual(r.status, 0);
  assert.ok(!existsSync(out), 'no output directory was left behind');
  assert.match(r.stderr, /lib\/leaky\.mjs/);
  assert.match(r.stderr, /redbark-key/);
  assert.ok(!(r.stdout + r.stderr).includes(FAKE_KEY), 'the finding names the file and kind, never the value');
});

test('a denylisted string (your own domain, say) also makes it refuse', () => {
  const src = join(work, 'denied');
  makeRepo(src, { denied: true });
  const out = join(work, 'out-denied');
  const r = exportFrom(src, out);
  assert.notEqual(r.status, 0);
  assert.ok(!existsSync(out));
  assert.match(r.stderr, /denylisted string/);
});

test('it will not write inside the source repo, nor over a non-empty directory without --force', () => {
  const src = join(work, 'guarded');
  makeRepo(src);
  assert.notEqual(exportFrom(src, join(src, 'out-inside')).status, 0, 'inside the repo');
  const taken = join(work, 'taken');
  mkdirSync(taken);
  writeFileSync(join(taken, 'precious.txt'), 'keep me');
  const r = exportFrom(src, taken);
  assert.notEqual(r.status, 0);
  assert.equal(readFileSync(join(taken, 'precious.txt'), 'utf8'), 'keep me');
  const forced = exportFrom(src, taken, ['--force']);
  assert.notEqual(forced.status, 0, 'even --force will not delete a directory that is not a git repo');
  assert.equal(readFileSync(join(taken, 'precious.txt'), 'utf8'), 'keep me');
});

// Personal name and personal email: the public copy carries neither, in files or in git identities.
test('the export commit is authored and committed as the public noreply identity, never the source repo identity', () => {
  const src = join(work, 'identity');
  makeRepo(src); // its own git config says Test Author <author@example.com>
  const out = join(work, 'out-identity');
  const r = exportFrom(src, out);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(git(out, 'log', '--all', '--format=%an %ae %cn %ce'), PUBLIC_ID);
  assert.ok(!git(out, 'log', '--all', '--format=%an %ae %cn %ce %B').includes('example.com'));
});

test('the identity is overridable with --author, and the override is still scanned', () => {
  const src = join(work, 'identity-flag');
  makeRepo(src);
  const out = join(work, 'out-identity-flag');
  const r = exportFrom(src, out, ['--author', 'Mint Maintainers <maintainers@users.noreply.github.com>']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(git(out, 'log', '--format=%an %ae %cn %ce'), 'Mint Maintainers maintainers@users.noreply.github.com Mint Maintainers maintainers@users.noreply.github.com');
  const bad = exportFrom(src, join(work, 'out-identity-bad'), ['--author', 'no email here']);
  assert.notEqual(bad.status, 0);
});

test('a planted personal name makes the export refuse: non-zero, nothing written, the name never printed', () => {
  const src = join(work, 'named');
  makeRepo(src, { named: true });
  const out = join(work, 'out-named');
  const r = exportFrom(src, out);
  assert.notEqual(r.status, 0);
  assert.ok(!existsSync(out));
  assert.match(r.stderr, /lib\/credit\.mjs/);
  assert.match(r.stderr, /denylisted string/);
  assert.ok(!(r.stdout + r.stderr).toLowerCase().includes(FAKE_NAME.toLowerCase()));
});

test('a planted personal email refuses too, even though the denylist has no entry for it', () => {
  const src = join(work, 'mailed');
  makeRepo(src, { mailed: true });
  const out = join(work, 'out-mailed');
  const r = exportFrom(src, out);
  assert.notEqual(r.status, 0);
  assert.ok(!existsSync(out));
  assert.match(r.stderr, /lib\/contact\.mjs/);
  assert.match(r.stderr, /personal email/);
  assert.ok(!(r.stdout + r.stderr).includes(FAKE_EMAIL));
});

test('a name or personal email in the export commit identity makes it refuse and removes the result', () => {
  const src = join(work, 'id-leak');
  makeRepo(src);
  for (const [label, who] of [['name', `${FAKE_NAME} <maintainer@users.noreply.github.com>`], ['email', `Maintainer <${FAKE_EMAIL}>`]]) {
    const out = join(work, `out-id-${label}`);
    const r = exportFrom(src, out, ['--author', who]);
    assert.notEqual(r.status, 0, label);
    assert.ok(!existsSync(out), `${label}: the finished repo was removed`);
    assert.match(r.stderr, /commit (author|committer)@/);
    assert.ok(!(r.stdout + r.stderr).includes(FAKE_EMAIL));
  }
});

test('the scanner itself flags a commit with a personal identity in history', () => {
  const repo2 = join(work, 'scan-history');
  makeRepo(repo2);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Pat', GIT_AUTHOR_EMAIL: FAKE_EMAIL, GIT_COMMITTER_NAME: 'Pat', GIT_COMMITTER_EMAIL: FAKE_EMAIL };
  execFileSync('git', ['-C', repo2, 'commit', '-q', '--allow-empty', '-m', 'noted'], { env });
  const r = run(join(ROOT, 'scripts', 'secret-scan.mjs'), [repo2, '--tracked', '--history']);
  assert.match(r.stdout, /commit (author|committer)@/);
  assert.match(r.stdout, /personal email/);
  assert.notEqual(r.status, 0);
});

// The guard has two layers: the exclude list drops private files, the scan refuses what slips past.
// These prove the test above would notice either being weakened, by running a weakened copy of the script.
function weakened(name, edits, script = 'export-public.mjs') {
  const dir = join(work, name);
  cpSync(join(ROOT, 'scripts'), dir, { recursive: true });
  const file = join(dir, script);
  let s = readFileSync(file, 'utf8');
  for (const [from, to] of edits) {
    assert.ok(s.includes(from), `the guard line to weaken is still there: ${from}`);
    s = s.replace(from, to);
  }
  writeFileSync(file, s);
  return dir;
}

test('weaken only the exclude list: the scan still refuses (two layers)', () => {
  const src = join(work, 'mut-a');
  makeRepo(src);
  const dir = weakened('scripts-a', [['if (isExcluded(rel, exclude))', 'if (false)']]);
  const out = join(work, 'out-mut-a');
  const r = exportFrom(src, out, [], dir);
  assert.notEqual(r.status, 0, 'private files slipped past the exclude list but the scan refused them');
  assert.ok(!existsSync(out));
});

test('weaken both layers: the private files leak, so the tests above really are guarding something', () => {
  const src = join(work, 'mut-b');
  makeRepo(src);
  const dir = weakened('scripts-b', [['if (isExcluded(rel, exclude))', 'if (false)'], ['if (findings.length) {', 'if (false) {'], ['if (final.length) {', 'if (false) {']]);
  const out = join(work, 'out-mut-b');
  const r = exportFrom(src, out, [], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(out, 'data', 'mint.db')), 'with the guard gone the database is exported');
  assert.ok(existsSync(join(out, '.env')), 'and so is the env file');
});

test('weaken the scan once: a planted name and a planted email are exported, so the name and email tests really guard', () => {
  const src = join(work, 'mut-c');
  makeRepo(src, { named: true, mailed: true });
  const dir = weakened('scripts-c', [['if (findings.length) {', 'if (false) {'], ['if (final.length) {', 'if (false) {']]);
  const out = join(work, 'out-mut-c');
  const r = exportFrom(src, out, [], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readFileSync(join(out, 'lib', 'credit.mjs'), 'utf8').includes(FAKE_NAME), 'the name went out');
  assert.ok(readFileSync(join(out, 'lib', 'contact.mjs'), 'utf8').includes(FAKE_EMAIL), 'and so did the email');
});

test('weaken only the commit-identity scan: a personal author slips into the export, so that test guards something', () => {
  const src = join(work, 'mut-d');
  makeRepo(src);
  const dir = weakened('scripts-d', [["for (const [what, text] of [['author', author], ['committer', committer], ['message', message ?? '']])", 'for (const [what, text] of [])']], 'secret-scan.mjs');
  const out = join(work, 'out-mut-d');
  const r = exportFrom(src, out, ['--author', `Maintainer <${FAKE_EMAIL}>`], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(git(out, 'log', '--format=%ae').includes(FAKE_EMAIL), 'the personal email is in the export history');
});

test('weaken the default identity: the export takes the source repo identity, so the identity test really guards', () => {
  const src = join(work, 'mut-e');
  makeRepo(src);
  const dir = weakened('scripts-e', [['env.GIT_AUTHOR_NAME || DEFAULT_IDENTITY.name', "env.GIT_AUTHOR_NAME || 'Test Author'"], ['env.GIT_AUTHOR_EMAIL || DEFAULT_IDENTITY.email', "env.GIT_AUTHOR_EMAIL || 'author@example.com'"]]);
  const out = join(work, 'out-mut-e');
  const r = exportFrom(src, out, [], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(git(out, 'log', '--format=%an %ae %cn %ce'), PUBLIC_ID);
});

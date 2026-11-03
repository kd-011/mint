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
function runFrom(srcRepo, args, scriptsDir = join(ROOT, 'scripts')) {
  const dest = join(srcRepo, '.export-scripts');
  rmSync(dest, { recursive: true, force: true });
  cpSync(scriptsDir, dest, { recursive: true });
  // the copy lives in <repo>/.export-scripts, so its `..` is the repo
  return { ...run(join(dest, 'export-public.mjs'), args), dest };
}
// the fresh single-commit behaviour, now behind --fresh
const exportFrom = (srcRepo, out, extra = [], scriptsDir) => runFrom(srcRepo, ['--fresh', '--out', out, ...extra], scriptsDir);
// the default: one new commit on top of a persistent public checkout
const updateFrom = (srcRepo, out, extra = [], scriptsDir) => runFrom(srcRepo, ['--out', out, ...extra], scriptsDir);

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

test('weaken the exclude list and the scans: the image gate still stops the pictures (three layers)', () => {
  const src = join(work, 'mut-b0');
  makeRepo(src);
  const dir = weakened('scripts-b0', [['if (isExcluded(rel, exclude))', 'if (false)'], ['if (findings.length) {', 'if (false) {'], ['if (final.length) {', 'if (false) {']]);
  const out = join(work, 'out-mut-b0');
  const r = exportFrom(src, out, [], dir);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /docs\/demo-mode\/m-home\.png/);
  assert.ok(!existsSync(out));
});

test('weaken every layer: the private files leak, so the tests above really are guarding something', () => {
  const src = join(work, 'mut-b');
  makeRepo(src);
  const dir = weakened('scripts-b', [['if (isExcluded(rel, exclude))', 'if (false)'], ['if (findings.length) {', 'if (false) {'], ['if (final.length) {', 'if (false) {'], ['if (gated.length) throw', 'if (false) throw']]);
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

// ---- incremental export: one new commit on top of a persistent public checkout ----

// Land a change in the private repo: write files, remove files, commit.
function privateCommit(src, subject, { write = {}, remove = [] } = {}) {
  for (const [rel, body] of Object.entries(write)) { put(src, rel, body); git(src, 'add', '-f', '--', rel); }
  for (const rel of remove) git(src, 'rm', '-q', '-f', '--', rel);
  git(src, 'commit', '-q', '--allow-empty', '-m', subject);
  return git(src, 'rev-parse', 'HEAD');
}

// A source repo, a bare "GitHub", and a public checkout that tracks it (made by --fresh, as the real one was).
function makePublic(name, srcOpts = {}) {
  const src = join(work, `${name}-src`);
  makeRepo(src, srcOpts);
  const pub = join(work, `${name}-pub`);
  const bare = join(work, `${name}.git`);
  const r = exportFrom(src, pub);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  git(work, 'init', '-q', '--bare', '-b', 'main', bare);
  git(pub, 'remote', 'add', 'origin', bare);
  git(pub, 'push', '-q', '-u', 'origin', 'main');
  return { src, pub, bare };
}
const count = (pub) => Number(git(pub, 'rev-list', '--count', 'HEAD'));
const marker = (pub) => join(pub, '.git', 'mint-export-state.json');

test('incremental: a private change becomes ONE new public commit on top, history intact, nothing pushed', () => {
  const { src, pub, bare } = makePublic('inc-ok');
  const first = git(pub, 'rev-parse', 'HEAD');
  privateCommit(src, 'feat: add the widget screen', { write: { 'lib/widget.mjs': 'export const w = 2;\n' }, remove: ['lib/thing.mjs'] });
  privateCommit(src, 'fix: widget rounding', { write: { 'README.md': '# Demo\n\nUpdated.\n' } });
  const r = updateFrom(src, pub);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(count(pub), 2, 'exactly one commit was added');
  assert.equal(git(pub, 'rev-parse', 'HEAD~1'), first, 'on top of the previous public commit');
  assert.equal(git(pub, 'log', '--format=%an %ae %cn %ce'), `${PUBLIC_ID}\n${PUBLIC_ID}`);
  const body = git(pub, 'log', '-1', '--format=%B');
  assert.match(body, /feat: add the widget screen/);
  assert.match(body, /fix: widget rounding/);
  assert.ok(!/private history/.test(body), 'commits before the last export are not listed');
  assert.ok(existsSync(join(pub, 'lib', 'widget.mjs')) && !existsSync(join(pub, 'lib', 'thing.mjs')));
  assert.equal(readFileSync(join(pub, 'README.md'), 'utf8'), '# Demo\n\nUpdated.\n');
  for (const gone of ['.env', 'data', 'backups', '.shots']) assert.ok(!existsSync(join(pub, gone)), `${gone} stays out`);
  assert.equal(git(pub, 'remote'), 'origin', '.git was kept');
  assert.equal(git(pub, 'status', '--porcelain'), '', 'the tree is clean after the commit');
  assert.equal(git(bare, 'rev-parse', 'main'), first, 'without --push the commit is only left ready');
  assert.match(r.stdout, /ready/);
});

test('incremental: --push publishes the new commit to origin', () => {
  const { src, pub, bare } = makePublic('inc-push');
  privateCommit(src, 'feat: pushed change', { write: { 'lib/p.mjs': 'export const p = 1;\n' } });
  const r = updateFrom(src, pub, ['--push']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(git(bare, 'rev-parse', 'main'), git(pub, 'rev-parse', 'HEAD'));
  assert.equal(git(bare, 'rev-list', '--count', 'main'), '2');
});

test('incremental: nothing changed means no commit', () => {
  const { src, pub } = makePublic('inc-noop');
  privateCommit(src, 'chore: empty');
  const before = git(pub, 'rev-parse', 'HEAD');
  const r = updateFrom(src, pub);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(git(pub, 'rev-parse', 'HEAD'), before);
  assert.match(r.stdout, /nothing to publish/);
});

test('incremental: a second run lists only what is new since the first (the marker moves)', () => {
  const { src, pub } = makePublic('inc-twice');
  privateCommit(src, 'feat: first batch', { write: { 'lib/a.mjs': 'export const a = 1;\n' } });
  assert.equal(updateFrom(src, pub).status, 0);
  privateCommit(src, 'feat: second batch', { write: { 'lib/b.mjs': 'export const b = 1;\n' } });
  assert.equal(updateFrom(src, pub).status, 0);
  assert.equal(count(pub), 3);
  const last = git(pub, 'log', '-1', '--format=%B');
  assert.match(last, /second batch/);
  assert.ok(!/first batch/.test(last));
});

test('incremental: it refuses a dirty checkout (modified or untracked), changes nothing, and says why', () => {
  const { src, pub } = makePublic('inc-dirty');
  privateCommit(src, 'feat: x', { write: { 'lib/x.mjs': 'export const x = 1;\n' } });
  const head = git(pub, 'rev-parse', 'HEAD');
  writeFileSync(join(pub, 'README.md'), 'local edit\n');
  let r = updateFrom(src, pub);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /dirty|uncommitted/i);
  assert.equal(readFileSync(join(pub, 'README.md'), 'utf8'), 'local edit\n', 'the local edit survived');
  git(pub, 'checkout', '--', 'README.md');
  writeFileSync(join(pub, 'stray.txt'), 'untracked\n');
  r = updateFrom(src, pub);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /dirty|uncommitted/i);
  assert.ok(existsSync(join(pub, 'stray.txt')));
  assert.equal(git(pub, 'rev-parse', 'HEAD'), head);
});

test('incremental: it refuses when the checkout is on another branch', () => {
  const { src, pub } = makePublic('inc-branch');
  privateCommit(src, 'feat: y', { write: { 'lib/y.mjs': 'export const y = 1;\n' } });
  git(pub, 'checkout', '-q', '-b', 'feature');
  const r = updateFrom(src, pub);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /branch/i);
  assert.equal(count(pub), 1);
  assert.ok(!existsSync(join(pub, 'lib', 'y.mjs')));
});

test('incremental: it refuses when the checkout is behind origin, and when it has diverged', () => {
  const { src, pub, bare } = makePublic('inc-behind');
  privateCommit(src, 'feat: z', { write: { 'lib/z.mjs': 'export const z = 1;\n' } });
  // someone merges a contribution on the public repo
  const other = join(work, 'inc-behind-other');
  git(work, 'clone', '-q', bare, other);
  put(other, 'CONTRIBUTORS.md', 'thanks\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'docs: contributors');
  git(other, 'push', '-q', 'origin', 'main');
  let r = updateFrom(src, pub);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /behind/i);
  assert.equal(count(pub), 1);
  // now diverge: a local commit too
  put(pub, 'LOCAL.md', 'local\n');
  git(pub, 'add', '-A');
  git(pub, 'commit', '-q', '-m', 'local only');
  r = updateFrom(src, pub);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /diverged/i);
  assert.equal(count(pub), 2);
});

test('incremental: a checkout that is only AHEAD of origin (an earlier commit not yet pushed) is fine', () => {
  const { src, pub, bare } = makePublic('inc-ahead');
  privateCommit(src, 'feat: one', { write: { 'lib/one.mjs': 'export const o = 1;\n' } });
  assert.equal(updateFrom(src, pub).status, 0);
  privateCommit(src, 'feat: two', { write: { 'lib/two.mjs': 'export const t = 1;\n' } });
  const r = updateFrom(src, pub, ['--push']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(git(bare, 'rev-list', '--count', 'main'), '3');
});

test('incremental: a planted secret in the change blocks the commit, restores the tree, never prints the value', () => {
  const { src, pub } = makePublic('inc-secret');
  const head = git(pub, 'rev-parse', 'HEAD');
  privateCommit(src, 'feat: oops', { write: { 'lib/leaky.mjs': `export const KEY = '${FAKE_KEY}';\n`, 'lib/fine.mjs': 'export const f = 1;\n' } });
  const r = updateFrom(src, pub);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /lib\/leaky\.mjs/);
  assert.match(r.stderr, /redbark-key/);
  assert.ok(!(r.stdout + r.stderr).includes(FAKE_KEY));
  assert.equal(git(pub, 'rev-parse', 'HEAD'), head, 'no commit');
  assert.equal(git(pub, 'status', '--porcelain'), '', 'the working tree is back as it was');
  assert.ok(!existsSync(join(pub, 'lib', 'leaky.mjs')) && !existsSync(join(pub, 'lib', 'fine.mjs')));
});

test('incremental: the denylisted name or host in the change blocks the commit', () => {
  for (const [label, body] of [['name', `// written for ${FAKE_NAME}\n`], ['host', '// served from my-private-host.invalid\n']]) {
    const { src, pub } = makePublic(`inc-deny-${label}`);
    const head = git(pub, 'rev-parse', 'HEAD');
    privateCommit(src, 'feat: credit', { write: { 'lib/credit.mjs': body } });
    const r = updateFrom(src, pub);
    assert.notEqual(r.status, 0, label);
    assert.match(r.stderr, /lib\/credit\.mjs/);
    assert.match(r.stderr, /denylisted string/);
    assert.ok(!(r.stdout + r.stderr).toLowerCase().includes(FAKE_NAME.toLowerCase()));
    assert.equal(git(pub, 'rev-parse', 'HEAD'), head, label);
    assert.equal(git(pub, 'status', '--porcelain'), '', label);
  }
});

test('incremental: a private commit subject that carries the name is left out of the public message', () => {
  const { src, pub } = makePublic('inc-subject');
  privateCommit(src, `docs: thanks to ${FAKE_NAME}`, { write: { 'lib/s.mjs': 'export const s = 1;\n' } });
  privateCommit(src, 'feat: harmless subject', { write: { 'lib/t.mjs': 'export const t = 1;\n' } });
  const r = updateFrom(src, pub);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const log = git(pub, 'log', '--all', '--format=%B');
  assert.match(log, /harmless subject/);
  assert.ok(!log.toLowerCase().includes(FAKE_NAME.toLowerCase()));
});

test('incremental: the private sha marker lives outside the public tree and never reaches it', () => {
  const { src, pub } = makePublic('inc-marker');
  const sha = privateCommit(src, 'feat: m', { write: { 'lib/m.mjs': 'export const m = 1;\n' } });
  assert.equal(updateFrom(src, pub).status, 0);
  assert.ok(existsSync(marker(pub)), 'the state file is kept inside .git');
  assert.equal(JSON.parse(readFileSync(marker(pub), 'utf8')).privateSha, sha);
  assert.ok(!git(pub, 'ls-files').split('\n').some((f) => /mint-export-state/.test(f)), 'not tracked');
  for (const needle of [sha, sha.slice(0, 7)]) {
    const inTree = spawnSync('git', ['-C', pub, 'grep', '-F', '-q', needle, 'HEAD'], { encoding: 'utf8' });
    assert.equal(inTree.status, 1, `${needle} is not in any file of the public tree`);
    assert.ok(!git(pub, 'log', '--all', '--format=%an %ae %cn %ce %B').includes(needle), `${needle} is not in any public commit`);
  }
});

test('incremental: it will not run inside the source repo, nor against a directory that is not a git checkout', () => {
  const { src } = makePublic('inc-guard');
  assert.notEqual(updateFrom(src, join(src, 'out-inside')).status, 0);
  const plain = join(work, 'plain-dir');
  mkdirSync(plain);
  writeFileSync(join(plain, 'precious.txt'), 'keep me');
  const r = updateFrom(src, plain);
  assert.notEqual(r.status, 0);
  assert.equal(readFileSync(join(plain, 'precious.txt'), 'utf8'), 'keep me');
});

test('--fresh still writes a one-commit repo and records the private sha outside it', () => {
  const src = join(work, 'fresh-marker');
  makeRepo(src);
  const out = join(work, 'out-fresh-marker');
  const r = exportFrom(src, out);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(out, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(JSON.parse(readFileSync(marker(out), 'utf8')).privateSha, git(src, 'rev-parse', 'HEAD'));
});

// The incremental guard has three scans (the staged tree, the diff against the previous public commit, the new
// commit including its message) plus the dirty check. Run weakened copies to prove the tests above notice.
test('weaken only the diff scan: the full-tree scan still refuses (two layers)', () => {
  const { src, pub } = makePublic('mut-diff-only');
  privateCommit(src, 'feat: oops', { write: { 'lib/leaky.mjs': `export const KEY = '${FAKE_KEY}';\n` } });
  const dir = weakened('scripts-diff-only', [['if (diffFindings.length) {', 'if (false) {']]);
  const r = updateFrom(src, pub, [], dir);
  assert.notEqual(r.status, 0);
  assert.equal(count(pub), 1);
});

test('weaken every scan once: the planted secret and name are committed, so the blocking tests really guard', () => {
  const { src, pub } = makePublic('mut-scans');
  privateCommit(src, 'feat: oops', { write: { 'lib/leaky.mjs': `export const KEY = '${FAKE_KEY}';\n`, 'lib/credit.mjs': `// for ${FAKE_NAME}\n` } });
  const dir = weakened('scripts-scans', [['if (findings.length) {', 'if (false) {'], ['if (diffFindings.length) {', 'if (false) {'], ['if (lateFindings.length) {', 'if (false) {']]);
  const r = updateFrom(src, pub, [], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(pub), 2);
  assert.ok(readFileSync(join(pub, 'lib', 'leaky.mjs'), 'utf8').includes(FAKE_KEY));
});

test('weaken the dirty check: a locally edited file is overwritten, so the dirty test really guards', () => {
  const { src, pub } = makePublic('mut-dirty');
  privateCommit(src, 'feat: x', { write: { 'lib/x.mjs': 'export const x = 1;\n' } });
  writeFileSync(join(pub, 'README.md'), 'local edit\n');
  const dir = weakened('scripts-dirty', [['if (dirty.length) {', 'if (false) {']]);
  const r = updateFrom(src, pub, [], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(readFileSync(join(pub, 'README.md'), 'utf8'), 'local edit\n');
});

test('the scan lets invented BSB columns through in the CSV fixtures only, in the tree and in a diff', () => {
  const bsb = ['032-000', '123456'].join(' '); // invented, built at run time
  const src = join(work, 'bsb');
  makeRepo(src);
  privateCommit(src, 'test: csv fixture', { write: { 'test/fixtures/csv/bank.csv': `Bank Account,Date\n${bsb},15/10/2026\n` } });
  const ok = exportFrom(src, join(work, 'out-bsb-ok'));
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  privateCommit(src, 'docs: a BSB in prose', { write: { 'docs/notes.md': `pay into ${bsb}\n` } });
  const bad = exportFrom(src, join(work, 'out-bsb-bad'));
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /docs\/notes\.md/);
  assert.match(bad.stderr, /BSB and account/);
});

test('incremental: a landed-branch subject is listed as a plain phrase, not as a branch name', () => {
  const { src, pub } = makePublic('inc-merge-subject');
  privateCommit(src, 'Merge feature/mint-widget-screen-for-bills-mvabc123', { write: { 'lib/w.mjs': 'export const w = 1;\n' } });
  const r = updateFrom(src, pub);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const body = git(pub, 'log', '-1', '--format=%B');
  assert.match(body, /- Widget screen for bills/);
  assert.ok(!/coder\/|mvabc123|Merge/.test(body), 'no branch name, no task id');
});

// The diff scan, on its own. The staged tree is scanned before it, so through the whole pipeline a planted
// secret is caught twice; these tests switch the other two scans off to prove the diff scan guards by itself.
const scanLib = () => import(`${join(ROOT, 'scripts', 'secret-scan.mjs')}`);

test('scanStagedDiff finds an added secret, a denylisted name and a forbidden path in what is staged, and nothing in a clean change', async () => {
  const { scanStagedDiff, loadDenylist, summarise } = await scanLib();
  const repo2 = join(work, 'staged-diff');
  makeRepo(repo2);
  const deny = loadDenylist([FAKE_NAME]);
  put(repo2, 'lib/fine.mjs', 'export const f = 1;\n');
  git(repo2, 'add', 'lib/fine.mjs');
  assert.deepEqual(scanStagedDiff(repo2, { deny }), [], 'a clean staged change has no findings');
  put(repo2, 'lib/leaky.mjs', `export const KEY = '${FAKE_KEY}';\n`);
  put(repo2, 'lib/credit.mjs', `// for ${FAKE_NAME}\n`);
  put(repo2, 'extra.db', 'fake database bytes');
  git(repo2, 'add', '-f', 'lib/leaky.mjs', 'lib/credit.mjs', 'extra.db');
  const text = summarise(scanStagedDiff(repo2, { deny })).join('\n');
  assert.match(text, /lib\/leaky\.mjs.*redbark-key/);
  assert.match(text, /lib\/credit\.mjs.*denylisted string/);
  assert.match(text, /extra\.db.*forbidden file/);
  assert.ok(!text.includes(FAKE_KEY) && !text.toLowerCase().includes(FAKE_NAME.toLowerCase()), 'kinds only, never the matched text');
  // lines that were already in HEAD are not the diff's business
  git(repo2, 'reset', '-q', '--hard');
  assert.deepEqual(scanStagedDiff(repo2, { deny }), []);
});

function weakenedPair(name, exportEdits, scanEdits = []) {
  const dir = weakened(name, exportEdits);
  const file = join(dir, 'secret-scan.mjs');
  let s = readFileSync(file, 'utf8');
  for (const [from, to] of scanEdits) {
    assert.ok(s.includes(from), `the line to weaken is still there: ${from}`);
    s = s.replace(from, to);
  }
  writeFileSync(file, s);
  return dir;
}
const WEAK_TREE_AND_LATE = [['if (findings.length) {', 'if (false) {'], ['if (lateFindings.length) {', 'if (false) {']];

test('the diff scan alone blocks a planted secret and name: with the tree scan and the final scan off, the commit is still refused', () => {
  const { src, pub } = makePublic('diff-alone');
  const head = git(pub, 'rev-parse', 'HEAD');
  privateCommit(src, 'feat: oops', { write: { 'lib/leaky.mjs': `export const KEY = '${FAKE_KEY}';\n`, 'lib/credit.mjs': `// for ${FAKE_NAME}\n` } });
  const dir = weakenedPair('scripts-diff-alone', WEAK_TREE_AND_LATE);
  const r = updateFrom(src, pub, [], dir);
  assert.notEqual(r.status, 0, 'the diff scan refused it');
  assert.match(r.stderr, /diff scan refused/);
  assert.match(r.stderr, /lib\/leaky\.mjs/);
  assert.ok(!(r.stdout + r.stderr).includes(FAKE_KEY));
  assert.equal(git(pub, 'rev-parse', 'HEAD'), head);
  assert.equal(git(pub, 'status', '--porcelain'), '');
});

test('weaken the diff scan too (scanStagedDiff finds nothing): the same change is committed, so the test above really guards it', () => {
  const { src, pub } = makePublic('diff-gone');
  privateCommit(src, 'feat: oops', { write: { 'lib/leaky.mjs': `export const KEY = '${FAKE_KEY}';\n` } });
  const dir = weakenedPair('scripts-diff-gone', WEAK_TREE_AND_LATE, [['export function scanStagedDiff(repo, { deny = [] } = {}) {', 'export function scanStagedDiff(repo, { deny = [] } = {}) {\n  return [];']]);
  const r = updateFrom(src, pub, [], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(pub), 2);
  assert.ok(readFileSync(join(pub, 'lib', 'leaky.mjs'), 'utf8').includes(FAKE_KEY));
});

// scripts/export-public.mjs: the image gate and the denylist guard. The secret scan reads text and
// cannot see inside a picture, so an export that adds or changes an image or binary outside the
// committed allowlist has to stop, put the checkout back and say so with its own exit code. Everything
// here runs on throwaway git repos with invented bytes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = 'scripts/export-allowlist.txt';
const GATE_EXIT = 3;
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.com', GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.com' };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);
const PNG2 = Buffer.concat([PNG, Buffer.from([1, 2, 3])]);

let work, denyFile, seq = 0;
const put = (root, rel, body) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

before(() => {
  work = mkdtempSync(join(tmpdir(), 'mint-gate-test-'));
  denyFile = join(work, 'denylist.txt');
  writeFileSync(denyFile, '# test denylist\nmy-private-host.invalid\n');
});
after(() => rmSync(work, { recursive: true, force: true }));

function makeSource(files = {}) {
  const src = join(work, `src-${++seq}`);
  mkdirSync(src, { recursive: true });
  git(src, 'init', '-q', '-b', 'main');
  git(src, 'config', 'user.name', 'Test Author');
  git(src, 'config', 'user.email', 'author@example.com');
  put(src, 'README.md', '# Demo\n');
  put(src, 'lib/thing.mjs', 'export const x = 1;\n');
  for (const [rel, body] of Object.entries(files)) put(src, rel, body);
  git(src, 'add', '-A', '-f');
  git(src, 'commit', '-q', '-m', 'private history');
  return src;
}

function commit(src, { write = {}, remove = [] } = {}) {
  for (const [rel, body] of Object.entries(write)) { put(src, rel, body); git(src, 'add', '-f', '--', rel); }
  for (const rel of remove) git(src, 'rm', '-q', '-f', '--', rel);
  git(src, 'commit', '-q', '--allow-empty', '-m', 'a private change');
}

// Run a copy of scripts/ from inside the throwaway repo: the script takes its source repo from its own location.
function runFrom(src, args, { scripts = join(ROOT, 'scripts'), env = { MINT_DENYLIST: denyFile } } = {}) {
  const dest = join(src, '.export-scripts');
  rmSync(dest, { recursive: true, force: true });
  cpSync(scripts, dest, { recursive: true });
  const clean = { ...process.env };
  delete clean.MINT_DENYLIST;
  // An incremental run needs a message; the gate is what these tests are about.
  const withMessage = args.includes('--fresh') ? args : [...args, '--message', 'Update'];
  return spawnSync(process.execPath, [join(dest, 'export-public.mjs'), ...withMessage], { cwd: ROOT, encoding: 'utf8', env: { ...clean, ...env } });
}

// A source repo, a bare "GitHub", and a public checkout made by --fresh and pushed, as the real one was.
function makePublic(files = {}) {
  const src = makeSource(files);
  const pub = join(work, `pub-${seq}`);
  const r = runFrom(src, ['--fresh', '--out', pub]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const bare = join(work, `bare-${seq}.git`);
  git(work, 'init', '-q', '--bare', '-b', 'main', bare);
  git(pub, 'remote', 'add', 'origin', bare);
  git(pub, 'push', '-q', '-u', 'origin', 'main');
  return { src, pub, bare };
}

function assertRefused(r, pub, head, paths) {
  assert.equal(r.status, GATE_EXIT, `exit code: ${r.status}\n${r.stderr}${r.stdout}`);
  for (const p of paths) assert.ok(r.stderr.includes(p), `${p} is named in:\n${r.stderr}`);
  assert.equal(git(pub, 'rev-parse', 'HEAD'), head, 'no new commit');
  assert.equal(git(pub, 'status', '--porcelain'), '', 'the checkout is back as it was');
}

test('a new image outside the allowlist aborts before commit with the gate exit code, the checkout restored', () => {
  const { src, pub } = makePublic();
  const head = git(pub, 'rev-parse', 'HEAD');
  const before = readFileSync(join(pub, '.git', 'mint-export-state.json'), 'utf8');
  commit(src, { write: { 'docs/ui-pass/real-book.png': PNG, 'lib/thing.mjs': 'export const x = 2;\n' } });
  const r = runFrom(src, ['--out', pub]);
  assertRefused(r, pub, head, ['docs/ui-pass/real-book.png']);
  assert.ok(!existsSync(join(pub, 'docs/ui-pass/real-book.png')), 'the image is gone from the working tree');
  assert.equal(readFileSync(join(pub, 'lib/thing.mjs'), 'utf8'), 'export const x = 1;\n', 'the text change went back too');
  assert.equal(readFileSync(join(pub, '.git', 'mint-export-state.json'), 'utf8'), before, 'the private sha marker did not move');
});

test('every offending path is listed, not just the first', () => {
  const { src, pub } = makePublic();
  const head = git(pub, 'rev-parse', 'HEAD');
  commit(src, { write: { 'docs/a.png': PNG, 'docs/b.jpg': PNG, 'blob.dat': Buffer.from([1, 0, 2]) } });
  assertRefused(runFrom(src, ['--out', pub]), pub, head, ['docs/a.png', 'docs/b.jpg', 'blob.dat']);
});

test('a changed image outside the allowlist aborts, and an untouched one does not', () => {
  const { src, pub } = makePublic({ 'docs/old.png': PNG, [ALLOWLIST]: 'docs/old.png\n' });
  // take it off the list: unchanged, it is not this export's business
  commit(src, { write: { [ALLOWLIST]: '# empty\n' } });
  const ok = runFrom(src, ['--out', pub]);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  const head = git(pub, 'rev-parse', 'HEAD');
  commit(src, { write: { 'docs/old.png': PNG2 } });
  assertRefused(runFrom(src, ['--out', pub]), pub, head, ['docs/old.png']);
  assert.deepEqual(readFileSync(join(pub, 'docs/old.png')), PNG, 'the old bytes are back');
});

test('an image on the allowlist goes through, new or changed, and deleting one needs no entry', () => {
  const { src, pub } = makePublic();
  commit(src, { write: { 'docs/shot.png': PNG, 'docs/gone.png': PNG, [ALLOWLIST]: '# fixture shots\ndocs/shot.png\ndocs/gone.png\n' } });
  // pushed, or the next run would rightly gate docs/gone.png in the commit still waiting to go out
  const a = runFrom(src, ['--out', pub, '--push']);
  assert.equal(a.status, 0, a.stderr + a.stdout);
  assert.deepEqual(readFileSync(join(pub, 'docs/shot.png')), PNG);
  commit(src, { write: { 'docs/shot.png': PNG2, [ALLOWLIST]: 'docs/shot.png\n' }, remove: ['docs/gone.png'] });
  const b = runFrom(src, ['--out', pub]);
  assert.equal(b.status, 0, b.stderr + b.stdout);
  assert.deepEqual(readFileSync(join(pub, 'docs/shot.png')), PNG2);
  assert.ok(!existsSync(join(pub, 'docs/gone.png')));
});

test('allowlist entries are exact paths: a directory or a glob allows nothing', () => {
  const { src, pub } = makePublic();
  const head = git(pub, 'rev-parse', 'HEAD');
  commit(src, { write: { 'docs/shot.png': PNG, [ALLOWLIST]: 'docs\ndocs/\ndocs/*\ndocs/*.png\n./docs/shot.png\n' } });
  assertRefused(runFrom(src, ['--out', pub]), pub, head, ['docs/shot.png']);
});

test('no allowlist file fails closed: any image aborts, a text-only change still goes', () => {
  const { src, pub } = makePublic();
  commit(src, { write: { 'lib/thing.mjs': 'export const x = 3;\n' } });
  const ok = runFrom(src, ['--out', pub]);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  const head = git(pub, 'rev-parse', 'HEAD');
  commit(src, { write: { 'docs/shot.png': PNG } });
  assertRefused(runFrom(src, ['--out', pub]), pub, head, ['docs/shot.png']);
});

test('what counts: images by name even if git would call them text, and binaries whatever their name', () => {
  const big = Buffer.alloc(3_100_000, 'a');
  const blob = 'A'.repeat(5000);
  const cases = {
    'public/diagram.svg': '<svg xmlns="http://www.w3.org/2000/svg"><text>$12,345.67</text></svg>\n',
    'docs/picture.txt': PNG,
    'docs/scan': Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x0a]),
    'docs/statement.pdf': '%PDF-1.7 all ascii\n',
    'docs/latin1.csv': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    'docs/huge.txt': big,
    'docs/inline.md': `![shot](data:image/png;base64,${blob})\n`,
    'docs/inline.js': `export const shot = \`\n${blob}\n\`;\n`,
  };
  for (const [rel, body] of Object.entries(cases)) {
    const { src, pub } = makePublic();
    const head = git(pub, 'rev-parse', 'HEAD');
    commit(src, { write: { [rel]: body } });
    assertRefused(runFrom(src, ['--out', pub]), pub, head, [rel]);
  }
});

test('plain text is not gated, a short base64 string included', () => {
  const { src, pub } = makePublic();
  commit(src, { write: { 'lib/note.mjs': "export const a = 'data:image/gif;base64,R0lGOD';\n", 'docs/note.md': 'A note with café in UTF-8.\n' } });
  const r = runFrom(src, ['--out', pub]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test('an image in an unpushed commit from an earlier run is gated too, even when the tree no longer holds it', () => {
  const { src, pub, bare } = makePublic();
  const pushed = git(pub, 'rev-parse', 'HEAD');
  // what an older exporter left behind: a commit nobody has pushed yet, carrying a picture
  put(pub, 'docs/old-run.png', PNG);
  git(pub, 'add', '-A');
  git(pub, 'commit', '-q', '-m', 'an earlier export');
  const head = git(pub, 'rev-parse', 'HEAD');
  // nothing in the source holds it, so the final tree would be clean; the history would not be
  const r = runFrom(src, ['--out', pub, '--push']);
  assertRefused(r, pub, head, ['docs/old-run.png']);
  assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), pushed, 'nothing reached origin');
});

test('an unpushed commit whose images are all allowlisted goes out on --push', () => {
  const { src, pub, bare } = makePublic();
  put(pub, 'docs/shot.png', PNG);
  git(pub, 'add', '-A');
  git(pub, 'commit', '-q', '-m', 'an earlier export');
  commit(src, { write: { 'docs/shot.png': PNG, [ALLOWLIST]: 'docs/shot.png\n' } });
  const r = runFrom(src, ['--out', pub, '--push']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), git(pub, 'rev-parse', 'HEAD'));
});

test('--fresh is gated as well: nothing is written', () => {
  const src = makeSource({ 'docs/shot.png': PNG });
  const out = join(work, 'fresh-out');
  const r = runFrom(src, ['--fresh', '--out', out]);
  assert.equal(r.status, GATE_EXIT, r.stderr + r.stdout);
  assert.match(r.stderr, /docs\/shot\.png/);
  assert.ok(!existsSync(out), 'no output directory was left behind');
});

test('files on the exclude list never reach the gate', () => {
  const src = makeSource({ 'docs/kit-pass-2/m-home.png': PNG, 'data/receipts/r.jpg': PNG });
  const out = join(work, 'fresh-excluded');
  const r = runFrom(src, ['--fresh', '--out', out]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!existsSync(join(out, 'docs/kit-pass-2')));
});

test('a secret still exits 1, not the gate code, so the job can tell them apart', () => {
  const { src, pub } = makePublic();
  commit(src, { write: { 'docs/shot.png': PNG, 'lib/host.mjs': '// my-private-host.invalid\n' } });
  const r = runFrom(src, ['--out', pub]);
  assert.equal(r.status, 1, r.stderr + r.stdout);
});

test('the scan lets a long hex through in workflows and the dossier lock only, and nothing else there', async () => {
  const { scanTree } = await import(join(ROOT, 'scripts', 'secret-scan.mjs'));
  const hex = ['e7477775783ea552', '6144ba13e8db5eec57747ce8'].join(''); // built at run time, so this file holds none
  const dir = join(work, 'kinds');
  put(dir, '.github/workflows/a.yml', `uses: some/action@${hex}\n`);
  put(dir, 'dossiers/.dossier-lock.json', `{"hash": "${hex}"}\n`);
  assert.deepEqual(scanTree(dir), []);
  put(dir, 'lib/key.mjs', `export const k = '${hex}';\n`);
  put(dir, '.github/workflows/b.yml', `token: ${['ghp', 'Q7m2Zk9pLw4Xv8Rn3TQ7m2Zk9pLw4Xv8Rn3T'].join('_')}\n`);
  assert.deepEqual(scanTree(dir).map((f) => `${f.file} ${f.kind}`).sort(), ['.github/workflows/b.yml github-token', 'lib/key.mjs long-hex (key shape)']);
});

// the denylist has to be there

for (const [what, make] of [
  ['missing', (f) => f],
  ['empty', (f) => { writeFileSync(f, ''); return f; }],
  ['only comments and blank lines', (f) => { writeFileSync(f, '# nothing here\n\n   \n'); return f; }],
]) {
  test(`a denylist that is ${what} stops the export before it touches anything, in both modes`, () => {
    const { src, pub } = makePublic();
    commit(src, { write: { 'lib/thing.mjs': 'export const x = 9;\n' } });
    const head = git(pub, 'rev-parse', 'HEAD');
    const file = make(join(work, `deny-${++seq}.txt`));
    const r = runFrom(src, ['--out', pub], { env: { MINT_DENYLIST: file } });
    assert.notEqual(r.status, 0, r.stdout);
    assert.notEqual(r.status, GATE_EXIT, 'this is not the image gate');
    assert.match(r.stderr, /denylist/);
    assert.equal(git(pub, 'rev-parse', 'HEAD'), head);
    assert.equal(git(pub, 'status', '--porcelain'), '');
    const out = join(work, `fresh-deny-${seq}`);
    const f = runFrom(src, ['--fresh', '--out', out], { env: { MINT_DENYLIST: file } });
    assert.notEqual(f.status, 0, f.stdout);
    assert.ok(!existsSync(out));
  });
}

test('with MINT_DENYLIST unset it reads ~/.config/mint/export-denylist.txt, and --deny is no substitute', () => {
  const src = makeSource();
  const home = join(work, 'home');
  mkdirSync(home, { recursive: true });
  const out = join(work, 'fresh-home');
  const gone = runFrom(src, ['--fresh', '--out', out, '--deny', 'something'], { env: { HOME: home } });
  assert.notEqual(gone.status, 0, gone.stdout);
  assert.match(gone.stderr, /export-denylist\.txt/);
  assert.ok(!existsSync(out));
  put(home, '.config/mint/export-denylist.txt', 'my-private-host.invalid\n');
  const ok = runFrom(src, ['--fresh', '--out', out], { env: { HOME: home } });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
});

// weaken each check once: the tests above have to be guarding something

function weakened(name, edits) {
  const dir = join(work, `weak-${name}`);
  cpSync(join(ROOT, 'scripts'), dir, { recursive: true });
  for (const [from, to] of edits) {
    const f = join(dir, 'export-public.mjs');
    const body = readFileSync(f, 'utf8');
    assert.ok(body.includes(from), `the weakening still applies: ${from}`);
    writeFileSync(f, body.replaceAll(from, to));
  }
  return dir;
}

test('weaken the gate: the picture is committed and pushed, so the gate tests really guard', () => {
  const dir = weakened('gate', [['if (gated.length) throw', 'if (false) throw']]);
  const { src, pub, bare } = makePublic();
  commit(src, { write: { 'docs/ui-pass/real-book.png': PNG } });
  const r = runFrom(src, ['--out', pub, '--push'], { scripts: dir });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(git(bare, 'ls-tree', '-r', '--name-only', 'refs/heads/main').includes('docs/ui-pass/real-book.png'), 'with the gate gone it reaches origin');
});

test('an allowlist entry dropped while its commit is still unpushed stops that commit going out', () => {
  const { src, pub, bare } = makePublic();
  const pushed = git(pub, 'rev-parse', 'HEAD');
  commit(src, { write: { 'docs/shot.png': PNG, [ALLOWLIST]: 'docs/shot.png\n' } });
  const a = runFrom(src, ['--out', pub]);
  assert.equal(a.status, 0, a.stderr + a.stdout);
  const head = git(pub, 'rev-parse', 'HEAD');
  commit(src, { write: { [ALLOWLIST]: '# not fixture output after all\n' }, remove: ['docs/shot.png'] });
  assertRefused(runFrom(src, ['--out', pub, '--push']), pub, head, ['docs/shot.png']);
  assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), pushed);
});

test('weaken the unpushed-commit half: an old commit carrying a picture is pushed, so that test really guards', () => {
  const dir = weakened('range', [['for (const c of unpushed)', 'for (const c of [])']]);
  const { src, pub, bare } = makePublic();
  put(pub, 'docs/old-run.png', PNG);
  git(pub, 'add', '-A');
  git(pub, 'commit', '-q', '-m', 'an earlier export');
  const r = runFrom(src, ['--out', pub, '--push'], { scripts: dir });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(git(bare, 'log', '--all', '--name-only', '--format=').includes('docs/old-run.png'), 'the picture is in public history');
});

test('weaken the denylist guard: the export runs without one, so the guard tests really guard', () => {
  const dir = weakened('deny', [['requireDenylist();', '']]);
  const src = makeSource();
  const out = join(work, 'fresh-weak-deny');
  const r = runFrom(src, ['--fresh', '--out', out], { scripts: dir, env: { MINT_DENYLIST: join(work, 'no-such-denylist.txt') } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(existsSync(out));
});

// the committed allowlist itself

const realAllowlist = () => readFileSync(join(ROOT, ALLOWLIST), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

test('the committed allowlist names real files, exact paths, and nothing from a design-pass folder', () => {
  const list = realAllowlist();
  assert.ok(list.length > 0);
  assert.equal(new Set(list).size, list.length, 'no duplicates');
  for (const p of list) {
    assert.ok(existsSync(join(ROOT, p)), `${p} exists`);
    assert.doesNotMatch(p, /[*?[\]]|\/$|^\.\//, `${p} is an exact path`);
    assert.doesNotMatch(p, /^docs\/(ui-pass|kit-pass|design-pass)/, `${p} is a before/after shot, not generated output: a change there has to be looked at`);
    assert.match(p, /^(docs\/(banner\.png|hero\.png|demo\.gif|social-preview\.png|screenshots\/[^/]+\.png)|\.github\/social-preview\.png)$/, `${p} is something the fixture scripts generate`);
  }
});

test('the allowlist covers everything scripts/gen-assets.mjs writes, so a regenerated set publishes without an approval', () => {
  const list = new Set(realAllowlist());
  for (const f of readdirSync(join(ROOT, 'docs/screenshots'))) assert.ok(list.has(`docs/screenshots/${f}`), `docs/screenshots/${f} is listed`);
  for (const f of ['docs/banner.png', 'docs/hero.png', 'docs/demo.gif', 'docs/social-preview.png', '.github/social-preview.png']) assert.ok(list.has(f), `${f} is listed`);
});

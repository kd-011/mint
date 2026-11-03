// The README and docs are the shop window: every relative link and image has to point at a file that
// exists, the GitHub furniture has to be present, and no em dash may creep into the prose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const DOCS = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', ...readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];

// [text](target) and src="target" / href="target", relative ones only
function localTargets(file) {
  const body = read(file);
  const out = [];
  for (const m of body.matchAll(/\]\(([^)\s]+)\)|(?:src|href)="([^"]+)"/g)) {
    const t = (m[1] ?? m[2]).split('#')[0];
    if (!t || /^(https?:|mailto:)/.test(t)) continue;
    out.push(t);
  }
  return out;
}

test('every relative link and image in the README and docs exists', () => {
  for (const f of DOCS) {
    for (const t of localTargets(f)) assert.ok(existsSync(resolve(ROOT, dirname(f), t)), `${f} links to ${t}, which does not exist`);
  }
});

test('the README opens with a plain sentence, a real picture and a command, and the media is a sane size', () => {
  const r = read('README.md');
  assert.ok(r.indexOf('docs/hero.png') < r.indexOf('docker compose up'), 'the picture is above the first command');
  assert.ok(r.indexOf('docs/hero.png') < 500, 'the picture is above the fold');
  assert.ok(!r.includes('img.shields.io'), 'no badge wall');
  assert.ok(r.split(/\s+/).length < 700, 'the README reads in about two minutes');
  assert.ok(read('docs/features.md').includes('demo.gif'), 'the tour lives in the features page');
  assert.ok(statSync(join(ROOT, 'docs/demo.gif')).size < 3 * 1024 * 1024, 'the GIF stays under 3 MB');
  const social = readFileSync(join(ROOT, 'docs/social-preview.png'));
  assert.equal(social.readUInt32BE(16), 1280);
  assert.equal(social.readUInt32BE(20), 640);
});

test('the GitHub furniture is there and points at real paths', () => {
  for (const f of ['.github/workflows/ci.yml', '.github/dependabot.yml', '.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/ISSUE_TEMPLATE/config.yml', 'SECURITY.md', 'CODE_OF_CONDUCT.md']) {
    assert.ok(existsSync(join(ROOT, f)), `${f} exists`);
  }
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /node-version: 22/);
  assert.match(ci, /node --test test\//);
  assert.match(ci, /apt-get install -y -qq age/, 'the backup tests need the age binaries on the runner');
  assert.match(ci, /secret-scan\.mjs \. --tracked/);
  const dep = read('.github/dependabot.yml');
  assert.match(dep, /package-ecosystem: npm\n\s+directory: \/android-shell/);
  assert.ok(existsSync(join(ROOT, 'android-shell/package.json')), 'dependabot watches a real npm directory');
  assert.match(dep, /package-ecosystem: github-actions/);
  assert.match(read('.github/PULL_REQUEST_TEMPLATE.md'), /Signed-off-by/);
  assert.match(read('.github/ISSUE_TEMPLATE/bug_report.yml'), /Never post real financial data/);
  // the README's CI badge points at the workflow file that exists
  assert.ok(read('README.md').includes('actions/workflows/ci.yml'));
});

test('CI runs once a week as well, so the badge stays honest with no push', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /schedule:\n\s+- cron: "\d+ \d+ \* \* \d"/);
  assert.match(ci, /workflow_dispatch:/);
});

test('Dependabot is weekly, grouped, with a cooldown against fresh releases', () => {
  const dep = read('.github/dependabot.yml');
  assert.doesNotMatch(dep, /interval: (daily|monthly)/);
  assert.equal(dep.match(/interval: weekly/g).length, 2, 'both ecosystems');
  assert.equal(dep.match(/cooldown:\n\s+default-days: 7/g).length, 2, 'both ecosystems');
  assert.equal(dep.match(/groups:[\s\S]*?update-types:\n\s+- minor\n\s+- patch/g).length, 2, 'both ecosystems');
});

test('this repo is exported, so nothing merges on it by itself', () => {
  assert.ok(!existsSync(join(ROOT, '.github/workflows/dependabot-automerge.yml')));
});

test('the weekly upkeep job checks links and dossier drift with pinned tools, and only touches one labelled issue', () => {
  const y = read('.github/workflows/upkeep.yml');
  assert.match(y, /schedule:\n\s+- cron: "\d+ \d+ \* \* \d"/);
  assert.match(y, /lycheeverse\/lychee-action@[0-9a-f]{40}/, 'the third-party action is pinned by SHA');
  assert.match(y, /--max-retries/);
  assert.match(y, /npm install -g github:kd-011\/dossier-scribe#v\d+\.\d+\.\d+/, 'dossier-scribe comes from a tag, never a branch');
  assert.match(y, /fetch-depth: 0/);
  assert.match(y, /sync-issue\.sh link-rot/);
  assert.match(y, /sync-issue\.sh dossier-drift/);
  assert.match(y, /^permissions:\n\s+contents: read/m);
  assert.doesNotMatch(y, /contents: write|pull-requests: write/, 'it opens issues, never pull requests or commits');
  const sh = join(ROOT, '.github/scripts/sync-issue.sh');
  assert.ok(existsSync(sh));
  assert.ok(statSync(sh).mode & 0o100, 'the script is executable');
});

test('the dossier makes 5 to 15 cited claims about the public tree and is locked', () => {
  const cfg = JSON.parse(read('dossier-scribe.json'));
  assert.deepEqual(cfg.collectors, ['package'], 'the git and filetypes collectors go stale on every commit');
  const md = read(`${cfg.dossiers}/mint.md`);
  const claims = md.split('\n').filter((l) => /^- .*<!-- src: /.test(l));
  assert.ok(claims.length >= 5 && claims.length <= 15, `${claims.length} claims`);
  for (const c of claims) {
    for (const src of /<!-- src: (.*?) -->/.exec(c)[1].split(',')) assert.ok(existsSync(join(ROOT, src.trim().split(':')[0])), `${src} exists`);
  }
  assert.ok(existsSync(join(ROOT, cfg.dossiers, '.dossier-lock.json')));
});

test('the GitHub social preview is the right size', () => {
  const png = readFileSync(join(ROOT, '.github/social-preview.png'));
  assert.equal(png.readUInt32BE(16), 1280);
  assert.equal(png.readUInt32BE(20), 640);
});

test('no em dash in the README, docs or GitHub files', () => {
  const files = [...DOCS, '.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/workflows/upkeep.yml', '.github/scripts/sync-issue.sh', 'dossiers/mint.md', 'Dockerfile', 'docker-compose.yml'];
  for (const f of files) assert.ok(!read(f).includes('—'), `${f} has an em dash`);
});

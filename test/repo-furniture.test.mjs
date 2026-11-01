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

test('the README opens with the banner, the badges and the hero, and the media is a sane size', () => {
  const r = read('README.md');
  assert.ok(r.indexOf('docs/banner.png') < r.indexOf('img.shields.io'), 'banner first, then badges');
  for (const f of ['docs/banner.png', 'docs/hero.png', 'docs/demo.gif']) assert.ok(r.includes(f), `${f} is in the README`);
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

test('no em dash in the README, docs or GitHub files', () => {
  const files = [...DOCS, '.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/feature_request.yml', 'Dockerfile', 'docker-compose.yml'];
  for (const f of files) assert.ok(!read(f).includes('—'), `${f} has an em dash`);
});

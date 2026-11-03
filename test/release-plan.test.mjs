// The container and release workflow reads the version from CHANGELOG.md, because Mint has no package.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestVersion, notesFor } from '../scripts/release-plan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const LOG = '# Changelog\n\n## [Unreleased]\n\n### Added\n- Not yet.\n\n## [1.2.0] - 2026-11-03\n\n- New thing.\n\n### Fixed\n- Old thing.\n\n## [1.1.0] - 2026-10-01\n\n- First.\n\n[1.2.0]: https://example.invalid/x\n';

test('the newest dated section is the version, and Unreleased never is', () => {
  assert.equal(latestVersion(LOG), '1.2.0');
  assert.equal(latestVersion('# Changelog\n\n## [Unreleased]\n- Nothing.\n'), null);
});

test('the notes are that section only', () => {
  assert.equal(notesFor(LOG, '1.2.0'), '- New thing.\n\n### Fixed\n- Old thing.');
  assert.equal(notesFor(LOG, '1.1.0'), '- First.');
  assert.throws(() => notesFor(LOG, '9.9.9'), /no section/);
});

test('this repository has a version to release, with notes', () => {
  const v = latestVersion(read('CHANGELOG.md'));
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.ok(notesFor(read('CHANGELOG.md'), v).length > 40);
});

test('the workflow publishes the image with the repo token, tests first, and never needs a secret', () => {
  const f = '.github/workflows/release.yml';
  assert.ok(existsSync(join(ROOT, f)));
  const w = read(f);
  assert.match(w, /paths: \[CHANGELOG\.md\]/);
  assert.match(w, /workflow_dispatch/);
  assert.match(w, /ghcr\.io/);
  assert.match(w, /packages: write/);
  assert.match(w, /linux\/amd64,linux\/arm64/);
  assert.match(w, /node --test test\//);
  assert.doesNotMatch(w, /secrets\.(?!GITHUB_TOKEN)/, 'only the token every run already has');
  assert.ok(w.indexOf('node --test test/') < w.indexOf('docker/build-push-action'), 'tests run before anything is pushed');
});

test('compose can pull the image but still builds from source when it cannot', () => {
  const c = read('docker-compose.yml');
  const blocks = c.split(/^ {2}(?=\w+:\n)/m).filter((b) => /^(demo|local|mint):/.test(b));
  assert.equal(blocks.length, 3);
  for (const b of blocks) {
    assert.match(b, /image: ghcr\.io\/kd-011\/mint:latest/);
    assert.match(b, /build: \./);
  }
});

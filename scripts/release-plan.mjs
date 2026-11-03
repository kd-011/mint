// The version is the newest dated section of CHANGELOG.md: Mint has no package.json to hold one.
//   node scripts/release-plan.mjs version       prints 0.3.0
//   node scripts/release-plan.mjs notes 0.3.0   prints that section, for the GitHub Release
// To release: add a "## [x.y.z] - YYYY-MM-DD" section and let it reach the public repo's main.
// .github/workflows/release.yml does the rest.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const latestVersion = (log) => /^## \[(\d+\.\d+\.\d+)\]/m.exec(log)?.[1] ?? null;

export function notesFor(log, version) {
  const lines = log.split('\n');
  const from = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (from < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((l) => /^## \[|^\[[^\]]+\]: /.test(l));
  return (to < 0 ? rest : rest.slice(0, to)).join('\n').trim();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const log = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md'), 'utf8');
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'version') console.log(latestVersion(log) ?? '');
  else if (cmd === 'notes') console.log(notesFor(log, arg));
  else { console.error('usage: release-plan.mjs version | notes <x.y.z>'); process.exit(1); }
}

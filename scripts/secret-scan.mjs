// Secret and personal-data sweep over a directory tree, and optionally over a
// git history. No dependencies. Exit 1 when anything is found.
//
//   node scripts/secret-scan.mjs [dir]                 tree sweep (default: the repo root)
//   node scripts/secret-scan.mjs [dir] --tracked       only the files git tracks (ignores build output and .env in a working copy)
//   node scripts/secret-scan.mjs [dir] --history       also sweep every commit's added lines and filenames
//   node scripts/secret-scan.mjs [dir] --deny a,b,c    extra literal strings that must not appear
//
// A denylist file of literals you never want published (your own domain, email,
// home path) is read from MINT_DENYLIST or ~/.config/mint/export-denylist.txt,
// one per line. It lives outside the repo on purpose, so the list does not
// publish the very strings it guards. Findings print as file:line and kind only,
// never the matched text.
//
// Personal names go in the same file. A line starting with `re:` is a case-insensitive
// regular expression instead of a literal, for words that would otherwise match inside
// longer ones (`re:\bde ?boo\b`). The scan also reads every commit's author and
// committer name and email and its message, so a git identity cannot carry a name out.
//
// A line that carries the marker `scan-allow` is skipped (fixtures and docs that
// show a placeholder on purpose).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ALLOW_MARKER = 'scan-allow';

// Kinds that are expected, and allowed, in a given place. The CSV import fixtures hold invented
// bank layouts (BSB and account columns) that cannot carry an inline marker without breaking the
// file they exist to exercise.
const ALLOWED_KINDS = [[/^test\/fixtures\/csv\//, new Set(['BSB and account'])]];
const allowedHere = (file, kind) => ALLOWED_KINDS.some(([re, kinds]) => re.test(file) && kinds.has(kind));

// Never published, whatever they contain. Matched against the path relative to the scan root.
export const FORBIDDEN_PATHS = [
  /(^|\/)\.env($|\.(?!example$))/, // .env, .env.local, .env.production (not .env.example)
  /(^|\/)data(\/|$)/,
  /(^|\/)backups(\/|$)/,
  /(^|\/)\.shots(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /\.(keystore|jks|p12|pfx|pem|key)$/i,
  /(^|\/)keystore\.properties$/,
  /(^|\/)[^/]*\.password$/,
  /\.(db|db-wal|db-shm|sqlite|sqlite3)$/i,
  /(^|\/)local\.properties$/,
  /\.(apk|aab)$/i,
];

const PLACEHOLDER = /(wrong|x{3,}|\.\.\.|<[^>]+>|example|placeholder|changeme|your[-_ ]|fake|test|dummy|sample)/i;

// [kind, regex, check]. Kinds are the only thing printed.
const RULES = [
  ['redbark-key', /\brbk_(?:live|test)_[A-Za-z0-9]{8,}/g, (m) => !PLACEHOLDER.test(m)],
  ['openrouter-key', /\bsk-or-v1-[A-Za-z0-9]{16,}/g],
  ['api-key (sk-)', /\bsk-[A-Za-z0-9_-]{24,}/g, (m) => !PLACEHOLDER.test(m)],
  ['age-secret-key', /AGE-SECRET-KEY-1[A-Z0-9]{20,}/g],
  ['age-public-key', /\bage1[a-z0-9]{50,}\b/g, (m) => !PLACEHOLDER.test(m)],
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/g, (m) => !PLACEHOLDER.test(m)],
  // 32+ hex that is not one repeated character or a short repeating pattern
  ['long-hex (key shape)', /(?<![/\w])[A-Fa-f0-9]{32,}\b/g, (m) => new Set(m.toLowerCase()).size > 6],
  // KEY=value style assignments in env files, shell and source
  ['secret assignment', /\b[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE)\s*[=:]\s*["']?([A-Za-z0-9+/_.=-]{16,})["']?/g, (m, g) => !PLACEHOLDER.test(m) && new Set(g).size > 5 && /\d/.test(g) && /[A-Za-z]/.test(g)],
  ['email address', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, (m) => !/@(evil\.|example\.(com|org|net)|users\.noreply\.github\.com|noreply\.|localhost$|anthropic\.com$)|noreply@/i.test(m) && !/\.(png|jpg|svg|css|js|json)$/i.test(m) && !/^[^@]+@\d/.test(m)],
  // a personal mailbox is never published, even where the generic rule above lets a placeholder through
  ['personal email (consumer mail provider)', /\b[A-Za-z0-9._%+-]+@(?:gmail|googlemail|hotmail|outlook|live|icloud|me|yahoo|ymail|proton|protonmail|bigpond|optusnet)\.[A-Za-z.]{2,}\b/gi],
  ['AU phone number', /(?<![\d.])(?:\+?61\s?|0)4\d{2}[ -]?\d{3}[ -]?\d{3}(?![\d])/g],
  ['BSB and account', /\b\d{3}-\d{3}\s+\d{6,10}\b|\bBSB\s*[:#]?\s*\d{3}-?\d{3}\b/gi],
  ['tax file number shape', /\b(?:TFN|tax file number)\s*[:#]?\s*\d{3}\s?\d{3}\s?\d{3}\b/gi],
  ['absolute home path', /\/home\/(?!user\b|you\b|runner\b|name\b)[a-z][a-z0-9_-]{1,}\//g],
];

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.jar', '.zip', '.gz', '.age', '.pdf', '.keystore', '.jks', '.db']);

export function loadDenylist(extra = []) {
  const out = [...extra];
  const file = process.env.MINT_DENYLIST || join(homedir(), '.config', 'mint', 'export-denylist.txt');
  if (existsSync(file)) for (const l of readFileSync(file, 'utf8').split('\n')) if (l.trim() && !l.startsWith('#')) out.push(l.trim());
  return [...new Set(out.map((s) => (s.startsWith('re:') ? s : s.toLowerCase())))];
}

const reCache = new Map();
/** True when `text` holds the denylist entry `d`: a literal (compared lower case) or a `re:` pattern. */
export function denyHit(text, d) {
  if (!d.startsWith('re:')) return text.toLowerCase().includes(d);
  if (!reCache.has(d)) reCache.set(d, new RegExp(d.slice(3), 'i'));
  return reCache.get(d).test(text);
}

/** Findings in one block of text: [{ line, kind }]. */
export function scanText(text, { deny = [] } = {}) {
  const found = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 4000 && /^[A-Za-z0-9+/=\s]+$/.test(line)) continue; // an embedded blob, not prose
    if (line.includes(ALLOW_MARKER)) continue;
    for (const [kind, re, ok] of RULES) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) if (!ok || ok(m[0], m[1])) found.push({ line: i + 1, kind });
    }
    for (const d of deny) if (denyHit(line, d)) found.push({ line: i + 1, kind: 'denylisted string' });
  }
  return found;
}

export function pathProblem(rel) {
  return FORBIDDEN_PATHS.some((re) => re.test(rel)) ? 'forbidden file' : null;
}

function* walk(dir, root) {
  for (const name of readdirSync(dir)) {
    if (name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p, root);
    else yield [p, relative(root, p)];
  }
}

function* trackedFiles(root) {
  const list = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
  for (const rel of list) if (existsSync(join(root, rel))) yield [join(root, rel), rel];
}

/** Sweep a directory. Returns [{ file, line, kind }]. `tracked` limits it to what git tracks. */
export function scanTree(root, { deny = [], tracked = false } = {}) {
  const out = [];
  for (const [abs, rel] of tracked ? trackedFiles(root) : walk(root, root)) {
    const bad = pathProblem(rel);
    if (bad) { out.push({ file: rel, line: 0, kind: bad }); continue; }
    if (BINARY_EXT.has(extname(abs).toLowerCase()) || statSync(abs).size > 3_000_000) continue;
    const buf = readFileSync(abs);
    if (buf.includes(0)) continue;
    for (const f of scanText(buf.toString('utf8'), { deny })) if (!allowedHere(rel, f.kind)) out.push({ file: rel, ...f });
    for (const d of deny) if (denyHit(rel, d)) out.push({ file: rel, line: 0, kind: 'denylisted string (in path)' });
  }
  return out;
}

// Added lines of a unified diff, scanned one by one. `commit` tags findings when the patch spans commits.
function scanPatch(patch, deny) {
  const out = [];
  let commit = '', file = '', n = 0;
  for (const l of patch.split('\n')) {
    if (l.startsWith('commit ')) { commit = l.slice(7); continue; }
    if (l.startsWith('+++ b/')) { file = l.slice(6); continue; }
    if (l.startsWith('@@')) { n = Number(/\+(\d+)/.exec(l)?.[1] ?? 0) - 1; continue; }
    if (!l.startsWith('+') || l.startsWith('+++')) continue;
    n++;
    for (const f of scanText(l.slice(1), { deny })) if (!allowedHere(file, f.kind)) out.push({ file: commit ? `${file}@${commit}` : file, line: n, kind: f.kind });
  }
  return out;
}

const PATCH_EXCLUDES = ['--', '.', ':(exclude)*.png', ':(exclude)*.jpg', ':(exclude)*.woff2', ':(exclude)package-lock.json'];

/**
 * Sweep every added line and every filename in a repo's history: all of it, or only the commits in
 * `range` (for example `origin/main..HEAD`, the commits about to be published).
 */
export function scanHistory(repo, { deny = [], range = null } = {}) {
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 1 << 30 });
  const revs = range ? [range] : ['--all'];
  const out = [];
  const names = new Set(git('log', ...revs, '--name-only', '--format=').split('\n').filter(Boolean));
  for (const n of names) {
    const bad = pathProblem(n);
    if (bad) out.push({ file: n, line: 0, kind: `${bad} (in history)` });
  }
  // who made each commit and what they said: names and emails live here, not in any file
  for (const c of git('log', ...revs, '--format=%H%x1f%an <%ae>%x1f%cn <%ce>%x1f%B%x1e').split('\x1e')) {
    const [hash, author, committer, message] = c.trim().split('\x1f');
    if (!hash) continue;
    const at = hash.slice(0, 7);
    for (const [what, text] of [['author', author], ['committer', committer], ['message', message ?? '']]) {
      for (const f of scanText(text, { deny })) out.push({ file: `commit ${what}@${at}`, line: f.line, kind: f.kind });
    }
  }
  out.push(...scanPatch(git('log', ...revs, '-p', '--no-color', '--format=commit %h', ...PATCH_EXCLUDES), deny));
  return out;
}

/** Sweep what is staged in `repo` against HEAD: every added line, and the name of every changed file. */
export function scanStagedDiff(repo, { deny = [] } = {}) {
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 1 << 30 });
  const out = [];
  for (const n of git('diff', '--cached', '--name-only', '-z', 'HEAD').split('\0').filter(Boolean)) {
    const bad = pathProblem(n);
    if (bad) out.push({ file: n, line: 0, kind: `${bad} (in diff)` });
    for (const d of deny) if (denyHit(n, d)) out.push({ file: n, line: 0, kind: 'denylisted string (in path)' });
  }
  out.push(...scanPatch(git('diff', '--cached', '--no-color', '--unified=0', 'HEAD', ...PATCH_EXCLUDES), deny));
  return out;
}

export function summarise(findings) {
  const by = new Map();
  for (const f of findings) {
    const k = `${f.kind}\t${f.file}`;
    by.set(k, [...(by.get(k) ?? []), f.line]);
  }
  return [...by].map(([k, lines]) => { const [kind, file] = k.split('\t'); return `${file}:${[...new Set(lines)].slice(0, 6).join(',')}  ${kind}`; });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const flagVal = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
  const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--deny') ?? join(fileURLToPath(import.meta.url), '..', '..');
  const deny = loadDenylist((flagVal('--deny') ?? '').split(',').filter(Boolean));
  const findings = scanTree(dir, { deny, tracked: args.includes('--tracked') });
  if (args.includes('--history')) findings.push(...scanHistory(dir, { deny }));
  const lines = summarise(findings);
  for (const l of lines) console.log(l);
  console.log(lines.length ? `${lines.length} finding(s) in ${basename(dir)}` : `clean: ${basename(dir)}${args.includes('--history') ? ' (tree and history)' : ''}`);
  process.exit(lines.length ? 1 : 0);
}

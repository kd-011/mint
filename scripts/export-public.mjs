// Publish a scrubbed copy of Mint to the public checkout, outside this repo.
//
//   node scripts/export-public.mjs [--out DIR] [--ref REF] [--push] [--from SHA] [--branch main]
//                                  [--deny a,b] [--exclude path,path] [--author "Name <email>"]
//   node scripts/export-public.mjs --fresh [--out DIR] [--force] ...      the old one-commit export
//
// Default (incremental): DIR (default ~/exports/mint-public) is a persistent clone of the public
// repository. The script
//   1. refuses unless DIR is a clean checkout of --branch (default main) that is not behind or
//      diverged from origin (it fetches first),
//   2. takes the files git tracks at REF (default HEAD) with `git archive`, so nothing untracked
//      (.env, data/, backups/, keystores, .shots/) can come along, drops the exclude list (EXCLUDE
//      below, plus --exclude) and scans what is left (scripts/secret-scan.mjs),
//   3. replaces the checkout's tracked files with that tree (never .git), scans the staged diff
//      against the previous public commit, makes ONE new commit on top (history is never
//      rewritten), then scans the whole tree and every unpushed commit, message included.
// Any scan finding aborts: the checkout is put back exactly as it was and nothing is committed.
// The commit message lists the private commit subjects since the last export (subjects the scan
// flags are left out). The private sha of the last export is kept in DIR/.git/mint-export-state.json,
// inside .git, so it is never in the public tree and never pushed. --from SHA overrides it.
// Without --push the commit is left ready; with --push it is pushed to origin (also when an
// earlier run left a commit unpushed).
//
// The scans read text and cannot see inside a picture, so step 3 also runs the image gate: an image or
// binary that is new or changed, in the staged tree or in any unpushed commit, has to be listed by exact
// path in scripts/export-allowlist.txt at REF (what the fixture scripts generate). Anything else aborts
// the same way, before the commit, and exits EXIT_IMAGE_GATE with the paths on stderr, so a scheduled job
// can ask a human to look at them instead of pushing. There is no flag to skip it.
//
// --fresh keeps the original behaviour: write a brand-new one-commit repo with no remote to DIR
// (refuses a non-empty DIR unless --force, and only ever deletes a git repo), scan the finished
// repo tree and history, and remove it if that fails.
//
// Every commit is authored and committed as DEFAULT_IDENTITY (the public handle and its GitHub
// noreply address), never as the source repo's own git identity. Override it with --author
// "Name <email>" or GIT_AUTHOR_NAME/EMAIL and GIT_COMMITTER_NAME/EMAIL; the scans read the
// author and committer of the commit, so an identity on the denylist is refused.
//
// Findings print as file:line and kind, never the matched text. Literals you never want
// published (your domain, email, home path) go in ~/.config/mint/export-denylist.txt
// (or MINT_DENYLIST), see scripts/secret-scan.mjs. The export refuses to run if that file is missing or
// has no entries: without it the scans would pass a tree holding every one of those strings.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_PATHS, denylistEntries, denylistFile, loadDenylist, scanHistory, scanStagedDiff, scanText, scanTree, summarise } from './secret-scan.mjs';

export const DEFAULT_IDENTITY = { name: 'kd-011', email: '229900447+kd-011@users.noreply.github.com' };

// Who the export commit is by: --author, else the GIT_* env, else DEFAULT_IDENTITY. Never git config.
export function exportIdentity(author = null, env = process.env) {
  if (author) {
    const m = /^(.+?)\s*<([^<>]+)>$/.exec(author.trim());
    if (!m) throw new Error('--author must look like: Name <email>');
    return { authorName: m[1], authorEmail: m[2], committerName: m[1], committerEmail: m[2] };
  }
  const authorName = env.GIT_AUTHOR_NAME || DEFAULT_IDENTITY.name;
  const authorEmail = env.GIT_AUTHOR_EMAIL || DEFAULT_IDENTITY.email;
  return { authorName, authorEmail, committerName: env.GIT_COMMITTER_NAME || authorName, committerEmail: env.GIT_COMMITTER_EMAIL || authorEmail };
}

// Paths (relative, forward slashes) that never go into a public copy, on top of the
// scanner's FORBIDDEN_PATHS (.env, data/, backups/, .shots/, keystores, databases).
// The docs folders listed here once held screenshots of a real book; they are gone from
// main, and stay listed so an export of an older ref cannot bring them back.
export const EXCLUDE = [
  /^docs\/(demo-mode|five-tab|plain-home|transactions-polish|transactions-plain|uplift|kit-pass-2|goals-list)\//,
  /^android-shell\/dist\//,
  /^\.claude\//,
  /^(CLAUDE|AGENTS)\.md$/,
];

export function isExcluded(rel, extra = []) {
  return FORBIDDEN_PATHS.some((re) => re.test(rel)) || EXCLUDE.some((re) => re.test(rel)) || extra.some((p) => rel === p || rel.startsWith(p.endsWith('/') ? p : `${p}/`));
}

function* walkFiles(dir, root = dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walkFiles(p, root);
    else yield relative(root, p).split(sep).join('/');
  }
}

function pruneEmptyDirs(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { pruneEmptyDirs(p); if (!readdirSync(p).length) rmSync(p, { recursive: true }); }
  }
}

const git = (cwd, args, opts = {}) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1 << 30, ...opts }).trim();

// The export's own exit code when the image gate refuses; any other failure exits 1.
export const EXIT_IMAGE_GATE = 3;
export const ALLOWLIST_FILE = 'scripts/export-allowlist.txt';

// Pictures and containers the scans skip or cannot read, whatever git makes of them.
const GATED_EXT = /\.(png|jpe?g|gif|webp|avif|heic|heif|bmp|tiff?|ico|svgz?|psd|xcf|ai|eps|pdf|mp4|m4v|mov|webm|mkv|avi|mp3|m4a|wav|ogg|zip|tgz|gz|bz2|xz|7z|rar|tar|jar|war|apk|aab|ipa|dmg|exe|dll|so|dylib|bin|wasm|woff2?|ttf|otf|eot|age)$/i;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const SCAN_LIMIT = 3_000_000; // scanTree does not read a file over this size
const DATA_URI = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{200,}/i;
const BLOB_LINE = /^[A-Za-z0-9+/=\s]{4001,}$/m; // scanText skips a line like this as an embedded blob

/** Why the image gate cares about this file, or null when it is plain text the scans can read. */
export function gatedReason(rel, buf) {
  if (GATED_EXT.test(rel)) return 'image or binary by name';
  if (buf.length > SCAN_LIMIT) return 'too large for the scan to read';
  if (buf.includes(0) || buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'binary content';
  let text;
  try { text = UTF8.decode(buf); } catch { return 'binary content'; }
  if (DATA_URI.test(text) || BLOB_LINE.test(text)) return 'embedded base64 blob';
  return null;
}

export function readAllowlist(source, ref) {
  let body = '';
  try { body = git(source, ['show', `${ref}:${ALLOWLIST_FILE}`], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* no file: nothing is allowed */ }
  return new Set(body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
}

function requireDenylist() {
  const file = denylistFile();
  const entries = denylistEntries(file);
  if (!entries) throw new Error(`the denylist ${file} is missing; refusing to export without it`);
  if (!entries.length) throw new Error(`the denylist ${file} has no entries; refusing to export without it`);
}

function gateError(gated) {
  const e = new Error(`image gate refused the export: ${gated.length} image or binary path(s) new or changed and not in ${ALLOWLIST_FILE}`);
  e.findings = gated;
  e.exitCode = EXIT_IMAGE_GATE;
  return e;
}

// Paths the allowlist does not cover, as "path  reason" lines. `read` gets a path and returns its bytes.
function gateFindings(paths, read, allow, seen = new Map()) {
  for (const rel of paths) {
    if (allow.has(rel) || seen.has(rel)) continue;
    const why = gatedReason(rel, read(rel));
    if (why) seen.set(rel, why);
  }
  return seen;
}

// What this run would publish beyond origin: the staged tree, and every commit an earlier run left
// unpushed. Those count on their own, because a picture added and later removed is still in history.
function imageGate(out, { allow, remoteRef }) {
  const blob = (spec) => execFileSync('git', ['-C', out, 'cat-file', 'blob', spec], { maxBuffer: 1 << 30 });
  const staged = git(out, ['diff', '--cached', '--no-renames', '--diff-filter=d', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean);
  const seen = gateFindings(staged, (rel) => blob(`:${rel}`), allow);
  const unpushed = git(out, ['rev-list', `${remoteRef}..HEAD`]).split('\n').filter(Boolean);
  for (const c of unpushed) {
    const changed = git(out, ['diff-tree', '-m', '--root', '-r', '--no-commit-id', '--no-renames', '--diff-filter=d', '--name-only', '-z', c]).split('\0').filter(Boolean);
    gateFindings(new Set(changed), (rel) => blob(`${c}:${rel}`), allow, seen);
  }
  return [...seen].map(([rel, why]) => `${rel}  ${why}`);
}

// Where the private sha of the last export is kept: inside .git, so never in the tree and never pushed.
const STATE_FILE = 'mint-export-state.json';
const statePath = (out) => join(out, '.git', STATE_FILE);
export function readState(out) {
  try { return JSON.parse(readFileSync(statePath(out), 'utf8')); } catch { return {}; }
}
function writeState(out, privateSha) {
  writeFileSync(statePath(out), JSON.stringify({ privateSha }) + '\n');
}

function refuse(message, findings) {
  const e = new Error(message);
  if (findings) e.findings = summarise(findings);
  return e;
}

/**
 * The scrubbed tree at REF in a temp directory: archive, exclude list, secret scan. Returns
 * { stage, omitted, files, denyList } (the caller removes `stage`), or throws, leaving nothing behind.
 */
function stageTree({ source, ref, deny, exclude, log }) {
  const stage = mkdtempSync(join(tmpdir(), 'mint-export-'));
  try {
    const tar = execFileSync('git', ['-C', source, 'archive', '--format=tar', ref], { maxBuffer: 1 << 30 });
    execFileSync('tar', ['-x', '-C', stage], { input: tar });

    const omitted = [];
    for (const rel of [...walkFiles(stage)]) {
      if (isExcluded(rel, exclude)) { rmSync(join(stage, rel), { force: true }); omitted.push(rel); }
    }
    pruneEmptyDirs(stage);
    log(`omitted ${omitted.length} file(s) on the exclude list`);

    const denyList = loadDenylist(deny);
    const findings = scanTree(stage, { deny: denyList });
    if (findings.length) {
      throw refuse(`secret scan refused the export: ${summarise(findings).length} finding(s)`, findings);
    }
    return { stage, omitted, files: [...walkFiles(stage)], denyList };
  } catch (e) {
    rmSync(stage, { recursive: true, force: true });
    throw e;
  }
}

const commitEnv = (id) => ({ ...process.env, GIT_AUTHOR_NAME: id.authorName, GIT_AUTHOR_EMAIL: id.authorEmail, GIT_COMMITTER_NAME: id.committerName, GIT_COMMITTER_EMAIL: id.committerEmail });

/**
 * Build a brand-new one-commit export (--fresh). Returns { out, kept, omitted, commit }. Throws an
 * Error whose `findings` lists what the scan found when it refuses.
 */
export function buildExport({ source, out, ref = 'HEAD', force = false, deny = [], exclude = [], author = null, log = () => {} }) {
  requireDenylist();
  source = resolve(source);
  out = resolve(out);
  const top = git(source, ['rev-parse', '--show-toplevel']);
  if (out === top || out.startsWith(top + sep)) throw new Error(`refusing to write inside the source repo (${out})`);
  if (existsSync(out) && readdirSync(out).length) {
    if (!force) throw new Error(`${out} already exists and is not empty (pass --force to replace it)`);
    if (!existsSync(join(out, '.git'))) throw new Error(`${out} is not a git repo made by this script, refusing to delete it`);
  }

  const { stage, omitted, files, denyList } = stageTree({ source, ref, deny, exclude, log });
  try {
    const gated = [...gateFindings(files, (rel) => readFileSync(join(stage, rel)), readAllowlist(source, ref))].map(([rel, why]) => `${rel}  ${why}`);
    if (gated.length) throw gateError(gated);
    const id = exportIdentity(author);

    if (existsSync(out)) rmSync(out, { recursive: true, force: true });
    mkdirSync(dirname(out), { recursive: true });
    cpSync(stage, out, { recursive: true });
    const env = commitEnv(id);
    const run = (...a) => execFileSync('git', ['-C', out, ...a], { env, encoding: 'utf8' });
    run('init', '-q', '-b', 'main');
    run('add', '-A');
    run('commit', '-q', '-m', 'Mint: first public commit', '-m', 'A clean single-commit export of the project tree. No earlier history.');
    if (run('remote').trim()) throw new Error('the export has a remote; it must have none');
    if (Number(run('rev-list', '--count', 'HEAD').trim()) !== 1) throw new Error('the export must be exactly one commit');

    const final = [...scanTree(out, { deny: denyList, tracked: true }), ...scanHistory(out, { deny: denyList })];
    if (final.length) {
      rmSync(out, { recursive: true, force: true });
      throw refuse(`final scan of the export failed: ${summarise(final).length} finding(s); it was removed`, final);
    }
    writeState(out, git(source, ['rev-parse', ref]));
    const kept = [...walkFiles(out)].filter((f) => !f.startsWith('.git/')).length;
    return { out, kept, omitted, commit: run('rev-parse', '--short', 'HEAD').trim() };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// A branch landed by the task runner is one commit titled `Merge feature/<task words>-<id>`. The
// branch name and task id mean nothing in public, so show the words: "Merge feature/mint-widget-screen-mvabc123"
// becomes "Widget screen". Task slugs are cut at about 32 characters, so a long one gets an ellipsis.
export function plainSubject(subject) {
  const m = /^Merge feature\/(.+?)-[a-z]{2}[a-z0-9]{5,}$/.exec(subject);
  if (!m) return subject;
  const words = m[1].replace(/^mint-/, '').replace(/-+/g, ' ').trim();
  if (!words) return '';
  return `${words[0].toUpperCase()}${words.slice(1)}${m[1].length >= 30 ? '...' : ''}`;
}

// Private commit subjects since the last export, minus anything the scan flags. Merge commits
// (branch names) are skipped. Without a usable marker, falls back to commits newer than `sinceDate`.
function changeSubjects({ source, ref, from, sinceDate, deny, log }) {
  let range = [`--since=${sinceDate}`, ref];
  if (from) {
    const ok = (() => { try { git(source, ['merge-base', '--is-ancestor', from, ref]); return true; } catch { return false; } })();
    if (ok) range = [`${from}..${ref}`];
    else log(`the last exported commit ${from.slice(0, 7)} is not an ancestor of ${ref}; listing commits since ${sinceDate} instead`);
  }
  const all = [...new Set(git(source, ['log', '--no-merges', '--format=%s', ...range]).split('\n').map((l) => plainSubject(l.trim())).filter(Boolean))];
  const safe = all.filter((l) => !scanText(l, { deny }).length);
  return { subjects: safe.slice(0, 40), more: Math.max(0, safe.length - 40), withheld: all.length - safe.length };
}

function commitMessage({ subjects, more, withheld }) {
  const n = subjects.length + more;
  const head = `Mint update ${new Date().toISOString().slice(0, 10)}${n ? `: ${n} change${n === 1 ? '' : 's'}` : ''}`;
  const lines = subjects.map((l) => `- ${l}`);
  if (more) lines.push(`- and ${more} more`);
  if (withheld) lines.push(`(${withheld} subject${withheld === 1 ? '' : 's'} left out)`);
  return lines.length ? `${head}\n\n${lines.join('\n')}\n` : `${head}\n`;
}

/**
 * Update a persistent public checkout with one new commit on top (see the header). Returns
 * { out, committed, commit, files, subjects, pushed }. Throws an Error (with `findings` when a scan
 * refused) and leaves the checkout exactly as it found it.
 */
export function updatePublic({ source, out, ref = 'HEAD', branch = 'main', from = null, push = false, deny = [], exclude = [], author = null, log = () => {} }) {
  requireDenylist();
  source = resolve(source);
  out = resolve(out);
  const top = git(source, ['rev-parse', '--show-toplevel']);
  if (out === top || out.startsWith(top + sep)) throw new Error(`refusing to write inside the source repo (${out})`);
  if (!existsSync(join(out, '.git'))) throw new Error(`${out} is not a git checkout of the public repo (clone it there first, or use --fresh to start a new one)`);
  if (resolve(git(out, ['rev-parse', '--show-toplevel'])) !== out) throw new Error(`${out} is inside another git repo, not a checkout of its own`);

  const g = (...a) => git(out, a);
  const onBranch = g('rev-parse', '--abbrev-ref', 'HEAD');
  if (onBranch !== branch) throw new Error(`the public checkout is on ${onBranch === 'HEAD' ? 'a detached HEAD' : `branch ${onBranch}`}, not ${branch}; check out ${branch} first`);
  const dirty = g('status', '--porcelain', '-z').split('\0').filter(Boolean);
  if (dirty.length) {
    throw new Error(`the public checkout is dirty (${dirty.length} uncommitted path(s)); commit, stash or discard them first`);
  }
  if (!g('remote').split('\n').includes('origin')) throw new Error('the public checkout has no origin remote to compare against');
  g('fetch', '-q', 'origin');
  const remoteRef = `origin/${branch}`;
  try { g('rev-parse', '--verify', '-q', remoteRef); } catch { throw new Error(`origin has no ${branch} branch`); }
  const [ahead, behind] = g('rev-list', '--left-right', '--count', `HEAD...${remoteRef}`).split(/\s+/).map(Number);
  if (behind && ahead) throw new Error(`the public checkout has diverged from ${remoteRef} (${ahead} ahead, ${behind} behind); reconcile it by hand first`);
  if (behind) throw new Error(`the public checkout is behind ${remoteRef} by ${behind} commit(s); pull them first`);

  const prev = g('rev-parse', 'HEAD');
  const prevDate = g('log', '-1', '--format=%cI', 'HEAD');
  const id = exportIdentity(author);
  const env = commitEnv(id);
  const run = (...a) => execFileSync('git', ['-C', out, ...a], { env, encoding: 'utf8', maxBuffer: 1 << 30 });
  const restore = () => { g('reset', '-q', '--hard', prev); g('clean', '-fdq'); };

  const { stage, omitted, files, denyList } = stageTree({ source, ref, deny, exclude, log });
  let committed = false, subjects = { subjects: [], more: 0, withheld: 0 };
  try {
    // replace the working tree: drop what git tracks, copy the scrubbed tree over, stage it all
    for (const rel of g('ls-files', '-z').split('\0').filter(Boolean)) {
      rmSync(join(out, rel), { force: true });
      for (let d = dirname(join(out, rel)); d !== out && !readdirSync(d).length; d = dirname(d)) rmSync(d, { recursive: true });
    }
    cpSync(stage, out, { recursive: true });
    g('add', '-A');
    const staged = new Set(g('ls-files', '-z').split('\0').filter(Boolean));
    const lost = files.filter((f) => !staged.has(f));
    if (lost.length) throw new Error(`${lost.length} file(s) of the export would be left out of the commit by the checkout's .gitignore: ${lost.slice(0, 5).join(', ')}`);

    const gated = imageGate(out, { allow: readAllowlist(source, ref), remoteRef });
    if (gated.length) throw gateError(gated);

    if (g('diff', '--cached', '--name-only', '-z', 'HEAD').split('\0').filter(Boolean).length) {
      const diffFindings = scanStagedDiff(out, { deny: denyList });
      if (diffFindings.length) {
        throw refuse(`diff scan refused the update: ${summarise(diffFindings).length} finding(s)`, diffFindings);
      }
      const state = readState(out);
      subjects = changeSubjects({ source, ref, from: from ?? state.privateSha ?? null, sinceDate: prevDate, deny: denyList, log });
      execFileSync('git', ['-C', out, 'commit', '-q', '-F', '-'], { env, input: commitMessage(subjects) });
      committed = true;
    } else {
      log('the tree is identical to the last public commit');
    }

    const lateFindings = [...scanTree(out, { deny: denyList, tracked: true }), ...scanHistory(out, { deny: denyList, range: `${remoteRef}..HEAD` })];
    if (lateFindings.length) {
      throw refuse(`final scan of the update failed: ${summarise(lateFindings).length} finding(s); nothing was committed`, lateFindings);
    }
  } catch (e) {
    restore();
    throw e;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  writeState(out, git(source, ['rev-parse', ref]));
  const unpushed = Number(g('rev-list', '--count', `${remoteRef}..HEAD`));
  let pushed = false;
  if (push && unpushed) { run('push', '-q', 'origin', `HEAD:refs/heads/${branch}`); pushed = true; }
  return {
    out, committed, commit: g('rev-parse', '--short', 'HEAD'), prev: prev.slice(0, 7), omitted, unpushed, pushed,
    subjects: subjects.subjects, files: committed ? g('diff', '--shortstat', 'HEAD~1', 'HEAD') : '',
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
  const list = (n) => (val(n) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const source = join(dirname(fileURLToPath(import.meta.url)), '..');
  const common = { source, out: val('--out') ?? join(homedir(), 'exports', 'mint-public'), ref: val('--ref') ?? 'HEAD', deny: list('--deny'), exclude: list('--exclude'), author: val('--author'), log: console.log };
  try {
    if (args.includes('--fresh')) {
      const r = buildExport({ ...common, force: args.includes('--force') });
      console.log(`exported ${r.kept} file(s) to ${r.out}: one commit (${r.commit}), no remote, secret scan clean`);
      if (r.omitted.length) console.log(`omitted:\n${r.omitted.map((f) => `  ${f}`).join('\n')}`);
    } else {
      const r = updatePublic({ ...common, branch: val('--branch') ?? 'main', from: val('--from'), push: args.includes('--push') });
      if (r.committed) console.log(`committed ${r.commit} on top of ${r.prev} in ${r.out}: ${r.files.trim()}, secret scan clean`);
      else console.log(`nothing to publish: ${r.out} already matches ${common.ref}`);
      if (r.pushed) console.log(`pushed ${r.commit} to origin`);
      else if (r.unpushed) console.log(`${r.unpushed} commit(s) ready in ${r.out}, not pushed (rerun with --push, or git -C ${r.out} push)`);
    }
  } catch (e) {
    console.error(`export failed: ${e.message}`);
    for (const f of e.findings ?? []) console.error(`  ${f}`);
    process.exit(e.exitCode ?? 1);
  }
}

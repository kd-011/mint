// Build a clean, single-commit copy of Mint for publishing, outside this repo.
//
//   node scripts/export-public.mjs [--out DIR] [--ref REF] [--force] [--deny a,b] [--exclude path,path] [--author "Name <email>"]
//
// Takes the files git tracks at REF (default HEAD) with `git archive`, so nothing
// untracked (.env, data/, backups/, keystores, .shots/) can come along, then:
//   1. drops everything on the exclude list (EXCLUDE below, plus --exclude),
//   2. runs the secret and personal-data scan (scripts/secret-scan.mjs) over what is left
//      and refuses, with a non-zero exit and nothing written, if it finds anything,
//   3. writes the result to DIR (default ~/exports/mint-public, never inside this repo),
//      runs `git init` and makes ONE commit, no remote, no history,
//   4. scans the finished repo (tree and history) once more and removes it if it fails.
// The commit is authored and committed as DEFAULT_IDENTITY (the public handle and its GitHub
// noreply address), never as the source repo's own git identity. Override it with --author
// "Name <email>" or GIT_AUTHOR_NAME/EMAIL and GIT_COMMITTER_NAME/EMAIL; the final scan reads the
// author and committer of the commit, so an identity on the denylist is refused.
// It never pushes and never adds a remote. Publishing is a separate, manual step.
//
// Findings print as file:line and kind, never the matched text. Literals you never want
// published (your domain, email, home path) go in ~/.config/mint/export-denylist.txt
// (or MINT_DENYLIST), see scripts/secret-scan.mjs.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_PATHS, loadDenylist, scanHistory, scanTree, summarise } from './secret-scan.mjs';

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

/**
 * Build the export. Returns { out, kept, omitted, commit }. Throws an Error whose
 * `findings` lists what the scan found when it refuses.
 */
export function buildExport({ source, out, ref = 'HEAD', force = false, deny = [], exclude = [], author = null, log = () => {} }) {
  source = resolve(source);
  out = resolve(out);
  const top = git(source, ['rev-parse', '--show-toplevel']);
  if (out === top || out.startsWith(top + sep)) throw new Error(`refusing to write inside the source repo (${out})`);
  if (existsSync(out) && readdirSync(out).length) {
    if (!force) throw new Error(`${out} already exists and is not empty (pass --force to replace it)`);
    if (!existsSync(join(out, '.git'))) throw new Error(`${out} is not a git repo made by this script, refusing to delete it`);
  }

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
      const e = new Error(`secret scan refused the export: ${summarise(findings).length} finding(s)`);
      e.findings = summarise(findings);
      throw e;
    }

    const id = exportIdentity(author);

    if (existsSync(out)) rmSync(out, { recursive: true, force: true });
    mkdirSync(dirname(out), { recursive: true });
    cpSync(stage, out, { recursive: true });
    const env = { ...process.env, GIT_AUTHOR_NAME: id.authorName, GIT_AUTHOR_EMAIL: id.authorEmail, GIT_COMMITTER_NAME: id.committerName, GIT_COMMITTER_EMAIL: id.committerEmail };
    const run = (...a) => execFileSync('git', ['-C', out, ...a], { env, encoding: 'utf8' });
    run('init', '-q', '-b', 'main');
    run('add', '-A');
    run('commit', '-q', '-m', 'Mint: first public commit', '-m', 'A clean single-commit export of the project tree. No earlier history.');
    if (run('remote').trim()) throw new Error('the export has a remote; it must have none');
    if (Number(run('rev-list', '--count', 'HEAD').trim()) !== 1) throw new Error('the export must be exactly one commit');

    const final = [...scanTree(out, { deny: denyList, tracked: true }), ...scanHistory(out, { deny: denyList })];
    if (final.length) {
      rmSync(out, { recursive: true, force: true });
      const e = new Error(`final scan of the export failed: ${summarise(final).length} finding(s); it was removed`);
      e.findings = summarise(final);
      throw e;
    }
    const kept = [...walkFiles(out)].filter((f) => !f.startsWith('.git/')).length;
    return { out, kept, omitted, commit: run('rev-parse', '--short', 'HEAD').trim() };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
  const list = (n) => (val(n) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const source = join(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const r = buildExport({
      source, out: val('--out') ?? join(homedir(), 'exports', 'mint-public'), ref: val('--ref') ?? 'HEAD',
      force: args.includes('--force'), deny: list('--deny'), exclude: list('--exclude'), author: val('--author'), log: console.log,
    });
    console.log(`exported ${r.kept} file(s) to ${r.out}: one commit (${r.commit}), no remote, secret scan clean`);
    if (r.omitted.length) console.log(`omitted:\n${r.omitted.map((f) => `  ${f}`).join('\n')}`);
  } catch (e) {
    console.error(`export failed: ${e.message}`);
    for (const f of e.findings ?? []) console.error(`  ${f}`);
    process.exit(1);
  }
}

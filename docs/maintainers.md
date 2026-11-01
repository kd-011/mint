# Maintainers

Notes for whoever looks after this repository.

## Checks before a release

```sh
node --check *.mjs lib/*.mjs scripts/*.mjs
node --test test/
node scripts/secret-scan.mjs . --tracked
```

CI runs the same three on every push and pull request (`.github/workflows/ci.yml`).

## Regenerating the pictures

`node scripts/gen-assets.mjs` rebuilds the screenshots, banner, hero image, demo GIF and social preview from the demo data. It needs Playwright, a Chromium, `ffmpeg` and ImageMagick installed outside the repo; the header of the script says how to point it at them. Open every image before you commit it. The social preview (`docs/social-preview.png`, 1280x640) cannot be set through the API: upload it under Settings, Social preview.

## Releases

Tag `vX.Y.Z` on `main` and write the release notes by hand: what works, what is rough, how to try the demo. There are no binaries to attach. Move the `Unreleased` entries in `CHANGELOG.md` under the new version and date first.

## Keeping a private working copy in sync

If you develop in a private repository and publish from it, publish the output of `node scripts/export-public.mjs`, never the private repository or its history. The script takes the files git tracks at a ref, drops anything on its exclude list, runs `scripts/secret-scan.mjs` over the result and refuses, changing nothing, if it finds a secret, a personal name or email, a private path or a database. The commits it makes are authored and committed as the identity in `DEFAULT_IDENTITY` (no personal name or email).

The public repository keeps real history: each update is one new commit on top of the last, never a rewrite and never a force-push.

### The release routine

Run from the private repository, on the commit you want to publish. The public checkout is `~/exports/mint-public` unless you pass `--out`; it is an ordinary clone of the public repository on `main`.

```sh
node scripts/export-public.mjs            # one new commit, left ready
git -C ~/exports/mint-public log -1 --stat
git -C ~/exports/mint-public diff HEAD~1  # read it
node scripts/export-public.mjs --push     # pushes the ready commit (or make a new one and push it)
```

What the script does:

1. Refuses unless the checkout is clean, on `main` (`--branch` to change it), and not behind or diverged from `origin` (it runs `git fetch` first). Being ahead, with an earlier commit not yet pushed, is fine.
2. Takes the tracked files at `--ref` (default `HEAD`), drops the exclude list and scans that tree.
3. Replaces the checkout's tracked files with it (never `.git`), then scans the staged diff against the previous public commit and makes one commit.
4. Scans the whole tree and every unpushed commit, message included. Any finding at any step puts the checkout back exactly as it was, commits nothing, and prints `file:line kind`, never the matched text.
5. Does nothing, and says so, when the tree already matches. With `--push` it still pushes a commit an earlier run left unpushed.

The commit message is a list of the private commit subjects since the last export (merge commits skipped; a subject the scan flags is left out). The private sha of the last export lives in `<checkout>/.git/mint-export-state.json`: inside `.git`, so it is never in the public tree and never pushed. `--from <sha>` overrides it, and with no state file the script lists private commits newer than the checkout's last commit. A checkout started with `--fresh` records it too.

To start over with a brand-new single-commit repository (a first publish, or a rebuilt checkout), use `node scripts/export-public.mjs --fresh [--out DIR] [--force]`. It writes a repo with no remote and no history, so it can only be pushed to an empty repository; do not use it on the live public repo.

Contributions that arrive on the public repository (pull requests, dependabot) have to be carried back into the private tree by hand, or the next export will delete them: the export replaces the whole tracked tree. Pull them into the checkout first (the script refuses while it is behind origin), apply the same change privately, then export. Decide which tree is canonical and stick to it.

The denylist of strings that must never be published (your own domain, name, home path) lives outside the repository, in `~/.config/mint/export-denylist.txt` or the file named by `MINT_DENYLIST`, one literal per line, or `re:` followed by a regular expression.

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

Tag `vX.Y.Z` on `main` and write the release notes by hand: what works, what is rough, how to try the demo. There are no binaries to attach.

## Keeping a private working copy in sync

If you develop in a private repository and publish from it, publish the output of `node scripts/export-public.mjs`, never the private repository or its history. The script takes the files git tracks at a ref, drops anything on its exclude list, runs `scripts/secret-scan.mjs` over the result and refuses, writing nothing, if it finds a secret, a personal name or email, a private path or a database. It then makes a single commit as the identity in `DEFAULT_IDENTITY`.

The export is a fresh commit with no shared history, so after the first publish it cannot be pushed over the public repository. For later updates:

1. Run the export (`node scripts/export-public.mjs --ref <ref> --force`).
2. In an ordinary clone of the public repository, replace the working tree with the export's files (keep `.git`), for example with `rsync -a --delete --exclude .git <export>/ <clone>/`.
3. Review `git status` and `git diff`, commit with a sign-off, and push a branch or `main` as you would any change.

Contributions that arrive on the public repository have to be carried back into the private tree by hand (or the private tree retired in favour of the public one). Decide which is canonical and stick to it.

The denylist of strings that must never be published (your own domain, name, home path) lives outside the repository, in `~/.config/mint/export-denylist.txt` or the file named by `MINT_DENYLIST`, one literal per line, or `re:` followed by a regular expression.

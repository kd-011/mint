---
slug: mint-architecture-running
name: Mint architecture, running it
repo: .
status: active
last_verified: 2026-11-22
---

# Running it: modes, backups, the Android shell and the pipeline

The same server runs in four ways. What differs is who sits in front of it and where the book lives. See ../ARCHITECTURE.md for the overall map and ../self-hosting.md for the operator's recipes.

## Modes

- Real: `node server.mjs` behind a login gateway, reading `.env` from `MINT_HOME`. `MINT_GATE_KEY`, `MINT_USER` and `MINT_ORIGIN` are the settings an install must carry. <!-- src: server.mjs:44-46, .env.example:4-16 -->
- Demo: `node scripts/demo-seed.mjs` starts a fake Redbark, a real server in an empty temp directory and a small front, seeds invented budgets, goals, assets, shares, subscriptions and debts, and deletes the directory on exit. No key, no bank, nothing kept. <!-- src: scripts/demo-seed.mjs:1-10 -->
- Local: `node scripts/local.mjs` runs the real server on a random inner port with a fresh gate key each run, the fingerprint lock off and the origin set to `127.0.0.1:<port>`, behind the loopback-only front, on port 8981 by default. Nothing is invented and nothing is deleted on exit; the book is `MINT_HOME/data/mint.db`. <!-- src: scripts/local.mjs:1-9, scripts/local.mjs:17-34 -->
- Fixture: `scripts/ui-fixture.mjs` is the demo's engine with the lock and scheduler off and no `.env` read, for screenshots, UI passes and the merge gate's journeys. <!-- src: scripts/ui-fixture.mjs:1-12 -->
- Container: the image is `node:22-alpine` plus the source, with no install or build step, `MINT_HOME=/data`, a non-root `node` user and a `/healthz` health check. Compose offers the demo by default, `--profile local` and `--profile real`, all published on the host's loopback only. <!-- src: Dockerfile:1-33, docker-compose.yml:1-12 -->

## Backup and restore

- `scripts/backup.mjs` writes a `VACUUM INTO` snapshot to `backups/mint-<date>.db` and keeps the newest 14. It does not schedule itself: run it daily from cron or a systemd timer. <!-- src: scripts/backup.mjs:1-3, scripts/backup.mjs:23, scripts/backup.mjs:40, docs/self-hosting.md:184-191 -->
- With `MINT_BACKUP_HOST` and `MINT_BACKUP_AGE_RECIPIENT` set it also sends a gzipped, age-encrypted snapshot over ssh and rsync (14 kept) and an encrypted mirror of `data/receipts/`. A host with no valid recipient exits non-zero and sends nothing, and a recipient with no host exits non-zero too, so a half-configured install does not go quietly green. <!-- src: scripts/backup.mjs:1-10, scripts/backup.mjs:48-60, scripts/backup.mjs:81-83 -->
- `scripts/restore-test.mjs` pulls the newest off-box copy, decrypts it with the age private key (`MINT_BACKUP_AGE_KEY`), checks integrity, compares row counts with the live database, and checks the receipts mirror, including one receipt decrypted and compared byte for byte. It is read only on both sides. <!-- src: scripts/restore-test.mjs:1-6 -->
- Restore is manual: stop Mint, copy a snapshot over `data/mint.db`, delete any `mint.db-wal` and `mint.db-shm` beside it, start Mint. <!-- src: docs/self-hosting.md:184-191 -->
- `scripts/check-env.mjs` is an opt-in preflight (`MINT_REQUIRE_OFFBOX`, `MINT_REQUIRE_ANDROID`) that fails naming variables, never values. Without those flags it checks nothing. <!-- src: scripts/check-env.mjs:1-6, lib/envcheck.mjs:1-8 -->

## Android shell

- `android-shell/` is a thin Capacitor 8 WebView over the owner's own server, built and signed by the owner with their own keystore and sideloaded. Every screen and number comes from the server, so web changes never need a new APK. <!-- src: android-shell/README.md:3 -->
- The shell adds `FLAG_SECURE`, no backup, TLS only, no permissions beyond INTERNET and ACCESS_NETWORK_STATE, an offline page and WebAuthn support so the passkey lock works. `build.sh` builds a release APK and fails unless the built APK has the expected properties. <!-- src: android-shell/README.md:3, android-shell/README.md:30-39 -->

## Pipeline

- CI runs the syntax check, `node --test test/` and the secret scan on every push, pull request and weekly. Tests need no network and use fakes for Redbark, Wise and Frankfurter. <!-- src: .github/workflows/ci.yml:1-32, test/fixtures/fake-redbark.mjs:1-3, README.md:56 -->
- A release is a `CHANGELOG.md` section: a workflow compares its version with the tags, runs the tests, builds and checks the image through the demo, pushes it for amd64 and arm64 and tags the release. <!-- src: docs/maintainers.md:25 -->
- Publishing to the public repository is `scripts/export-public.mjs`, which commits the tracked files minus an exclude list, after a secret and personal-data scan and an image gate, as one new commit. <!-- src: docs/maintainers.md:31-52, scripts/export-public.mjs:69-78 -->
- The weekly upkeep workflow checks links in the docs and runs `dossier-scribe` over `dossiers/` to flag claims whose cited files changed. <!-- src: .github/workflows/upkeep.yml:24-31, .github/workflows/upkeep.yml:62-71 -->

## Unverified

- Which processes supervise the live instance and what schedules its backup. The repo documents recipes only; the running deployment is described in the project dossier.

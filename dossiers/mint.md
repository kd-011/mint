---
slug: mint
name: Mint
repo: .
status: active
last_verified: 2026-11-02
tags: [node, sqlite, self-hosted, finance]
---

Self-hosted personal finance for Australians. These claims are the README's main promises, each tied to the code that keeps them.

## Features

- Needs Node 22 or newer, because `node:sqlite` ships inside it, and there is no npm install or build step. <!-- src: Dockerfile:1-3 -->
- The server is plain Node built-ins, `node:http` and `node:sqlite`, with a vanilla page in `public/`. <!-- src: server.mjs:2 -->
- The book is one SQLite database, with money held as integer cents. <!-- src: lib/db.mjs:1-4 -->
- The Redbark client only reads, and its key is never logged or sent off the API host. <!-- src: lib/redbark.mjs:1-4 -->
- The Redbark poll runs every 30 minutes. <!-- src: lib/schedule.mjs:7 -->
- The demo needs no bank account, no key and no existing data: it runs a fake Redbark over invented data in a temp directory. <!-- src: scripts/demo-seed.mjs:1-4 -->
- CSV import has invented fixtures for the CommBank, ANZ, NAB, Westpac, ING and Macquarie layouts. <!-- src: test/fixtures/csv/commbank-split.csv, test/fixtures/csv/anz-split.csv, test/fixtures/csv/nab.csv, test/fixtures/csv/westpac.csv, test/fixtures/csv/ing.csv, test/fixtures/csv/macquarie.csv -->
- Licensed under the GNU AGPL version 3. <!-- src: LICENSE:1-2 -->

## Deploy

- Out of the box it listens on loopback only. <!-- src: .env.example:20-21 -->
- Docker Compose publishes both the demo and the real service on the host's loopback. <!-- src: docker-compose.yml:19, docker-compose.yml:31 -->
- CI runs the tests and the secret scan. <!-- src: .github/workflows/ci.yml:30, .github/workflows/ci.yml:32 -->
- Security reports go through GitHub private vulnerability reporting, not a public issue. <!-- src: SECURITY.md:5-9 -->

## Generated facts

<!-- auto:start -->
- no collectors matched this repo
<!-- auto:end -->

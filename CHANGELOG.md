# Changelog

All notable changes to Mint are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) once Mint leaves 0.x: until then, read the entry before you upgrade.

## [Unreleased]

## [0.3.0] - 2026-11-03

Mint works for someone with no bank feed and no login proxy.

### Added
- Local mode: `docker compose --profile local up -d local` (or `node scripts/local.mjs`) runs your own book on this machine at <http://127.0.0.1:8981/> with no login proxy. A small front adds the gateway headers and only answers requests addressed to `127.0.0.1` or `localhost`. The book stays in the `mint-data` volume, and moving to a login proxy later keeps it.
- Pay found from CSV statements. A book with no bank feed now finds its salary from the same payer, a steady amount and a weekly, fortnightly or monthly rhythm, so pay cycles, cycle budgets, safe to spend and starter budgets appear after an import. Before this a CSV book only got them by adding a stream by hand. A book that has already found its pay, or has streams of its own, is left alone.
- A container image, `ghcr.io/kd-011/mint`, for amd64 and arm64, published by `.github/workflows/release.yml` when `CHANGELOG.md` gains a version. `docker-compose.yml` pulls it and builds from source if it cannot.

### Changed
- The README is short. Features, the comparison, the FAQ, configuration and backups moved to `docs/`.
- The tax estimate and the accountant pack say general information, not tax advice, and name the ATO or a registered tax agent.
- The demo prints two lines, shows a loading page until its data is in, and takes writes from `localhost` as well as `127.0.0.1`.
- `@capacitor/android`, `cli` and `core` move to 8.5.3 in the Android shell.

### Fixed
- Adding an AUD account no longer needs Frankfurter to be reachable.
- Merchant names from a CSV statement drop the `Card xx1234` and `Value Date:` tails.
- The Accounts side pane shows the new total after you add an account, and no longer says "Synced never" on a book with no feed.
- The lock cover no longer flashes the gateway line while it is only checking.

## [0.2.0] - 2026-11-03

### Added
- Timezone support. `MINT_TZ` takes any IANA zone name (default `Australia/Perth`, so an install that sets nothing behaves as before). Days, pay cycles, the financial year, the nightly reconcile, alert dates and exported dates all follow it, and the browser formats dates in the same zone. A misspelt name stops Mint at start with a message that names the variable. See [Timezone](docs/self-hosting.md#timezone).
- A first-class path without Redbark. With `REDBARK_API_KEY` unset there is no poll, no nightly job and no Redbark wording in the app. A fresh book offers "Add an account and import a CSV" on its first screen.
- CSV statement import ([docs/csv-import.md](docs/csv-import.md)): delimiter, header row, signed or debit/credit amounts, date order and encoding are detected and shown in a preview before anything is saved. Layouts for CommBank, ANZ, NAB, Westpac, ING and Macquarie are tested against invented fixtures. Re-importing the same rows adds nothing, and an import is one undoable step.
- Manual accounts in any currency, with a balance adjustment offered when a statement's closing balance differs from Mint's.
- `scripts/export-public.mjs` updates a persistent public checkout with one new commit on top instead of writing a fresh single-commit repo each time. `--fresh` keeps the old behaviour. See [docs/maintainers.md](docs/maintainers.md).
- The export now stops on any new or changed image or binary outside `scripts/export-allowlist.txt`, exiting 3 with the paths listed, and refuses to run without a denylist. The secret scan reads text and cannot see inside a picture.
- A weekly upkeep job checks the links in the docs and the claims in `dossiers/mint.md`, and keeps one labelled issue per problem.

### Changed
- CI also runs once a week. Dependabot is weekly, with grouped minor and patch updates and a 7 day cooldown. `actions/checkout` and `actions/setup-node` move to v7.
- The demo (`node scripts/demo-seed.mjs`) is richer: a year of invented transactions, a home loan with a repayment plan, goals, shares, subscriptions and a manual account, with balances on every account. The README banner, hero, demo GIF and screenshots are regenerated from it, and contain no real data.
- README: the known limits, FAQ and setup now describe `MINT_TZ` and the no-Redbark path.

## [0.1.0] - 2026-11-01

First public release.

- Pay-cycle budgets found from salary deposits, with rollover, and a "safe to spend until payday" figure.
- A pay split plan with a check that each payday's transfers happened.
- Bank feeds through Redbark (CDR): backfill, a 30 minute poll, a nightly reconcile and webhooks.
- Net worth across cash, cards, loans, shares, property and super; live ASX and US share prices; a home loan and offset view; savings goals.
- Search, saved views, merchant rules and an optional model pass for merchants it cannot place.
- Subscriptions and bills detected from history, with price rise and unusual charge alerts.
- ATO deduction tags, receipt photos, a financial year export, an accountant pack and a return estimate.
- A progressive web app with offline reads and queued edits, a passkey lock, encrypted off-box backups with a restore test, and an optional Android shell.
- Zero npm dependencies, Node 22, one SQLite file. AGPL-3.0.

[Unreleased]: https://github.com/kd-011/mint/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/kd-011/mint/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kd-011/mint/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kd-011/mint/releases/tag/v0.1.0

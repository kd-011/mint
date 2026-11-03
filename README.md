<p align="center">
  <img src="docs/banner.png" alt="Mint: self-hosted personal finance for Australians" width="100%">
</p>

<p align="center">
  <b>Pay-cycle budgets, CDR bank feeds and ATO tax tagging, in one SQLite file you own.</b><br>
  No cloud, no account, no npm dependencies, no build step.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-3ddc97?labelColor=0b0d0c"></a>
  <img alt="Node 22+" src="https://img.shields.io/badge/node-22%2B-3ddc97?labelColor=0b0d0c">
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-3ddc97?labelColor=0b0d0c">
  <a href="https://github.com/kd-011/mint/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/kd-011/mint/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Self-hosted" src="https://img.shields.io/badge/platform-self--hosted-3ddc97?labelColor=0b0d0c">
</p>

<p align="center">
  <img src="docs/hero.png" alt="Mint on a phone and on a desktop, showing net worth, the pay split plan and a transaction search" width="100%">
</p>

<p align="center">
  <img src="docs/demo.gif" alt="A short tour: net worth on Home, a search for Woolworths, the pay split plan, a savings goal" width="270">
</p>

Every figure and name in these images comes from the made-up demo data in `scripts/demo-seed.mjs`. No real account was used.

Status: early. Mint has one user so far, its author, and runs their own finances. It works, but expect rough edges and read the diff before you upgrade. See [CHANGELOG.md](CHANGELOG.md) and the [known limits](#roadmap-and-known-limits).

## Why Mint

Most budgeting apps assume a US bank, a calendar month and someone else's server. Mint is built around how an Australian actually gets paid and taxed:

- Mint can read Australian banks. Live bank feeds come through [Redbark](https://redbark.com), a commercial aggregator that uses the Consumer Data Right (CDR), and Mint keeps its own full copy of the history. Redbark is paid and optional. You can add accounts by hand and import the CSV statement your bank gives you (CommBank, ANZ, NAB, Westpac, ING and Macquarie layouts are tested) and everything else works the same. See [docs/csv-import.md](docs/csv-import.md).
- Budgets follow your pay. A cycle runs from one salary deposit to the day before the next. Mint finds your salary, learns the rhythm and predicts the next payday.
- Safe to spend is the one number. It is expected pay, less your savings split and fixed bills, less what you have spent so far, divided by the days left until payday.
- Tag a transaction as an ATO deduction, attach a receipt photo, and export a financial year summary or an accountant pack.
- Your data is one SQLite database and a folder of receipts, on a machine you control. One script backs it up.

Mint never moves money. It plans, checks and nudges, and its Redbark client only reads.

## Try it in 30 seconds

You need Node 22 or newer. There is nothing to install.

```sh
git clone https://github.com/kd-011/mint.git
cd mint
node scripts/demo-seed.mjs
```

Open <http://127.0.0.1:8980/>. This starts a fake Redbark, a throwaway database and the real server, loads a year of invented transactions, budgets, goals, shares, a manual account and a home loan, and deletes it all when you press Ctrl-C. No Redbark key needed.

With Docker instead:

```sh
docker compose up
```

Then open <http://127.0.0.1:8980/> (use `127.0.0.1`, not `localhost`). Details, and how to run your own book in a container, are in [docs/self-hosting.md](docs/self-hosting.md).

## What it does

### Money plan

- Pay cycles and per-cycle budgets with rollover, found from your salary deposits
- Safe to spend until payday, with a cash check against bills still due
- A pay split plan (what each payday should send where) and a check that it happened
- Savings goals with a monthly pace, and a view of debt, offset and a home loan

<p>
  <img src="docs/screenshots/m-plan.png" alt="The pay split plan on a phone" width="190">
  <img src="docs/screenshots/m-save.png" alt="Savings goals on a phone" width="190">
  <img src="docs/screenshots/m-subs.png" alt="Subscriptions on a phone" width="190">
  <img src="docs/screenshots/m-reports.png" alt="Reports on a phone" width="190">
</p>

### Banks and balances

- Every account Redbark can see, plus accounts it cannot, entered by hand in any currency with CSV statement import (which works on its own, with no Redbark at all)
- Net worth across cash, cards, loans, shares, property and super; live ASX and US share prices
- Transfers between your own accounts are matched so they do not count as spending, and card and loan repayments are recognised
- Wise balances (optional)

### Spending

- Search across everything, saved views, filters, merchant rules and an optional model pass for merchants it cannot place
- Subscriptions and bills detected from the history, with price rise and unusual charge alerts
- A "what changed this pay cycle" digest

### Tax

- ATO deduction tags, business spend, receipt photos, financial year export and an accountant pack
- Income checked against your Notices of Assessment, and a return estimate. It is bookkeeping, and nothing in it is advice.

### Running it

- A progressive web app: install it to your phone, works offline for reads, queues edits
- A passkey fingerprint lock on top of your own login gateway
- Encrypted off-box backups with a restore test
- An optional Android shell (`android-shell/`) you build and sign yourself

## How it fits together

```mermaid
flowchart LR
  bank[Your banks] -->|CDR consent| rb[Redbark]
  rb -->|HTTPS, read only| mint
  subgraph box [Your machine]
    mint["Mint<br/>node:http + node:sqlite"] --> db[("mint.db")]
    mint --> rec[receipts/]
  end
  proxy["Your login proxy<br/>Caddy + Authelia, Tailscale, ..."] --> mint
  phone[Phone or browser] --> proxy
```

One Node process serves the API and a plain JavaScript single page app. It polls Redbark every 30 minutes and reconciles nightly. There is no queue, no cache server and no second database.

## Mint compared with other budgeting apps

All three are good software with larger communities than Mint. The table lists only differences I could check against each project's own docs and issue tracker on 2026-11-01. "Not documented" means I did not find it on the pages linked. It may still exist.

| | Mint | Actual Budget | Firefly III | Lunch Money |
| --- | --- | --- | --- | --- |
| Where it runs | Your machine | Your machine ([docs](https://actualbudget.org/docs/install/)) | Your machine ([repo](https://github.com/firefly-iii/firefly-iii)) | Hosted subscription; no self-hosting documented |
| Licence | AGPL-3.0 | MIT | AGPL-3.0 | Not stated on the pages I read |
| Stack to run | Node 22, nothing else | Node or Docker | PHP and Laravel, plus a database | Not applicable |
| Australian CDR bank feed | Yes, through Redbark (paid) | Not in its [bank sync docs](https://actualbudget.org/docs/advanced/bank-sync/) (Redbark [documents a SimpleFIN route](https://redbark.com/docs/actual-budget.md)) | Not in its importer docs (Redbark [documents a SimpleFIN route](https://redbark.com/docs/firefly-iii.md)) | Not implemented, per a [staff reply](https://feedback.lunchmoney.app/institution-status-requests/p/bank-import-australia) in June 2026 |
| Budget periods that follow pay | Yes, found from your salary | Monthly in its [budgeting docs](https://actualbudget.org/docs/budgeting/) | No: the maintainer [says custom cycles will not happen](https://github.com/firefly-iii/firefly-iii/discussions/8902) | Yes, a [custom period](https://support.lunchmoney.app/guides/budgeting/step-2-setting-up-your-budget) from a start date |
| ATO tax tags and accountant pack | Yes | Not documented | Not documented | Not documented |

What the others do that Mint does not: more than one user, many countries, mature envelope budgeting (Actual), double-entry accounting (Firefly III), a hosted service nobody has to run (Lunch Money), and years of other people's bug reports.

## Setup for your own book

Mint needs a reverse proxy that logs you in, and one of two ways to get your transactions in. The guides go step by step:

- [docs/self-hosting.md](docs/self-hosting.md): the login gateway, Caddy with Authelia, Tailscale, Cloudflare, Docker, systemd
- Without Redbark: [docs/csv-import.md](docs/csv-import.md). Leave `REDBARK_API_KEY` unset, add an account by hand on the first screen and import a CSV statement from your bank's website. Nothing is polled and the app shows no Redbark messages. You lose automatic updates. Budgets, pay cycles, search, tax tags and net worth all still work.
- With Redbark: [docs/redbark-setup.md](docs/redbark-setup.md) covers getting an API key (a paid plan) and connecting your banks.

The short version:

```sh
cp .env.example .env
chmod 600 .env
# fill in MINT_GATE_KEY (openssl rand -hex 32), MINT_USER and MINT_ORIGIN,
# and REDBARK_API_KEY if you have one; MINT_TZ if you are not on Perth time
node server.mjs
```

Mint listens on `127.0.0.1:8970` only. With a Redbark key, the first start backfills each account (up to about seven years where the bank allows), then polls every 30 minutes with a full reconcile at 02:40 in your timezone. It will not answer anyone who does not arrive through your login gateway, so read the self-hosting page before you open it in a browser.

### Configuration

Everything is an environment variable, read from `.env` next to `server.mjs` or from the real environment. `.env.example` lists every one with a comment. The ones you will touch:

| Variable | What it does |
| --- | --- |
| `REDBARK_API_KEY` | Optional. Your Redbark key. Unset, there is no bank feed: manual accounts and CSV import only. |
| `MINT_GATE_KEY` | Required. Shared secret your proxy sends as `X-Mint-Gate` (32+ characters). |
| `MINT_TZ` | Your timezone as an IANA name, for example `Australia/Sydney`. Default `Australia/Perth`. See [Timezone](docs/self-hosting.md#timezone). |
| `MINT_USER` | Login name your proxy sends as `Remote-User`. Default `owner`. |
| `MINT_ORIGIN` | The https origin you serve Mint from. Default `http://localhost:<port>`. |
| `MINT_PORT` | Listen port on 127.0.0.1. Default 8970. |
| `MINT_HOME` | Folder for `data/`, `backups/` and `.env`. Default: the code folder. |
| `MINT_LOCK` | `off` disables the fingerprint lock, until a fingerprint is enrolled. |
| `OPENROUTER_API_KEY` | Optional. Lets a model categorise merchants Mint cannot place. See the FAQ for what is sent. |
| `WISE_API_TOKEN`, `ALPHAVANTAGE_API_KEY` | Optional. Wise balances, US share prices. |
| `MINT_BACKUP_*` | Optional. Encrypted off-box backups. |

### Backup and restore

Your data is `data/mint.db` plus `data/receipts/`.

- `node scripts/backup.mjs` writes a consistent snapshot to `backups/mint-<date>.db` and keeps the newest 14. Run it daily from cron or a systemd timer.
- Set `MINT_BACKUP_HOST` (an ssh host from `~/.ssh/config`) and `MINT_BACKUP_AGE_RECIPIENT` (an [age](https://age-encryption.org) public key) and the same script also copies a gzipped, age-encrypted snapshot and an encrypted receipts mirror there. Keep the private key off the same disk.
- `node scripts/restore-test.mjs` pulls the newest off-box copy, decrypts it, checks integrity and compares row counts.
- To restore: stop Mint, copy a snapshot over `data/mint.db`, delete any `mint.db-wal` and `mint.db-shm` beside it, start Mint. If you lose your phone or passkey, `node scripts/lock-reset.mjs --yes` clears the enrolled fingerprints.

## Security

- Mint is single user: one owner, no roles. Do not share it.
- It holds your bank data, so treat the machine, `data/` and every backup as sensitive.
- It has two locks. Your gateway headers (`Remote-User` and the `X-Mint-Gate` secret) are the first and the passkey is the second. Never expose port 8970 directly.
- Secrets live in `.env` (mode 600, never committed). `scripts/secret-scan.mjs` and CI keep keys and personal data out of the repository.
- Found a vulnerability? Use a private advisory, see [SECURITY.md](SECURITY.md). Never post real data in an issue.

## FAQ

### Is it safe to point at my bank data?

It is as safe as the machine and the login in front of it. Mint binds to loopback, refuses requests that did not come through your gateway, and adds a passkey lock. It has no accounts, no telemetry and no callbacks to its author. It is young software: read [SECURITY.md](SECURITY.md) and decide.

### Where does my data go?

Your transactions go from your banks to Redbark to your machine, and stay there. Mint's own outbound calls are: Redbark (the bank feed); merchant icons, fetched by the server from Google or DuckDuckGo by website domain only (no amounts, no account data); Frankfurter for exchange rates and Yahoo or Alpha Vantage for share prices, if you hold foreign currency or shares; and OpenRouter and Wise, only if you set their keys. The browser only talks to your own Mint (a strict content security policy enforces it). Setting `MINT_SCHEDULER=off` stops the scheduled bank polling and the background icon and price fetches.

### What does the AI categoriser send?

Nothing unless you set `OPENROUTER_API_KEY`. With a key, unknown merchants are sent for one batched question: the merchant name and bank description, with digit runs, card masks and dollar amounts stripped first (`scrubForModel` in `lib/categorise.mjs`). Never balances, account numbers or full histories. A daily cap applies. The same key is used to ask for a merchant's website when the built-in map has none.

### Does it move money?

No. The Redbark client only reads. Mint checks whether the transfers you made match your plan; it cannot make them.

### Does it work outside Australia?

The bank feed is Australian (CDR). On manual accounts and CSV imports it runs anywhere, in any currency, and day boundaries, pay cycles and schedules follow whatever IANA zone you set in `MINT_TZ` (default `Australia/Perth`, so a plain install behaves as it always did). The tax parts are ATO only, and the financial year starts on 1 July.

### Do I need Redbark?

No. Without it you add accounts by hand and import CSV statements, see [docs/csv-import.md](docs/csv-import.md). The CSV column layouts for the big banks are the ones widely reported for each, not confirmed by the banks, and Mint shows you what it read before it saves anything.

### Is Redbark free?

No. It is a separate commercial service with its own terms. At the time of writing, API access needs a paid plan after a short trial; see [docs/redbark-setup.md](docs/redbark-setup.md) for what was verified and when. Mint has no financial interest in it.

## Roadmap and known limits

Roughly in order of how much each matters:

- One timezone per install. Set `MINT_TZ` before the first sync. Changing it later leaves old dates alone and changes how new days are bucketed.
- Single user. One person, one book. There are no shared budgets or roles and none are planned.
- Live bank feeds need Redbark, a paid third party. Without it you import CSV statements by hand, and there is no automatic update.
- CSV layouts are unconfirmed. The banks do not publish theirs, so the tested shapes come from what is widely reported. Mint shows its column choices before it imports.
- CDR consent lapses after 12 months and has to be renewed inside Redbark. Mint warns you before it does.
- No store listing for the Android app. You build and sign the shell yourself.
- Young code. It runs the maintainer's own finances, but few other people have used it. Expect rough edges and read the diff before upgrading.

Not planned: moving money, budgets shared between people, a hosted version.

## Tests

```sh
node --check *.mjs lib/*.mjs && node --test test/
node scripts/secret-scan.mjs . --tracked
```

Tests run against a fake Redbark over invented fixtures (`test/fixtures/`) and need no network. [docs/reference.md](docs/reference.md) holds the engineering notes: the engine, every API route and the design system. [docs/README.md](docs/README.md) is the index of everything under `docs/`.

## Contributing

Small, focused changes are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md): sign off your commits (DCO, `git commit -s`), there is no CLA, and never put real financial data in a test, an issue or a screenshot. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Not financial or tax advice

Mint is a bookkeeping tool. Its budgets, forecasts, tax tags and tax estimates are arithmetic over the data you give it and may be wrong or out of date. Nothing in it is financial, tax, legal or accounting advice. Check figures against your bank, the ATO and a registered tax agent before you rely on them. The software comes with no warranty (see the licence).

## Licence

Copyright (C) 2026 kd-011 and Mint contributors.

Mint is free software under the GNU Affero General Public License, version 3 (AGPL-3.0). See [LICENSE](LICENSE). If you run a modified Mint for other people over a network, the AGPL requires you to offer them your source. Third-party components and their licences are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

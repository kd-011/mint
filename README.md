# Mint

Mint is a budgeting app for Australians that runs on your own machine. Budgets run from one payday to the next, and your data sits in one SQLite file you can copy.

<p align="center">
  <img src="docs/hero.png" alt="Mint on a phone and on a desktop, showing net worth, the pay split plan and a transaction search" width="100%">
</p>

Everything in that picture is made-up demo data, shot by `scripts/gen-assets.mjs`.

## Try it

You need Docker. This starts a demo with a year of invented transactions, budgets, goals, shares and a home loan:

```sh
git clone https://github.com/kd-011/mint.git && cd mint && docker compose up
```

Open <http://127.0.0.1:8980/> when it prints `ready`. A first run from a clean clone took 46 seconds here. Ctrl-C stops it, and nothing is kept.

With Node 22 and no Docker, run `node scripts/demo-seed.mjs` instead.

## Use it on your own money

```sh
MINT_TZ=Australia/Sydney docker compose --profile local up -d local
```

Open <http://127.0.0.1:8981/>, add an account and import a CSV statement from your bank's website. Mint finds your pay in the statement and builds the pay cycles and starter budgets from it. There is no signup and no login proxy, and only this machine can open it. The book stays in a Docker volume. Set `MINT_TZ` to your own zone before the first import.

Live bank feeds are optional and they cost money. They come through [Redbark](https://redbark.com), a commercial service that uses the Consumer Data Right, and I have no financial interest in it. Without Redbark you import a statement when you want the new days, and the rest of the app works the same. See [docs/csv-import.md](docs/csv-import.md) and [docs/redbark-setup.md](docs/redbark-setup.md).

To use it from your phone, put a login proxy in front of it: [docs/self-hosting.md](docs/self-hosting.md) has recipes for Caddy with Authelia, Tailscale and Cloudflare. The same book moves across.

## What you get

Your budget period starts when your salary lands, weekly, fortnightly or monthly, and Mint predicts the next payday. Safe to spend, beside every screen on a wide window, is your expected pay less planned savings, fixed bills and what you have spent. A pay split plan says what each payday should send where, then checks that it happened.

For tax time, tag a transaction with its ATO deduction item, attach a receipt photo, and export a financial year CSV or an accountant pack. The return estimate uses the ATO's published tables and links to them. It is general information, so check anything you rely on with the ATO or a registered tax agent.

Mint never moves money: its bank client only reads. It has no telemetry. [docs/features.md](docs/features.md) has the rest, with pictures, and [docs/faq.md](docs/faq.md) lists every outbound call it makes.

## When not to use it

- You share your money with someone. Mint is single user and that will not change.
- You want nothing to run. PocketSmith is hosted and [says it has Australian feeds](https://www.pocketsmith.com/global-personal-finance-software/australia/).
- You want a live bank feed for free. I don't know of a way to get one here, and Mint does not have one.
- You want mature envelope budgeting (Actual Budget) or double-entry accounts (Firefly III), and calendar months suit you. [docs/comparison.md](docs/comparison.md) has the detail, with sources.
- You are outside Australia. Budgets work in any currency and timezone, but the tax parts are ATO only.
- You want software with a track record. Mint has one user so far, me, and I started it in October 2026. Back it up and read the [changelog](CHANGELOG.md) before you upgrade.

## Everything else

[Configuration and backups](docs/self-hosting.md#configuration), [security](docs/faq.md#security), [known limits](docs/faq.md#known-limits), [engineering notes](docs/reference.md), [contributing](CONTRIBUTING.md).

The tests need no network: `node --test test/`. [CI](https://github.com/kd-011/mint/actions/workflows/ci.yml) runs them on every push, along with a scan that keeps secrets and personal data out of the repository.

Mint is a bookkeeping tool. Its figures are arithmetic over the data you give it and may be wrong or out of date. Nothing in it is financial, tax, legal or accounting advice, and it comes with no warranty.

Copyright (C) 2026 kd-011 and Mint contributors. Free software under the [AGPL-3.0](LICENSE): if you run a modified Mint for other people over a network, you have to offer them your source. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

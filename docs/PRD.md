---
slug: mint-prd
name: Mint PRD
repo: .
status: active
last_verified: 2026-11-22
---

# Mint: product requirements

## Purpose

Mint is a budgeting app for Australians that runs on the owner's own machine. Budgets run from one payday to the next instead of by calendar month, and the whole book sits in one SQLite file the owner can copy. It exists because bank feeds hold no history of their own, so something has to keep the complete copy, and because a pay-cycle plan (safe to spend, a pay split, goals, debt) needs that copy to be trustworthy.

## Audience

One person, the owner of the install, and no one else: Mint is single user with no roles and that will not change. They reach it from a phone (installed PWA or the optional Android shell) or a desktop browser, through their own login gateway, or on one machine in local mode with no gateway. The tax parts are Australian only; budgets work in any currency and timezone.

## Features

- **[shipped]** Pay cycles found from salary deposits, with a predicted next payday, and budgets per cycle with rollover, fixed and flexible budgets and starter budgets from history. <!-- src: lib/cycles.mjs:1-6, lib/budgets.mjs:1-8, lib/budgets.mjs:273 -->
- **[shipped]** Safe to spend until payday and per day, with the working and a cash check against bills still due. <!-- src: lib/safe.mjs:1-10 -->
- **[shipped]** A pay split plan (what each payday should send where) and a check that it happened, plus savings goals with a per-cycle pace. Mint never moves money. <!-- src: lib/plan.mjs:1-7, lib/goals.mjs:1-4 -->
- **[shipped]** Debt and offset: home loan interest with and without the offset, payoff and the effect of an extra amount, and card paydown. <!-- src: lib/debt.mjs:1-6, lib/homeloan.mjs:1-7 -->
- **[shipped]** A cashflow forecast to the next payday and out to 30 days, served by the API and read by the assistant. <!-- src: lib/forecast.mjs:1-4, lib/api.mjs:652 -->
- **[shipped]** An optional live bank feed through Redbark: every account and its full history, polled every 30 minutes, reconciled nightly, and refreshed by a signed webhook. <!-- src: lib/redbark.mjs:1-4, lib/schedule.mjs:6-14, lib/webhook.mjs:1-8 -->
- **[shipped]** Mint without Redbark: manual accounts in any currency, CSV statement import with a column mapper that previews before it writes, and pay found from the statement rows. <!-- src: lib/manual.mjs:1-4, lib/csvimport.mjs:10-14, server.mjs:55-57, lib/income.mjs:324-361 -->
- **[partial]** CSV layouts for six banks are tested against invented fixtures only. The banks do not publish their layouts, so the mapper is the fallback. <!-- src: test/fixtures/csv/nab.csv, docs/faq.md:46 -->
- **[shipped]** Optional Wise balances and statements, read only. <!-- src: lib/wise.mjs:1-9, lib/wisesync.mjs:1-9 -->
- **[shipped]** Net worth across accounts, hand-entered shares and ETFs with live ASX and US prices, super snapshots and other manual assets. <!-- src: lib/networth.mjs:1-6, lib/holdings.mjs:1-4, lib/quotes.mjs:1-14, lib/superfund.mjs:1-5 -->
- **[shipped]** Categorising by manual pick, then rules, then an optional model pass for merchants it cannot place, then the provider category. Only scrubbed merchant text is sent. <!-- src: lib/categorise.mjs:1-4, lib/categorise.mjs:222-250 -->
- **[shipped]** Transfers between the owner's own accounts matched so they do not count as spend, with a review queue for doubtful pairs. <!-- src: lib/transfers.mjs:1-5, lib/spend.mjs:1-12 -->
- **[shipped]** Subscriptions and bills detected from history, a bills calendar, price-rise and unusual-charge alerts, and a "what changed this pay cycle" digest. <!-- src: lib/recurring.mjs:1-5, lib/bills.mjs:1-5, lib/unusual.mjs:1-5, lib/alerts.mjs:1-10, lib/insights.mjs:1-4 -->
- **[shipped]** Search across transactions, categories, accounts and budgets, saved filter views, merchant rules and merchant logos. <!-- src: lib/search.mjs:1-4, lib/views.mjs:1-5, lib/logos.mjs:1-4 -->
- **[shipped]** Tax: ATO deduction tags, business spend, receipt uploads, financial year export, an accountant pack, income checked against Notices of Assessment, and a return estimate for a single resident individual. General information only. <!-- src: lib/tax.mjs:1-5, lib/pack.mjs:1-6, lib/noa.mjs:1-8, lib/taxestimate.mjs:1-10, lib/taxrates.mjs:1-12 -->
- **[shipped]** The Ledger: a standalone record of money other people owe the owner and the reverse. <!-- src: lib/owed.mjs:1-8 -->
- **[shipped]** Reports of monthly income and spend, spend by category and top merchants. <!-- src: lib/reports.mjs:1-5 -->
- **[shipped]** A PWA that opens offline, caches reads, and queues edits to flush in order when the connection returns. <!-- src: public/sw.js:1-5, public/core.js:368-376 -->
- **[shipped]** A passkey fingerprint lock on top of the owner's login gateway. <!-- src: lib/lock.mjs:1-3, server.mjs:1-8 -->
- **[shipped]** An assistant door for an outside assistant (reads, undoable safe writes, confirm-held bigger ones) and an optional in-app chat that appears only when its key is set. <!-- src: lib/assistant.mjs:1-8, lib/chatwrites.mjs:1-13, lib/chatproxy.mjs:1-5, server.mjs:239-246 -->
- **[shipped]** A demo over invented data, local mode for one machine, a container image, encrypted off-box backups with a restore test, and an optional Android shell the owner builds and signs. <!-- src: scripts/demo-seed.mjs:1-4, scripts/local.mjs:1-9, Dockerfile:1-3, scripts/backup.mjs:1-10, android-shell/README.md:3 -->
- **[shipped]** Demo mode on the device: one random factor scales every dollar and account numbers are masked, so the phone can be shown round. <!-- src: public/demo-math.js:1-8 -->

## Non-goals

- Moving money. The bank client is read only and Mint only checks that the owner's own transfers match their plan. <!-- src: docs/faq.md:15-17, lib/redbark.mjs:1-2 -->
- Budgets shared between people, roles, or a hosted version. <!-- src: docs/faq.md:51 -->
- GST and anything beyond an individual's ATO return. The owner is not GST registered and the estimate covers a single resident individual only. <!-- src: lib/tax.mjs:3-5, lib/taxrates.mjs:9-12 -->
- Telemetry and any outbound call beyond the services listed in architecture. <!-- src: README.md:41, docs/faq.md:7-9 -->

## Unverified

- Planned work. No roadmap doc exists in `docs/`, so nothing is marked planned here. Open items live in the project dossier.
- Real-world fit of the CSV layouts and of live Redbark data against the bank accounts it was built on, which only the owner's live book exercises.

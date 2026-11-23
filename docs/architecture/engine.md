---
slug: mint-architecture-engine
name: Mint architecture, engine
repo: .
status: active
last_verified: 2026-11-22
---

# Engine: categorising, transfers, recurring and alerts

The engine turns raw bank rows into spend, income and alerts. It runs once at startup and after every sync, and is pure SQL and arithmetic over the book. See ../ARCHITECTURE.md for the overall map.

## Run order

- `refresh()` runs, in order: seed categories and loan and merchant rules, apply rules and the provider fallback, match transfers, the money pass (income streams, starter budgets, the pay split, goals, the home loan budget), then alerts. Transfers are matched before the model sees anything, so the model never sees transfers. <!-- src: lib/engine.mjs:1-6, lib/engine.mjs:46-77 -->
- The model pass and merchant logos run after, in the background, one at a time each, and never throw into a sync. When the model categorised anything, income and alerts run again. <!-- src: lib/engine.mjs:79-111 -->
- Starter budgets are generated once, only into an empty budgets table and only after two pay cycles have closed. After that the owner's edits and deletes stand. <!-- src: lib/engine.mjs:36-44 -->

## Categorising

- Precedence per transaction: the owner's manual pick, then the first matching rule (lowest priority number, newest on a tie), then the model's cached answer for the merchant, then Redbark's `provider_category` mapped onto Mint's categories. Rules run on ingest and re-run over history whenever a rule changes. <!-- src: lib/categorise.mjs:1-4 -->
- A rule matches the description or the derived merchant by `contains`, `starts`, `exact` or `regex`, optionally limited to an account and an amount range. <!-- src: lib/categorise.mjs:12-29 -->
- The display merchant is derived from the description (card, EFTPOS and facilitator prefixes, reference numbers and instalment tails dropped), because Redbark's `merchant_name` is often empty. Stored merchants are re-derived once when the derivation version changes. <!-- src: lib/merchant.mjs:1-6, lib/engine.mjs:20-34 -->
- The model pass sends only the merchant and description, scrubbed of account numbers, card masks, amounts and long references, one question per merchant ever, in batches of 40, inside a daily cap (`MINT_AI_DAILY_CAP`) with token use recorded per day and a two hour backoff after a failed call. A manual run ignores the backoff. <!-- src: lib/categorise.mjs:222-250, lib/categorise.mjs:300-304, server.mjs:150-156 -->
- Unset `OPENROUTER_API_KEY` means no model pass: unknown merchants stay on the provider category until a rule or a manual pick. <!-- src: .env.example:48-52 -->

## Transfers and what counts as spend

- Redbark has no transfer flag. Money out of one account is paired with the same amount into another within four days, scored with `provider_category` as a hint (`TRANSFER_IN`, `TRANSFER_OUT`, `LOAN_PAYMENTS` are strong, other categories are a conflict). A score of 80 or more with no rival pairing links automatically; a score from 35 goes to a review queue. <!-- src: lib/transfers.mjs:1-18, lib/transfers.mjs:91, lib/transfers.mjs:108 -->
- Both legs carrying the same bank reference token count as strongly as a transfer flag, and the owner's own name on a transfer-worded credit is a transfer whatever the bank filed it as. <!-- src: lib/transfers.mjs:20-28 -->
- A linked pair, and a row in a transfer-kind category, never counts as spend or income (`COUNTS`). Budgets, Reports and the assistant's spend reads use `SPEND_*`, which also count a repayment into a home loan once, under `Home loan`. <!-- src: lib/spend.mjs:1-12, lib/spend.mjs:22-51 -->

## Recurring, unusual and alerts

- Subscriptions and bills are detected as the same merchant charging a steady amount on a steady cadence, walking back from the latest charge while gaps fit one cadence. Detection is conservative; a merchant mostly filed under Subscriptions gets a looser second test. <!-- src: lib/recurring.mjs:1-14 -->
- The Subscriptions list merges detected subscriptions with hand-added ones and keeps a state for each (active, cancelled, stopped, not a subscription). Cancelled and dismissed ones drop out of the bills calendar, the forecast and the new-subscription alerts. <!-- src: lib/subscriptions.mjs:1-8 -->
- Unusual charges look at settled charges in the last 14 days only: a never-seen merchant at $200 or more, or a charge at least three times the merchant's usual, $100 over it and a quarter above its biggest, once it has five charges of history. <!-- src: lib/unusual.mjs:1-5, lib/unusual.mjs:9 -->
- Alerts are of kinds `unusual`, `subscription`, `sync`, `budget` and `pace`, which are queued for push to the assistant, plus an in-app-only `payday`. A unique `(kind, key, period)` row dedupes them: budget and pace once per pay cycle, a sync failure once per incident, a payday once per salary deposit. <!-- src: lib/alerts.mjs:1-10, lib/alerts.mjs:22 -->

## Merchant logos

- A merchant resolves to a website domain once: a built-in map, a domain in its own name, then one batched model question. The icon is fetched server side from Google s2, DuckDuckGo or gstatic, checked by size and dimensions, capped at 200 KB, and cached in the book. A miss retries after 30 days, an error after six hours. <!-- src: lib/logos.mjs:1-4, lib/logos.mjs:14-24, lib/logos.mjs:295-304 -->
- The page only ever gets a hint and loads the image from `/api/logo/<key>`, so no third party sees a page view. The domain and the model's answer are treated as an SSRF surface: https only, nothing private. <!-- src: lib/logos.mjs:1-7, lib/api.mjs:373 -->
- Logo runs happen only in a process that polls: the server passes the logos object to the engine only when the scheduler is on. <!-- src: server.mjs:167-168 -->

## Unverified

- The size and contents of the built-in merchant map and the seeded AU merchant rules, which change with the data in `lib/categories.mjs` and `lib/logos.mjs`.

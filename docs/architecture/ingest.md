---
slug: mint-architecture-ingest
name: Mint architecture, ingest
repo: .
status: active
last_verified: 2026-11-22
---

# Ingest: Redbark, the webhook and the schedule

Redbark stores nothing, so ingest builds Mint's own complete copy of every account and transaction, and keeps it current. Everything here is optional: with no `REDBARK_API_KEY` the server runs with no bank feed. See ../ARCHITECTURE.md for the overall map.

## Client

- `lib/redbark.mjs` is read only against `https://api.redbark.com/v2`, pins the `2026-10-01.wattle` version header, follows token pagination, honours `Retry-After`, and keeps the key inside its closure so it is never logged, put in an error or sent off the API host. <!-- src: lib/redbark.mjs:1-9 -->
- It retries 429, 500, 502, 503 and 504, fails a call whose `Retry-After` exceeds two minutes instead of stalling a sync, runs up to three requests at once and paces itself on the rate-limit headers. <!-- src: lib/redbark.mjs:10-11, lib/redbark.mjs:38, lib/redbark.mjs:98-99 -->
- Transactions come in date windows under Redbark's 5,000-row ceiling. A truncated window is re-walked from the oldest date seen; a `from_too_old` error moves the start forward a week at a time. <!-- src: lib/redbark.mjs:150-186 -->

## Sync

- One sync runs at a time, in one of the kinds `poll`, `reconcile`, `snapshot` or `wise`. A request while one runs reports `already`. After a successful run (other than `snapshot`) the engine runs. <!-- src: lib/ingest.mjs:349-370 -->
- A sweep refreshes connections and accounts, reads balances (or takes the daily snapshot), then walks each account. An account never seen before is backfilled from seven years back plus a week; the rest are fetched over the kind's window. <!-- src: lib/ingest.mjs:219-258, lib/dates.mjs:98-103 -->
- Windows: a poll re-reads 21 days (pending rows can sit a fortnight before settling), a reconcile re-reads 120 days. <!-- src: lib/ingest.mjs:9-10 -->
- The scheduler ticks every minute. A poll is due 30 minutes after the last one; the nightly reconcile is due once per local day from 02:40 in the `MINT_TZ` zone, and on a day that skips that time it runs when the clock first passes it. <!-- src: lib/schedule.mjs:1-14, server.mjs:542-548, server.mjs:580-583 -->
- With no bank feed at all the tick returns early, `POST /api/sync` answers 409, and manual accounts and CSV import work as normal. <!-- src: server.mjs:449-452, server.mjs:542-548 -->

## Writing rows

- `upsertRows` inserts a transaction by its Redbark id and updates only the provider fields when they differ. Category, business flag and note are the owner's and are never touched by a sync. <!-- src: lib/ingest.mjs:15-16, lib/ingest.mjs:67-80 -->
- A pending row the bank stops returning is removed. If a posted row with the same amount sits within seven days of it, its manual category, business flag, note, receipts, owed payments and tax tag move onto that row first. <!-- src: lib/ingest.mjs:83-109 -->
- Each Redbark account is upserted on its own, so one the bank describes badly is logged and skipped. A missing name becomes `Unnamed account`. A bank-reported type is kept in `feed_type`; a `type_override` wins for `type`. <!-- src: lib/ingest.mjs:111-150, lib/accounts.mjs:1-4 -->
- Live balances land in today's snapshot row on every poll, and the daily snapshot adds rate and loan details, because Redbark keeps no balance history. <!-- src: lib/ingest.mjs:1-3, lib/ingest.mjs:165-218 -->
- Connection health reports consent expiry in days and warns inside 30 days. <!-- src: lib/ingest.mjs:11, lib/ingest.mjs:371-385 -->

## Re-linked accounts

- A bank re-linked as a second connection gives the same real account new Redbark ids. The sync only reports this; a person runs `scripts/merge-accounts.mjs` (dry run first) to fold the older row into the newer. Matches are on institution, masked number, currency and type across different connections, never the name. <!-- src: lib/ingest.mjs:278-282, lib/accountmerge.mjs:1-12 -->
- The retired row is never deleted: it is marked `merged_into` and `status gone`, its transactions move over, and a same-entry duplicate stays on it and is skipped by queries through `a.merged_into IS NULL` or `LIVE()`. `--undo` reverses a merge. <!-- src: lib/accountmerge.mjs:10-16, lib/live.mjs:1-6, scripts/merge-accounts.mjs:4-7 -->

## Webhook

- `POST /api/redbark/webhook` accepts two signing formats on one path: webhook destinations (`X-Redbark-Signature: sha256=`) and v2 event destinations (`Redbark-Signature: t=,v1=`). Both are HMAC-SHA256 over `<timestamp>.<raw body>`, compared in constant time before the body is parsed, with a five minute replay window. <!-- src: lib/webhook.mjs:1-16 -->
- It answers 503 until a secret is set. A delivery is deduplicated on its id and also on a hash of its signature, because the id header is not covered by the HMAC. <!-- src: lib/webhook.mjs:57, lib/webhook.mjs:82-88 -->
- A delivery inserts nothing. It queues an API sync of the named accounts, from three days before the earliest date it names. A connection event queues a connections refresh. <!-- src: lib/webhook.mjs:6-8, lib/webhook.mjs:92-112 -->
- Bad signatures count per IP: after 30 in ten minutes the route answers 429. <!-- src: server.mjs:269-286, server.mjs:413-420 -->

## Unverified

- Whether a live Redbark event or webhook destination is configured for the running instance. The code accepts both; whether the key in use may create one is not visible from the repo.

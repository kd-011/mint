---
slug: mint-architecture-manual-accounts
name: Mint architecture, manual accounts
repo: .
status: active
last_verified: 2026-11-22
---

# Manual accounts, CSV import, Wise and exchange rates

Accounts a bank feed cannot see, or installs with no feed at all, run on manual accounts. They sit in the same tables as bank accounts, so every screen and every engine rule reads them without knowing the difference. See ../ARCHITECTURE.md for the overall map.

## Manual accounts

- A manual account is kept by hand in any currency Frankfurter publishes, with a balance and transactions entered one at a time or imported from CSV. <!-- src: lib/manual.mjs:1-4 -->
- Existing columns keep meaning AUD cents. A manual row's `transactions.amount` is its AUD value at the rate for its date, with the native amount in `amount_native` and the rate in `fx_rate` and `fx_date`. An account's `balance_current` is its native balance at the latest rate, with the native figure in `balance_native`. Spend, budgets, income, tax, safe to spend and net worth therefore read AUD unchanged. <!-- src: lib/manual.mjs:6-13 -->
- The balance is the opening balance (as at the start of its date) plus every transaction from that date on. Each write rebuilds the account's daily snapshots so net worth history works. <!-- src: lib/manual.mjs:15-18 -->
- Redbark sync never touches manual accounts: ingest leaves them out of every Redbark call and out of the gone-marking. <!-- src: lib/manual.mjs:20-22 -->
- Manual account ids look like `man_` plus 16 hex digits, and the API accepts them wherever it accepts a Redbark id. <!-- src: server.mjs:441, lib/api.mjs:104 -->

## CSV import

- The file is untrusted text: decoded strictly (UTF-8, else Windows-1252, binary refused), capped at 2 MB and 20,000 rows, parsed by a small RFC 4180 parser, and stored as plain text, so a formula-looking cell stays text. <!-- src: lib/csvimport.mjs:3-8 -->
- `readStatement` finds the delimiter, the header row past any bank preamble, a column mapping (date, description, amount or debit and credit, optional balance and reference) and the date order, and parses every row or says why it cannot, by row number. The page shows the mapping before import, and remembers it per account. <!-- src: lib/csvimport.mjs:10-14, docs/csv-import.md:65 -->
- `runImport` writes the new rows in one transaction as one `manual_imports` row, so an import undoes as one. Re-importing is safe: each row's `import_hash` is account, date, amount, description (case and spacing ignored) and how many times that same row came before it in the file. <!-- src: lib/csvimport.mjs:14-24 -->
- Tested layouts use invented fixtures for six banks; the real column layouts are unconfirmed, which is why the mapper is the fallback. <!-- src: test/fixtures/csv/commbank-split.csv, test/fixtures/csv/anz-split.csv, test/fixtures/csv/nab.csv, test/fixtures/csv/westpac.csv, test/fixtures/csv/ing.csv, test/fixtures/csv/macquarie.csv, docs/faq.md:46 -->

## Wise

- `lib/wise.mjs` is a read-only Wise Platform client: GET only, base URL pinned, redirects refused, 429 and 5xx back off, and the token stays in its closure and goes nowhere but `api.wise.com`. It can read the profile, balances and statements and has no way to quote or transfer. <!-- src: lib/wise.mjs:1-9 -->
- `lib/wisesync.mjs` keeps one manual account per Wise currency balance, keyed by Wise's balance id so a re-sync never adds a second. Statement rows go in through the manual insert path as one import, idempotent on Wise's transaction reference, then the balance is set to Wise's figure with a balance adjustment row. <!-- src: lib/wisesync.mjs:1-9 -->
- The first run backfills twelve months. If Wise refuses statements for strong customer authentication the account runs on balances alone and rows come from a CSV import; nothing works around it. <!-- src: lib/wisesync.mjs:10-14, lib/wisesync.mjs:25 -->
- Wise rides on the Redbark sync queue (poll, reconcile, Sync now) rather than a second scheduler. An unset token means no Wise sync. <!-- src: server.mjs:175-177, lib/wisesync.mjs:17 -->

## Exchange rates

- Rates are AUD per one unit of a currency from Frankfurter (ECB rates, keyless), kept per currency per ECB date in `fx_rates`. A date takes the nearest earlier rate. A write that needs uncovered dates triggers one range call, so a CSV import of any size is one request. <!-- src: lib/fx.mjs:1-12 -->
- Offline, the last known rate stands in and the status says how old it is. With no rate at all the write is refused: Mint never invents a rate. <!-- src: lib/fx.mjs:12-14 -->
- A transfer across a foreign-currency manual account matches within 2% rather than exactly, and only with Wise evidence on the AUD side; linking by hand across currencies allows 5%. <!-- src: lib/transfers.mjs:46-60, lib/transfers.mjs:87, lib/transfers.mjs:176 -->

## Unverified

- That the six bank CSV layouts match what each bank really exports. The fixtures are invented from public reports, per the FAQ.

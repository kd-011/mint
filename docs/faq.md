# FAQ, security and known limits

### Is it safe to point at my bank data?

It is as safe as the machine and the login in front of it. Mint binds to loopback, refuses requests that did not come through your gateway, and adds a passkey lock. It has no accounts, no telemetry and no callbacks to its author. It is young software: read [SECURITY.md](../SECURITY.md) and decide.

### Where does my data go?

Your transactions go from your banks to Redbark to your machine, and stay there. Mint's own outbound calls are: Redbark (the bank feed); merchant icons, fetched by the server from Google or DuckDuckGo by website domain only (no amounts, no account data); Frankfurter for exchange rates and Yahoo or Alpha Vantage for share prices, if you hold foreign currency or shares; and OpenRouter and Wise, only if you set their keys. The browser only talks to your own Mint (a strict content security policy enforces it). Setting `MINT_SCHEDULER=off` stops the scheduled bank polling and the background icon and price fetches.

### What does the AI categoriser send?

Nothing unless you set `OPENROUTER_API_KEY`. With a key, unknown merchants are sent for one batched question: the merchant name and bank description, with digit runs, card masks and dollar amounts stripped first (`scrubForModel` in `lib/categorise.mjs`). Never balances, account numbers or full histories. A daily cap applies. The same key is used to ask for a merchant's website when the built-in map has none.

### Does it move money?

No. The Redbark client only reads. Mint checks whether the transfers you made match your plan; it cannot make them.

### Does it work outside Australia?

The bank feed is Australian (CDR). On manual accounts and CSV imports it runs anywhere, in any currency, and day boundaries, pay cycles and schedules follow whatever IANA zone you set in `MINT_TZ` (default `Australia/Perth`, so a plain install behaves as it always did). The tax parts are ATO only, and the financial year starts on 1 July.

### Do I need Redbark?

No. Without it you add accounts by hand and import CSV statements, see [csv-import.md](csv-import.md). Mint finds your pay from the statement, so pay cycles and budgets work the same. The CSV column layouts for the big banks are the ones widely reported for each, not confirmed by the banks, and Mint shows you what it read before it saves anything.

### Is Redbark free?

No. It is a separate commercial service with its own terms. At the time of writing, API access needs a paid plan after a short trial; see [redbark-setup.md](redbark-setup.md) for what was verified and when. Mint has no financial interest in it.

## Security

- Mint is single user: one owner, no roles. Do not share it.
- It holds your bank data, so treat the machine, `data/` and every backup as sensitive.
- It has two locks. Your gateway headers (`Remote-User` and the `X-Mint-Gate` secret) are the first and the passkey is the second. Never expose port 8970 directly.
- Secrets live in `.env` (mode 600, never committed). `scripts/secret-scan.mjs` and CI keep keys and personal data out of the repository.
- Found a vulnerability? Use a private advisory, see [SECURITY.md](../SECURITY.md). Never post real data in an issue.

## Known limits

Roughly in order of how much each matters:

- One timezone per install. Set `MINT_TZ` before the first sync. Changing it later leaves old dates alone and changes how new days are bucketed.
- Single user. One person, one book. There are no shared budgets or roles and none are planned.
- Live bank feeds need Redbark, a paid third party. Without it you import CSV statements by hand, and there is no automatic update. Local mode with no proxy is for one machine only.
- CSV layouts are unconfirmed. The banks do not publish theirs, so the tested shapes come from what is widely reported. Mint shows its column choices before it imports.
- CDR consent lapses after 12 months and has to be renewed inside Redbark. Mint warns you before it does.
- No store listing for the Android app. You build and sign the shell yourself.
- Young code. It runs the maintainer's own finances, but few other people have used it. Expect rough edges and read the diff before upgrading.

Not planned: moving money, budgets shared between people, a hosted version.

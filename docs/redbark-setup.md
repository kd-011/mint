# Setting up Redbark

Mint reads your Australian bank accounts through [Redbark](https://redbark.com), a commercial service that handles the Consumer Data Right (CDR) consent flow and exposes your accounts and transactions over an API. Mint calls that API read only. Redbark is a separate company with its own pricing and terms; Mint has no financial interest in it.

Everything below was read on Redbark's public pages on 2026-11-01. Pages change, so check the links. Anything I could not confirm is marked **not verified**.

## 1. Make an account and get an API key

1. Sign up at <https://app.redbark.com/sign-up>.
2. Create an API key. Keys start with `rbk_live_` and the secret is shown once, so copy it straight into your `.env` as `REDBARK_API_KEY` ([API authentication](https://redbark.com/docs/help-center/api-authentication.md)).
   - Where the button lives: the older v1 docs say Settings, then API & MCP, in the dashboard ([v1 overview](https://redbark.com/docs/api-reference/overview.md)). The current v2 pages do not say where, so look there first. **Not verified for v2.** Keys can also be made through the API itself (`POST /v2/api_keys`, [account and keys](https://redbark.com/docs/api-reference/v2/account-and-keys.md)).
3. Mint only reads, so a read-only key is enough. Redbark's v2 keys carry scopes such as `connections:read` and `data:read` ([API overview](https://redbark.com/docs/api-reference/v2/overview.md)); which exact set Mint needs is **not verified** here, so if a call is refused, check the scopes on the key. Mint sends the `Redbark-Version` header the v2 API requires.

## 2. Pick a plan

Outside a trial, API access needs Redbark's Developer or Professional plan; the Saver plan does not include it ([API authentication](https://redbark.com/docs/help-center/api-authentication.md)). The [pricing page](https://redbark.com/pricing) listed, on 2026-11-01, Developer at A$16 a month and Professional at A$24 a month, with a 7 day free trial on every plan and no permanent free tier. Annual prices were not listed. Check the page before you rely on those numbers.

## 3. Connect your banks

In the Redbark dashboard choose Add Connection, then AU Banks, pick the bank, sign in with the bank and grant consent. The CDR step is run by Fiskil, an accredited data recipient that Redbark uses ([connections](https://redbark.com/docs/connections.md), [CDR](https://redbark.com/cdr)). Any bank that takes part in the CDR should work; American Express Australia is listed as not yet supported. Business accounts need Open Banking data sharing switched on at the bank first.

New posted transactions typically show up a few hours to about 18 hours after the bank posts them, and pending transactions are left out by default ([connections](https://redbark.com/docs/connections.md)).

## 4. Consent lasts 12 months

CDR consent runs per bank for 12 months. Redbark emails you about 90 days before it ends. There is no in-place extension: you add the bank again as a new connection, which starts a fresh 12 months. When consent expires, syncing on that connection stops ([consents](https://redbark.com/docs/consents.md)). Mint raises an alert before it lapses (the connection status is checked on every sync). Whether re-adding a bank keeps your existing Redbark-side syncs and rules is **not verified**; Mint keeps its own copy of the history either way.

## 5. First start

Put the key in `.env` and start Mint:

```sh
cp .env.example .env
chmod 600 .env
# REDBARK_API_KEY=rbk_live_...
node server.mjs
```

Mint lists your connections and accounts, then backfills each account (up to about seven years where the bank allows) and polls every 30 minutes. Redbark limits each key to 30 or 60 requests a minute depending on the endpoint ([API overview](https://redbark.com/docs/api-reference/v2/overview.md)); Mint's client honours `Retry-After`, and a large backfill simply takes a while.

## Webhooks (optional)

Without a webhook Mint polls every 30 minutes, which is fine. If you want near-instant updates, create a webhook destination in Redbark pointing at `https://<your host>/api/redbark/webhook` and put its signing secret in `REDBARK_WEBHOOK_SECRET` (the sync-data destination, `X-Redbark-Signature`) or `REDBARK_EVENTS_SECRET` (the v2 events destination, `Redbark-Signature`). Webhooks are a Developer plan feature on Redbark's pricing page. Mint checks both signature formats itself and rejects deliveries older than five minutes. Your reverse proxy must let that one path through without the login (see [self-hosting.md](self-hosting.md)).

## No Redbark?

Leave `REDBARK_API_KEY` unset and Mint still runs: it says once at start-up that the bank feed is off, keeps the 30 minute poll and the nightly reconcile off, and never shows a Redbark prompt. Add accounts by hand in any currency and import CSV statements: see [csv-import.md](csv-import.md). There is no other live bank feed. `node scripts/demo-seed.mjs` runs the whole app on invented data with no key.

---
slug: mint-architecture-access
name: Mint architecture, access
repo: .
status: active
last_verified: 2026-11-22
---

# Access: the gate, the lock, the assistant door and the chat

Mint is single user and holds bank data, so reaching it takes two locks, and the one machine-to-machine door is narrow. The checks live in `server.mjs` and run before any route. See ../ARCHITECTURE.md for the overall map.

## Request gate

- The request handler decides who a caller is before routing. A bearer header means an API caller. Otherwise the request needs `Remote-User` equal to `MINT_USER` and `X-Mint-Gate` equal to `MINT_GATE_KEY`, except for a short open list; failure is 401 and is logged with the reason and never the value. <!-- src: server.mjs:495-527, server.mjs:250-251 -->
- A blank `MINT_GATE_KEY` refuses everyone rather than trusting a client-supplied `Remote-User`. A key must be at least 32 characters, and once a key has been used the server will not start without it, recorded in the `gate_key_enabled_at` setting. <!-- src: server.mjs:73-82, server.mjs:118-127, server.mjs:263-266, lib/apikey.mjs:7 -->
- By default it listens on `127.0.0.1` only; the Docker image sets `0.0.0.0` inside the container, where compose publishes the port on the host's loopback. <!-- src: server.mjs:83-85, docker-compose.yml:22, docker-compose.yml:52 -->
- Local mode and the demo have no gateway, so a small front adds the two headers. It is the only guard there, so it answers only to a `127.0.0.1`, `localhost` or `[::1]` host with a same-host origin, and a DNS-rebound or cross-site request gets 403. <!-- src: lib/localfront.mjs:1-4, lib/localfront.mjs:11-34, docker-compose.yml:33 -->

## Fingerprint lock

- The lock is a WebAuthn passkey with user verification required, asked for every time Mint opens, on top of the gateway. The CBOR, COSE keys and signatures are checked in `lib/lock.mjs` with `node:crypto`, no libraries. <!-- src: lib/lock.mjs:1-9 -->
- An assertion needs a live single-use challenge (two minutes), the right origin and rp id hash, the presence and verification flags, a valid signature (ES256 or RS256) and, once the authenticator counts, a rising counter. A good assertion opens a server-side session in the `__Host-mint-unlock` cookie that slides for 15 minutes idle and never outlives 8 hours. <!-- src: lib/lock.mjs:5-21 -->
- With the lock on, every `/api/` route except the lock's own answers 423 until unlocked. The first fingerprint needs only the gate identity; later ones need an unlocked session. Failed checks count per IP, 20 in ten minutes. <!-- src: server.mjs:252-254, server.mjs:286-289, server.mjs:371-374, server.mjs:523-527 -->
- `MINT_LOCK=off` is refused once a fingerprint is enrolled (`lock_enabled_at`). The only way off is `scripts/lock-reset.mjs --yes --disable` from a shell on the box; the web side never clears the last fingerprint. <!-- src: server.mjs:129-137, scripts/lock-reset.mjs:1-11 -->
- The Android app signs in through Credential Manager, so the lock accepts one extra origin, `android:apk-key-hash:<cert>`, from `MINT_ANDROID_CERT_SHA256`, and `/.well-known/assetlinks.json` names the same package and certificate. Unset, the app is not recognised and the web app is unaffected. <!-- src: lib/androidapp.mjs:1-14, server.mjs:411, server.mjs:139-145 -->

## Assistant door

- `/api/assistant/` is a narrow JSON API for an outside assistant's chat tools: reads (summary, spend, transactions, budgets, tax, balances, alerts, the pay cycle, income, bills, goals, debt, Save and Invest, holdings, loan, forecast, the accountant pack link, the tax estimate), marking alerts pushed, and the chat writes. Nothing here moves money, deletes a transaction or touches a connection. <!-- src: lib/assistant.mjs:1-8, lib/assistant.mjs:435-473 -->
- Its bearer key (`MINT_API_KEY`) opens that prefix and nothing else, only for a caller that connected straight to the socket from the same machine; anything carrying proxy or gate headers is refused like a wrong key. Bad keys count per IP, 30 in ten minutes. <!-- src: lib/apikey.mjs:1-10, server.mjs:500-510, server.mjs:285-286 -->
- `MINT_API_ALIAS` (`/api/name`) lets a client keep its own path to the door. It maps only onto `/api/assistant/`. <!-- src: server.mjs:66-72, server.mjs:498 -->
- Writes come in two tiers. Safe writes (recategorise one transaction, a rule, a budget target, a goal, a holding, a manual asset, a loan detail, a manual account, a bulk edit of up to five transactions) apply at once and answer with an undo token. Deletes of a rule, budget, goal, holding, lot or Ledger debt, anything on an account, and any write touching more than five transactions answer 202 with a confirm token and a summary of exactly what would change. <!-- src: lib/chatwrites.mjs:1-13 -->
- Every write runs inside `capture()`, which diffs the tracked tables before and after; that diff is the undo record and also counts the rows touched. Undo refuses if a row changed since. Tokens are 32 random bytes with only the SHA-256 stored; undo lasts 24 hours, confirm 10 minutes, each good for one use. <!-- src: lib/undo.mjs:1-19 -->
- The bearer key cannot confirm. A held change applies only when the owner taps Confirm on the card in the page, through `/api/chat/confirm/<token>` behind the gate and the lock. Undo stays open to the key because it only puts back. <!-- src: server.mjs:511-518, server.mjs:467-476 -->
- The page's undo and confirm calls are limited to 120 per window. <!-- src: server.mjs:192, server.mjs:470-476 -->

## In-app chat

- The browser posts to `POST /api/chat` behind the gateway. Mint calls the assistant at `MINT_CHAT_URL` (loopback http only) with `MINT_CHAT_KEY` (a different key from `MINT_API_KEY`, 32 characters or more) and streams the reply back. The key never leaves the process, and nothing logs a message or reply. <!-- src: lib/chatproxy.mjs:1-5, lib/chatproxy.mjs:37-44, server.mjs:187-192 -->
- A message is limited to 8,000 characters and 30 per ten minutes; a stream with no bytes for 120 seconds is given up, with pings every 15 seconds. <!-- src: lib/chatproxy.mjs:11-17, lib/chatproxy.mjs:109 -->
- The chat UI is optional: it appears only when `MINT_CHAT_KEY` is configured, because the server stamps `__CHAT__` as on or off into the page. <!-- src: server.mjs:239-246, public/core.js:226 -->
- A resent question is safe: the page tags each question with a request id, and a safe write the assistant makes meanwhile is journaled under it, so the same write made again returns the stored answer, undo token included, instead of writing twice. <!-- src: lib/chatturn.mjs:1-8 -->

## Transport and headers

- State-changing requests must carry the app's own origin; a foreign `Origin` or `Sec-Fetch-Site: cross-site` is 403. Request bodies are JSON objects capped at 64 KB by default. <!-- src: server.mjs:428-435, lib/http.mjs:49-57 -->
- Every response carries a strict CSP (`script-src 'self'`, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. <!-- src: lib/http.mjs:4-22 -->
- The process sets `umask 077`, so the database, its WAL and receipts are private to the service user. <!-- src: server.mjs:42 -->
- Uploads, manual model runs and the accountant pack are rate limited by fixed windows per key. <!-- src: lib/http.mjs:58-68, lib/api.mjs:87-89 -->

## Unverified

- How the live instance's gateway is configured and which proxy sits in front. The repo ships recipes in docs/self-hosting.md; the running deployment is kept outside it.
- The Android passkey path on a real device. The code and its tests exist; a device check was not made here.

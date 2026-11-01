# Contributing to Mint

Mint is a single-user, self-hosted personal finance app for Australians. Small, focused fixes and improvements are welcome. Big new features are best discussed in an issue first, because the project is deliberately small: one user, no build step, no npm dependencies.

## Ground rules

- Mint reads bank data and holds it. Never put real account data, real balances, real merchants, real names, API keys or screenshots of your own book in an issue, a pull request, a test or a fixture. Use invented data (`test/fixtures/`, `scripts/demo-seed.mjs`).
- Money is integer cents everywhere. Dates are `YYYY-MM-DD` in the API and DD/MM/YYYY on screen. Do not introduce floats for money.
- Keep it dependency-free: Node 22 (`node:http`, `node:sqlite`) on the server, plain JS in `public/`, no bundler. A new npm package needs a very good reason.
- Match the surrounding code: naming, comment density, idiom. Comments say why, not what.
- No em dashes in code, comments or docs. Use commas, colons and full stops.
- Australian spelling and units in user-facing copy (categorise, cheque, $ AUD, Perth time by default).

## Setting up

```
git clone <your fork>
cd mint
node scripts/demo-seed.mjs        # a throwaway Mint over made-up data on http://127.0.0.1:8980/
```

You need Node 22 or newer. You do not need a Redbark key to develop: the tests and the demo run against a fake Redbark (`test/fixtures/fake-redbark.mjs`).

## Tests

```
node --check *.mjs lib/*.mjs && node --test test/
```

Run a single file with `node --test test/<name>.test.mjs`. A change should come with a test that fails without it. Every test uses invented data and a temporary `MINT_HOME`; none may read your real `.env` or `data/`.

## Before you open a pull request

1. The full suite passes.
2. `node scripts/secret-scan.mjs . --tracked` prints `clean`.
3. Screens you touched were checked at 390x844 (phone first) and 1440x900, with an empty state and an error state.
4. You did not change a finance calculation, an API route or the database schema without saying so in the description and adding tests for it. Schema changes are additive migrations in `lib/db.mjs`.

## Sign-off (DCO), no CLA

There is no contributor licence agreement. Instead every commit carries a `Signed-off-by` line, which says you wrote the change or have the right to submit it under the project's licence (the Developer Certificate of Origin, https://developercertificate.org/). Add it with `git commit -s`:

```
Signed-off-by: Your Name <you@example.com>
```

Your contributions are licensed under the GNU Affero General Public License v3.0, the same as the rest of Mint (see `LICENSE`).

## Reporting a security problem

Do not open a public issue for a vulnerability. Open a private security advisory on the repository (Security tab, "Report a vulnerability"); see `SECURITY.md`. Include what you found and how to reproduce it, never real data.

## Not financial or tax advice

Mint's tax tagging and estimates are bookkeeping aids. They are not financial, tax or legal advice, and contributions must not present them as such.

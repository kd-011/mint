---
slug: mint-architecture-frontend
name: Mint architecture, frontend
repo: .
status: active
last_verified: 2026-11-22
---

# Frontend: the single page app and its offline layer

A plain-JavaScript PWA with no build step and no bundler, served by `server.mjs` and shared by the phone, the desktop browser and the optional Android shell. See ../ARCHITECTURE.md for the overall map and ../../DESIGN.md for how it looks.

## Shell and serving

- Classic scripts share one scope: `public/core.js` holds the plumbing (formatting, icons, network with retry, the offline write queue, cached reads, toasts, sheets, undo, forms) and every screen file sees its names. `public/app.js` is the router and boot; the current tab lives in the URL path and its sub-state in the query. <!-- src: public/core.js:1-3, public/app.js:1-4 -->
- `server.mjs` reads every shell file once at start from a fixed list (`FILES`, with the screen scripts in `SCRIPTS`), versions them by a content hash, and stamps the page: `__SCRIPTS__` for the script tags, `__TZ__` for the `MINT_TZ` zone, `__CHAT__` for chat on or off. A file not in the list is not served. <!-- src: server.mjs:223-248 -->
- Static responses are `no-cache`, except images and fonts at one day. A GET for a path in the route list returns the page shell with 200, any other path 404. <!-- src: server.mjs:247, server.mjs:488-491 -->
- `public/routes.js` is the one list of screens: four tabs (Home, Spending, Save and Invest, More), the More list, the route table with legacy aliases that redirect, and `SHELL_PATHS`. It is a plain script in the page and a CommonJS module for the server, the worker and tests. <!-- src: public/routes.js:1-5, public/routes.js:10-69, public/routes.js:97 -->
- Logic that must match between the page and the tests is kept DOM-free and shared as one file: `ux-model.js` (search, shortcuts, the Home sync strip, cycle insights), `cycle-math.js` (pay-cycle labels, pace, split totals), `goal-calc.js`, `owed-math.js`, `demo-math.js`. <!-- src: public/ux-model.js:1-4, public/cycle-math.js:1-2, public/demo-math.js:1-8, server.mjs:230 -->

## Offline and caching

- The service worker caches the app shell up front and answers network first with cache fallback, so the shell opens offline. It leaves `/api/` alone: API data is cached by the page in `localStorage`. The cache name carries the content hash, so each change installs a fresh worker. <!-- src: public/sw.js:1-5, public/sw.js:14-17, public/sw.js:36-52 -->
- Merchant logos live in their own cache, `mint-logos`, capped at 400 entries and kept across deploys, and only a real same-origin image is cached, never a gate redirect or an error page. <!-- src: public/sw.js:6-10, public/sw.js:20-32 -->
- Writes made offline queue in `localStorage` (receipt photos in IndexedDB) and flush in order when the connection returns. A change made in demo mode is never queued. <!-- src: public/core.js:368-376, public/core.js:432-437 -->
- Reads are cached under `mint:` keys; when the browser runs out of room the cached reads are dropped before the queue and drafts. <!-- src: public/core.js:212-220 -->
- Demo mode lives on the device only: one random factor scales every dollar, account numbers are masked and writes are refused. Nothing is sent anywhere. <!-- src: public/core.js:228-232, public/demo-math.js:1-8 -->

## Design system in code

- `public/style.css` is the single stylesheet, dark only (`color-scheme: dark`), with tokens in `:root` at the top. The UI kit is vendored into `public/kit/` (version in `public/kit/VERSION`) and loaded through `public/kit-boot.js` as `window.kit`. A CSP with no inline script is why the loader is its own file; if the kit fails to load, `core.js` falls back to its own toast and plain CSS motion. <!-- src: public/style.css:2-5, public/style.css:44, public/kit/VERSION, public/kit-boot.js:1-4 -->
- Charts are inline SVG from `public/charts.js`, no library, in a fixed six-colour order with a legend and a table view for every chart. <!-- src: public/charts.js:1-8 -->
- The rules for tokens, shared classes, layout and motion are in docs/reference.md under Design system, and the identity summary is in ../../DESIGN.md. <!-- src: docs/reference.md:230-263 -->

## Unverified

- Behaviour on iOS Safari and in the Android WebView beyond what the tests drive. The tests run in Node and a fixture server; no device matrix is recorded in the repo.

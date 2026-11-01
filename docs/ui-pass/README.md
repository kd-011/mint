# UI pass, 2026-10-20

Whole-app pass: one design system in `public/style.css` (see README "Design system"), applied to every screen. Shots are before (left) and after (right), invented fixture data only.

- `m-*.jpg`: phone, 390 by 844 at 2x. `-2` is the same screen scrolled one page.
- `d-*.jpg`: desktop, 1440 by 900.
- `m-tx-sheet`, `m-filter-category`, `m-palette`, `m-goal-edit`, `d-tx-sheet`, `m-lock`, `d-lock`: sheets, dropdown, search, form, lock screen.
- `m-states-after.png`: skeletons (slow server), error cards (server 500) and designed empty states, after only.

Reproduce: `node scripts/ui-fixture.mjs 8991` starts a throwaway Mint over invented data (add `--empty` for the empty-state book), then point any headless Chromium at it with the header `Remote-User: owner`. Use `reducedMotion: 'reduce'` and block the service worker. The server reads `public/` once at start, so restart it after an edit, or have the browser fetch the `.css` and `.js` files from disk. Never point shots at the real book.

Checks run on every screen at both sizes: no horizontal scroll at 390, no touch target under 44px (the swipe buttons on a Transactions row are 44px and scaled to 36 until the row is dragged), no clipped text, no blank first paint.

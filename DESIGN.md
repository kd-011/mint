# Design

Device: phone-first. Tier: personal-pwa.

## Direction

A money screen for one person, opened on a phone to answer one question: am I fine until payday. The focal element on Home is the net worth hero, a green gradient card with the figure and the days to payday under it; the safe-to-spend figure, the pace of flexible spend and the accounts follow in quiet rows. The type is Geist from the vendored kit with tabular numerals on every amount. The theme is dark only, with green kept for identity and money in, amber for needs a look and red for over or failed. Density is phone density: 56px rows, 44px targets, one headline figure per screen, and on a desktop (1024px and up) a rail, one column and a right pane that shows safe to spend and balances until something opens in it. The shape language is pills for controls and squircle tiles for icons, borderless cards over a stepped surface ramp, with glass for the dock, toasts and sheets. Motion is meant to feel physical: sheets slide on a drawer curve, the dock pill slides under the active tab on a spring, hero figures count up on first draw, and reduced motion redraws entrances as plain fades.

## Identity

The green gradient net worth hero with a soft circle in its corner, above a floating pill dock whose active tab has a sliding thumb. A leaf mark is the app and launcher icon.

## System

- Tokens and every shared class: `public/style.css`, `:root` at the top. Colour, edge, type scale, shape, space, icon tile, motion, press and elevation are all named tokens, and a screen takes a token, never a literal.
- Kit: `public/kit/` (vendored UI kit, version in `public/kit/VERSION`, not edited by hand here), loaded through `public/kit-boot.js`. It supplies the Geist face, phone type roles, toasts, sheet spring and list entrance.
- Charts: `public/charts.js`, inline SVG, six categorical colours in a fixed order, a legend and a table view for every chart.
- Icons: the `I` table in `public/core.js` and the kit's sprite `public/kit/icons.svg`.
- Screens and routes: `public/routes.js`. The full rules, class list and layout notes: docs/reference.md under Design system.

## Refuses

- Literal colours, radii, sizes or durations in a component rule, `ease-in`, and `transition: all`. A new heading, row or card variant is not made without checking the shared list first.
- Coloured left or full borders as an accent, and green outlines on controls. Controls are filled with a neutral hairline, and a status is a tint or a chip.
- A flat grey, generic hero. The kit-wide look was tried and reverted for exactly that; Mint keeps its own palette and green hero.
- A blank screen while loading. Every screen draws a skeleton before its first await, and an error shows the real error text with a Retry button.
- Information that only appears on hover, and tap targets under 44px.

## Surfaces

- Home (`/`): operating. Net worth, accounts by kind with bank logos, this cycle's flexible spend against pace, and what changed against last cycle. States: loading skeleton, empty book (offers a bank feed or a CSV import), sync failed (strip with Retry), offline.
- Spending (`/transactions`, `/budgets`): operating. A searchable, filterable transaction list with saved views, and per-cycle budgets with a pace marker per row.
- Save and Invest (`/save`): operating. Goals first, then holdings, super and the home loan, each section loading and failing on its own.
- More (`/more`): a launcher for Accounts and sync, Income, Plan, Ledger, Tax, Reports, Assets, Rules, Review and Settings, with Search as its first row.
- Lock and set-up cover: gating. One fingerprint action, and its refusal states.

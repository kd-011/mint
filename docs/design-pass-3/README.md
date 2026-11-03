# Design pass 3: quiet glass

> The before and after screenshots this note describes are not in the public repository (about 17 MB each). Regenerate them: `node scripts/ui-fixture.mjs 8991 --browse`, then `node scripts/ui-shots.mjs <dir> --base http://127.0.0.1:8991` (see the header of `scripts/ui-shots.mjs` for the browser it needs).

2026-10-21. A visible redesign, asked for after pass 2 turned out to be mostly motion. The theme (dark, green, pill), the structure and every route, number and feature stay. Only the surface language changes. It changes everywhere at once because the work is in the tokens and shared classes, not per screen.

`before/` and `after/` hold the same 25 screens at 390x844 (`m-`, 2x) and 1440x900 (`d-`): shot with `node scripts/ui-shots.mjs <dir>` against the fixture servers. Before is `main` at pass 2. The shots show no horizontal scroll and no clipped text at either size. The only small targets listed were already there (swipe actions hidden behind their row, 36px desktop filter buttons under a fine pointer).

## What changed, and why

| Before | After | Why |
| --- | --- | --- |
| Every control outlined in a faint green (`--ctl-edge`), selected ones outlined in a brighter green | Controls are filled (`--ctl-bg`) with a neutral hairline; selected is a tint with no outline | The green outline on everything was the loudest thing on screen and broke the no coloured outlines rule. Apple uses tonal fills for controls |
| Round icon and logo tiles | Squircles, one token (`--r-tile`, 30%) | The most recognisable iOS shape. It changes every row, the search sheet and the account page |
| Cards and row groups had a 1px border | Borderless, a slightly lighter surface ramp (`--panel` to `--panel-3` each a step up), radius 28/20/32 | Content over chrome: depth comes from fill and shadow, with no lines |
| Full-width row dividers | Hairlines inset to the text when the row has an icon tile | The grouped inset list iOS uses |
| Section headings were 12px tracked capitals (HOME, SAVE, CASH) | Sentences at 18px bold (`Your goals`, `Flexible`, `People`), capitals only for the small labels inside a card | A real hierarchy: the page has headings you can scan, and the labels stay quiet |
| Segmented control swapped a green tint between options | A raised thumb that slides to the choice on the spring, for 2 to 5 options, pure CSS (`:has`) | The iOS segmented control. Tab, range and filter pickers all gain it |
| Switch: dark track, grey knob | Green track when on, white knob with a shadow | The iOS switch |
| Dock: green border, green pill | Heavier glass (blur 28, saturate 1.7), neutral thumb behind the active tab, green icon and label | Colour is kept for meaning |
| Net worth hero 50px on a flat green gradient | Up to 62px on layered green light, no border | The figure the app is about leads the page |

New and changed tokens (all in `:root` and the README Design system): `--ctl-bg`, `--thumb`, `--thumb-solid`, `--r-tile`; `--ctl-edge` is now the neutral hairline; `--r-card` 28, `--r-inner` 20, `--r-sheet` 32; the three panel steps one notch lighter; `--glass` more transparent.

Left as it was on purpose: the 4/8 spacing, the type scale, row heights, 44px targets, every screen's content and order, and what the owner removed from Home.

## Checks

Playwright shots of every screen at both sizes, read after the change. Five new tests in `test/design-pass-2.test.mjs` pin the token values, the squircle and borderless rules, the segmented thumb for each option count and its reduced-motion cut.

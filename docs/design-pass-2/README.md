# Design pass 2: motion and polish

> The before and after screenshots this note describes are not in the public repository (about 17 MB each). Regenerate them: `node scripts/ui-fixture.mjs 8991 --browse`, then `node scripts/ui-shots.mjs <dir> --base http://127.0.0.1:8991` (see the header of `scripts/ui-shots.mjs` for the browser it needs).

2026-10-21. Three lenses over the whole app: Emil (motion, press, the invisible details), Impeccable (audit, then polish) and Apple (HIG: clarity, deference, depth, springs). No data, API, maths or route changed. Nothing the owner removed from Home came back.

`before/` and `after/` hold every screen at 390x844 (`m-`, shot at 2x) and 1440x900 (`d-`): home, transactions, budgets, reports, income, save, plan, assets, accounts, rules, owed, subs, tax, account, more, settings, the three empty states, not found, the transaction sheet, search, chat, a filter dropdown and the lock screen. Made with `node scripts/ui-shots.mjs <dir>` against `scripts/ui-fixture.mjs`. The script also checks each screen for horizontal scroll, targets under 44px and clipped text: none of the three at either size. (Two things it lists are not defects: the Transactions swipe actions, 36px tall at rest behind their row and 50px when swiped open, and the desktop filter buttons, 36px under a fine pointer by design.)

The screens that visibly differ: `m-owed`, `m-save`, `m-sheet-tx` and `d-sheet-tx` (grabber), `m-chat` (suggestion chips), `m-rules`. Most of the rest is motion, which a still cannot show; the checks for it are in the last section.

## Emil: motion

| Before | After | Why |
| --- | --- | --- |
| Reduced motion set every animation and transition to 0.01ms | Entrances become plain fades, presses stop sinking, the dock pill cuts, the spinner still turns (slower), the skeleton pulses | A global kill froze every spinner and skeleton, so a slow screen looked dead. Less motion, not none |
| Sheets and chat rose 24px and faded in; closing used `ease-in reverse` at the same length | Sheets slide up from the bottom edge on the iOS drawer curve (`--ease-drawer`, .4s) and leave in .18s | Exits are quicker than entrances. Nothing starts slow |
| Press scale was .9 to .99 across 20 rules, literal in each | `--press` .97 and `--press-icon` .92, one token each | A press should feel the same everywhere. Both are 1 under reduced motion |
| Press transitions ran .25s | .15s on the same strong ease-out | Feedback has to land with the finger |
| A tapped row faded its highlight in | Lit at once, fades out on release | Touch feedback is immediate, the fade is only the release |
| Hero figures counted up from zero on every visit to Home, Budgets, Ledger and Tax | Count up the first time in a session; a revisit sits still; a changed figure ticks from the one shown (`UxModel.tickPlan`, `tickValue`) | A balance that spins on every tab switch reads as unsettled, and a money figure should not perform tens of times a day |
| Search opened with a .25s entrance even from `/` or Ctrl K | The keyboard opens it with no animation; a tap on More keeps the entrance | Keyboard-initiated and repeated hundreds of times a day |
| Toasts left with an inline `opacity .25s` | A `.leaving` class: fade and drop 8px in .18s | Exits belong to the stylesheet and tokens, and now carry direction |
| Drag-dismiss settle used a literal `.38s` and `.3s` | `--dur-3` on `--ease-spring`, from wherever the finger let go | Springs keep their velocity feel when interrupted |
| Empty-state icons bobbed forever (`float`, 4s) | One soft arrival | A loop on a screen that has nothing else to do is only decoration |
| Tab change slid 22px | 14px | Tabs change all day |
| Seven literal durations (.16s, .24s, .6s, .8s, .9s, 1s) | Tokens: `--dur-4` for data, `--dur-out` for exits | Tokens only |
| Whole-page `touch-action` unset | `manipulation` on controls | No double-tap zoom delay on a tap |

New tokens, all in `:root` and the README Design system: `--press`, `--press-icon`, `--dur-4`, `--dur-out`, `--ease-drawer`, `--ease-spring`, `--grabber`.

## Impeccable: audit, then polish

Audit (technical): a11y 3, performance 4 (transform and opacity only, `content-visibility` on long lists), theming 4 (no literal colours in components), responsive 4, integrity 3 (token drift in motion only). The detector's only findings were its "bounce easing" warning on the name `--spring`, which is an exponential ease-out; the README now says so.

| Found | Fixed |
| --- | --- |
| Ledger hero ran figures into words: `$1,105.00owed to you (3)`, `4debts open` | `.owed-hero .split` is a wrapping row with a gap after each figure |
| Save opened with two headings stacked, GOALS AND SAVINGS over YOUR GOALS | The first is now the section's accessible name only |
| Chat suggestions started 3px outside the panel and were clipped: a later `.chips` rule beat `.chchips` | `.cfoot .chchips` lines the first chip up with the composer |
| Sheet grabber was `--line` on `--panel`, close to invisible | `--grabber`, readable but quiet |
| Rule patterns wrapped inside a pill, giving a lozenge across two lines | `--r-inner` and `overflow-wrap: anywhere` |
| Multi-line headings and empty-state copy left a single word on the last line | `text-wrap: balance` on headings, `pretty` on secondary copy |
| `color-scheme` only on a meta tag and date inputs | `color-scheme: dark` on `html`, so scrollbars and native controls follow |

## Apple: three moves, done properly

1. **The dock pill.** One pill under the active tab, driven by an index and a `linear()` spring with 8% overshoot, in the phone dock and (vertical) in the desktop rail. It slides from either direction and can be retargeted mid-flight. Measured: 46px at 40ms, 99px at 120ms, settled at 92px.
2. **Sheets like iOS.** Full-height slide from the bottom on the drawer curve, a visible grabber, the scrim following the finger, and a spring settle on release (the flick and rubber-band logic was already there).
3. **Numbers that settle.** The hero figure ticks between values instead of replaying from zero.

Not done, and why: large titles that collapse on scroll. the owner's standing rule is no page headers or subtitles, and the top bar was removed on purpose, so a title would be the header he took out. The More screens already carry the iOS inline pattern (back label, centred title). Detents on sheets were also left out: they are editors, and a half-height detent would be a new behaviour, not polish.

## web-design-guidelines check

Run on the touched CSS and scripts. Passes: reduced motion honoured, only `transform` and `opacity` animated, no `transition: all`, interruptible motion, `touch-action`, `overscroll-behavior` on sheets, `color-scheme`, tabular numerals, safe-area insets, `:focus-visible`, virtualised long lists, icon-only controls spot-checked for labels. Added from it: `touch-action: manipulation`, `text-wrap`, `color-scheme`. Left alone: three-dot ellipses in loading copy (`Saving...`), which is house style across the app.

## How the motion was checked

Playwright against the fixture server, sampling computed styles over time: sheet top 836, 416, 115, 68, 49px at 70ms steps and closing in under 200ms; dock pill transform 46, 99, 92, 92px; Home figure `$416,063`, `$417,429`, `$417,430` on first load and `$417,430` throughout on a revisit; keyboard search `animation: none` and hidden within 50ms of Escape; toast opacity .07 at 80ms of leaving; reduced-motion context: spinner `spin 1.6s`, skeleton `sk-pulse`, `--press` 1. No console errors.

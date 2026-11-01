# Third-party notices

Mint is licensed under the GNU Affero General Public License v3.0 (`LICENSE`). It bundles or builds against the following, all under licences compatible with AGPL-3.0.

| Component | Where | Licence |
| --- | --- | --- |
| Geist and Geist Mono typefaces (Vercel, "The Geist Project Authors") | `public/kit/fonts/` | SIL Open Font License 1.1, https://openfontlicense.org/ . The fonts are used unmodified as separate files, which the OFL allows alongside any licence. |
| Icon sprite and UI kit CSS/JS | `public/kit/` | Written by the maintainer, AGPL-3.0 like the rest. |
| Capacitor (`@capacitor/core`, `/android`, `/cli`) and its npm dependencies | `android-shell/` (build time only, not in the web app) | MIT, plus ISC, BlueOak-1.0.0, Apache-2.0, Unlicense and 0BSD for transitive packages (see `android-shell/package-lock.json`). |
| AndroidX (appcompat, coordinatorlayout, core-splashscreen, webkit) | `android-shell/android/` | Apache-2.0 |
| Gradle wrapper and the Android Gradle Plugin | `android-shell/android/` | Apache-2.0 |
| JUnit 4 | `android-shell/` unit tests only, not shipped in the APK | Eclipse Public License 1.0 |

The server and the web app have no npm dependencies. They use only what ships with Node 22.

Bank and merchant logos are not bundled, with one exception: `lib/bank-icons/nab.png` is a cleaned copy of NAB's site icon, used instead of fetching one. NAB and other bank names and marks are trademarks of their owners and are used here only to identify the bank. Delete the file if you would rather not carry it: Mint then shows a letter tile for that bank. At run time Mint can fetch other logos from public icon services (Google s2 favicons, DuckDuckGo), which is off the books of this repository.

Redbark, Wise, OpenRouter, Alpha Vantage, Yahoo Finance and Frankfurter are third-party services with their own terms. You need your own account or key for the ones you turn on.

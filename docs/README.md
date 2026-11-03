# Documentation

| Read this | When |
| --- | --- |
| [../README.md](../README.md) | What Mint is, the demo, your own book, when not to use it |
| [features.md](features.md) | Everything it does, with pictures, and how it fits together |
| [comparison.md](comparison.md) | Mint against Actual Budget, Firefly III, PocketSmith and Lunch Money |
| [faq.md](faq.md) | Where your data goes, security, the known limits |
| [redbark-setup.md](redbark-setup.md) | Getting a Redbark API key and connecting your banks |
| [csv-import.md](csv-import.md) | Using Mint without Redbark: manual accounts and importing bank CSV statements |
| [self-hosting.md](self-hosting.md) | Local mode, the login gateway, reverse proxy recipes, Docker, systemd, configuration, backups, updating |
| [reference.md](reference.md) | Engineering notes: the engine, every API route, the design system |
| [maintainers.md](maintainers.md) | Releases, and how the public repository is kept in sync |
| [../CHANGELOG.md](../CHANGELOG.md) | What changed in each release |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Sending a change: tests, sign-off, ground rules |
| [../SECURITY.md](../SECURITY.md) | Reporting a vulnerability |
| [../android-shell/README.md](../android-shell/README.md) | Building the optional Android app |

## Pictures

- `screenshots/`: the phone and desktop shots used in the README and the guides (`m-csv-import.png` is the CSV import preview in csv-import.md). `node scripts/gen-assets.mjs` regenerates every image in this folder, plus the banner, the hero, the demo GIF and the social preview (see the header of that script for the browser it needs). All of them come from the invented demo data.
- `ui-pass/`: before and after shots from a whole-app design pass, with invented fixture data only.
- `design-pass-2/`, `design-pass-3/`: notes from two later design passes. The screenshots they describe are not in the repository. Each note says how to regenerate them.

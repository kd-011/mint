# Documentation

| Read this | When |
| --- | --- |
| [../README.md](../README.md) | What Mint is, the 30 second demo, the FAQ and the known limits |
| [redbark-setup.md](redbark-setup.md) | Getting a Redbark API key and connecting your banks |
| [csv-import.md](csv-import.md) | Using Mint without Redbark: manual accounts and importing bank CSV statements |
| [self-hosting.md](self-hosting.md) | The login gateway, reverse proxy recipes, Docker, systemd, updating |
| [reference.md](reference.md) | Engineering notes: the engine, every API route, the design system |
| [maintainers.md](maintainers.md) | Releases, and how the public repository is kept in sync |
| [../CHANGELOG.md](../CHANGELOG.md) | What changed in each release |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Sending a change: tests, sign-off, ground rules |
| [../SECURITY.md](../SECURITY.md) | Reporting a vulnerability |
| [../android-shell/README.md](../android-shell/README.md) | Building the optional Android app |

## Pictures

- `screenshots/`: the phone and desktop shots used in the README and the guides (`m-csv-import.png` is the CSV import preview in csv-import.md). Regenerate every image in this folder, the banner, the hero, the demo GIF and the social preview with `node scripts/gen-assets.mjs` (see the header of that script for the browser it needs). They are all taken from the invented demo data.
- `ui-pass/`: before and after shots from a whole-app design pass, invented fixture data only.
- `design-pass-2/`, `design-pass-3/`: notes from two later design passes. The screenshots they describe are not in the repository; each note says how to regenerate them.

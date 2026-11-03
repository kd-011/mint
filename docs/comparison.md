# Mint compared with other budgeting apps

All four are good software with more users than Mint. The table lists only differences I could check against each project's own docs and issue tracker. Actual Budget's sync page and issues were read on 2026-11-03, the others on 2026-11-01 and 2026-11-03. "Not documented" means I did not find it on the pages linked. It may still exist.

| | Mint | Actual Budget | Firefly III | PocketSmith | Lunch Money |
| --- | --- | --- | --- | --- | --- |
| Where it runs | Your machine | Your machine ([docs](https://actualbudget.org/docs/install/)) | Your machine ([repo](https://github.com/firefly-iii/firefly-iii)) | Hosted, with a free tier ([plans](https://my.pocketsmith.com/plans)) | Hosted subscription; no self-hosting documented |
| Licence | AGPL-3.0 | MIT | AGPL-3.0 | Commercial service | Not stated on the pages I read |
| Stack to run | Docker or Node 22 | Node or Docker | PHP and Laravel, plus a database | Not applicable | Not applicable |
| Australian CDR bank feed | Yes, through Redbark (paid) | Not among the [sync providers](https://actualbudget.org/docs/advanced/bank-sync/). Asked for in [#8108](https://github.com/actualbudget/actual/issues/8108), June 2026. Redbark [documents a SimpleFIN route](https://redbark.com/docs/actual-budget.md) | Not in its importer docs (Redbark [documents a SimpleFIN route](https://redbark.com/docs/firefly-iii.md)) | Yes, per [its own page](https://www.pocketsmith.com/global-personal-finance-software/australia/), through Basiq. I have not tried it | Not implemented, per a [staff reply](https://feedback.lunchmoney.app/institution-status-requests/p/bank-import-australia) in June 2026 |
| Budget periods that follow pay | Yes, found from your deposits | Monthly in its [budgeting docs](https://actualbudget.org/docs/budgeting/). Asked for in [#8220](https://github.com/actualbudget/actual/issues/8220), June 2026 | No: the maintainer [says custom cycles will not happen](https://github.com/firefly-iii/firefly-iii/discussions/8902) | "Various budgeting periods" on its page. Fortnightly from a payday not checked | Yes, a [custom period](https://support.lunchmoney.app/guides/budgeting/step-2-setting-up-your-budget) from a start date |
| ATO tax tags and accountant pack | Yes | Not documented | Not documented | Not documented | Not documented |

What the others do that Mint does not: more than one user, many countries, mature envelope budgeting (Actual), double-entry accounting (Firefly III), a hosted service nobody has to run (PocketSmith, Lunch Money), OFX and QIF files ([PocketSmith](https://www.pocketsmith.com/global-personal-finance-software/australia/), by its own page), and years of other people's bug reports.

Pick Mint when you are paid weekly or fortnightly in Australia, you want the data on your own disk, and tagging deductions through the year is worth something to you. Pick one of the others for any of the reasons above.

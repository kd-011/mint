## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `node --check *.mjs lib/*.mjs && node --test test/` passes
- [ ] `node scripts/secret-scan.mjs . --tracked` prints `clean`
- [ ] The change has a test that fails without it
- [ ] No real financial data, names or screenshots of a real book anywhere in the diff
- [ ] I did not change a finance calculation, an API route or the database schema, or I said so above and added tests (schema changes are additive migrations in `lib/db.mjs`)
- [ ] No new npm dependency
- [ ] Screens I touched were checked at 390x844 and 1440x900

## Sign-off (DCO)

Every commit needs a `Signed-off-by` line (`git commit -s`). It says you wrote the change or have the right to submit it under the AGPL-3.0. There is no CLA. See CONTRIBUTING.md.

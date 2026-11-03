# Security policy

Mint holds bank data, so I take security reports seriously.

## Reporting a vulnerability

Please do not open a public issue.

Use GitHub's private vulnerability reporting: on the repository, open the Security tab and choose "Report a vulnerability" (https://github.com/kd-011/mint/security/advisories/new). Say what you found and how to reproduce it. Never include real financial data, real names or live credentials; invented data and the demo (`node scripts/demo-seed.mjs`) are enough to show a problem.

This is a one-person project, so there is no response-time guarantee. I read every report. A confirmed problem is fixed first, then disclosed in the advisory.

## Supported versions

Only the latest release and `main`.

## What is in scope

- Anything that lets a request without the gateway headers or the passkey unlock reach data
- Authentication bypass, request forgery, injection, path traversal, server-side request forgery in the logo fetcher
- Secrets or personal data written to logs, backups or responses where they should not be
- The Redbark webhook signature check

## What is not

- Problems that need you to expose port 8970 directly or to disable the gateway key or the lock on purpose
- Findings in Redbark, OpenRouter, Wise or any other third-party service
- Your own deployment's proxy, firewall or backup configuration

## Hardening notes for operators

See "Security" in the README and docs/self-hosting.md: keep Mint on loopback behind your own login, use a `MINT_GATE_KEY` of 32 or more characters, keep `.env` at mode 600, and treat `data/` and every backup as sensitive.

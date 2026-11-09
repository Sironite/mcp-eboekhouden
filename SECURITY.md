# Security

## Scope

This server talks only to `https://api.e-boekhouden.nl`. It can:

- read mutations, relations, ledgers, balances, cost centers and outstanding invoices;
- create mutations and relations, and update relations.

It cannot change or delete existing mutations, and no tool accepts arbitrary
paths or URLs. All tool input is validated with zod before any request is made.

## API token

- The API token is read from `EBOEKHOUDEN_API_TOKEN` at start-up. The recommended
  setup injects it with `op run --env-file=.env.op`, where `.env.op` holds only
  `op://` references and is git-ignored.
- The token is only sent in the body of `POST /v1/session`. The short-lived
  session token is kept in memory.

## Logging

- Tokens, `Authorization` headers and full HTTP requests are never logged.
- Errors returned to the assistant contain the e-Boekhouden error code, title and
  trace id only.
- The audit log records write actions locally (credential-like keys are
  stripped). It contains bookkeeping data, so `logs/` is git-ignored and the file
  is created with mode `0600`.

## Secret scanning

A `gitleaks` pre-commit hook (`.githooks/pre-commit`, enabled by `npm install`)
blocks commits with secrets, and CI scans the full history with gitleaks.
`npm run secrets:scan` scans history and the working tree.

## Reporting a vulnerability

Please report security issues privately to the repository owner instead of
opening a public issue.

# mcp-eboekhouden

[![CI](https://github.com/Sironite/mcp-eboekhouden/actions/workflows/ci.yml/badge.svg)](https://github.com/Sironite/mcp-eboekhouden/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

MCP server (stdio) that lets an AI assistant such as Claude keep the books in
[e-Boekhouden](https://www.e-boekhouden.nl) through the official
[e-Boekhouden REST API](https://api.e-boekhouden.nl/scalar/).

It can create mutations and relations and query the administration. Changing or
deleting existing mutations is deliberately not supported: corrections are made
by hand in e-Boekhouden.

## Tools

| Tool                        | Kind  | What it does                                                                                                                       |
| --------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `list_mutations`            | read  | List mutations, filter by type, date range, invoice number, description text                                                       |
| `get_mutation`              | read  | One mutation with rows and VAT totals                                                                                              |
| `list_relations`            | read  | List relations, filter by name/code (substring), type, e-mail, city                                                                |
| `get_relation`              | read  | One relation with name, contact details, VAT number, IBAN                                                                          |
| `list_ledgers`              | read  | List ledger accounts with category                                                                                                 |
| `list_cost_centers`         | read  | Cost centers for `costCenterId` on mutation rows                                                                                   |
| `list_outstanding_invoices` | read  | Unpaid purchase (creditors) or sales (debtors) invoices                                                                            |
| `list_vat_codes`            | read  | Dutch VAT codes accepted by the API (static, from the docs; the API has no VAT endpoint)                                           |
| `get_ledger_balance`        | read  | Balance or period movement of one ledger                                                                                           |
| `vat_quarter_summary`       | read  | **Control overview** per VAT code and per VAT return box (incl. reverse-charged VAT), amount payable/refundable. Not a VAT return. |
| `create_mutation`           | write | All 7 mutation types: invoice received/sent, invoice payment received/sent, money received/sent, general journal entry             |
| `create_relation`           | write | New customer/supplier                                                                                                              |
| `update_relation`           | write | Change fields of a relation (only the fields passed)                                                                               |

### Safeguards on `create_mutation`

- **Marker**: every description, on the mutation and on each row, contains a
  marker (`[claude]` by default, set with `EBOEKHOUDEN_MARKER`), so mutations made
  through this server are easy to find in e-Boekhouden. If the text does not contain it yet, the server puts it in front; a
  marker at the end (`... [claude]`) is kept as is. The mutation description holds
  50 characters including the marker.
- **Validation before sending**: date (real calendar date), amounts (max 2
  decimals, not 0), VAT code (API enum), sales vs. purchase code for invoices,
  `vatAmount` only with `AFW`/`AFW_VERK`, domestic reverse charge (`VERL_INK`) only
  `EX`, ledgers exist and row ledgers have an allowed category, relations exist and
  are active.
- **Idempotency**: before creating, the server compares the request with every
  mutation of the same type on the same date. Same relation, total amount and
  invoice number (or description when there is no invoice number) returns the
  existing mutation (`status: "duplicate"`) and creates nothing.
- **Possible duplicates**: same type, date, relation and amount but a different
  invoice number or description (for example one entered by hand) is rejected.
  After checking it in e-Boekhouden, call again with `confirmNotDuplicate: true`.
- **Audit log**: every write action (created, duplicate, rejected, error) is
  appended as one JSON line to `logs/audit.jsonl` in the install, or to
  `EBOEKHOUDEN_AUDIT_LOG`. Credential-like keys are stripped; the file is created
  with mode `0600`.

### Limits

- **Dutch administrations only**: the VAT codes, VAT return boxes and
  validation cover the Dutch (NL) VAT codes. Belgian administrations (`BE_*` VAT
  codes) are not supported.
- **No attachments**: the API has no endpoint for receipts or invoice PDFs.
- **Reverse-charged VAT** in `vat_quarter_summary` is estimated at 21%, because
  the API reports 0 VAT for those rows. This is verified for `BI_EU_INK`; for
  `BU_EU_INK` and `VERL_INK` it is marked `estimated_unverified`.
- **Substring filters** (`descriptionContains`, `nameContains`, ...) escape `[`.
  `%` and `?` work as wildcards.
- **Rate limits** are not documented by e-Boekhouden; the client throttles to one
  request per 250 ms and retries once on HTTP 429.

## Requirements

- Node.js 20+
- An e-Boekhouden API token (created in the e-Boekhouden account settings)
- Recommended: [1Password CLI](https://developer.1password.com/docs/cli/) (`op`)
  to inject the token at start-up. Any other way of setting the environment
  variables works too.
- For development: [gitleaks](https://github.com/gitleaks/gitleaks) (pre-commit hook)

## Configuration

| Variable                        | Required | Description                                                                          |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `EBOEKHOUDEN_API_TOKEN`         | yes      | e-Boekhouden API token                                                               |
| `EBOEKHOUDEN_API_TOKEN_EXPIRES` | no       | Token expiry (Unix seconds or ISO date); tool results warn from 30 days before       |
| `EBOEKHOUDEN_MARKER`            | no       | Marker added to mutation descriptions (default `[claude]`; 1-20 characters)          |
| `EBOEKHOUDEN_SOURCE`            | no       | Integration identifier for the session (default `mcp_eb`; 1-10 letters, digits, `_`) |
| `EBOEKHOUDEN_AUDIT_LOG`         | no       | Absolute path of the audit log (`.jsonl`)                                            |

With 1Password, copy `.env.op.example` to `.env.op` (git-ignored) and fill in your
own `op://<vault>/<item>/<field>` references. `op run` resolves them when the
process starts; the token is never written to disk.

## Setup

From npm (no build needed):

```sh
EBOEKHOUDEN_API_TOKEN=... npx -y @sironite/mcp-eboekhouden
```

From source:

```sh
npm install          # also enables the git hooks in .githooks/
npm run build
cp .env.op.example .env.op   # then edit the op:// references
```

Run it with secrets from 1Password:

```sh
scripts/start-with-op.sh            # uses ./.env.op; or pass another env file
```

`start-with-op.sh` checks first that the 1Password CLI is signed in and exits
with a clear message if it is not, instead of hanging on an interactive prompt.
It then runs `op run --env-file=<env file> -- node dist/index.js`.

### Register in Claude Code

From the folder where you want the server to be available (local scope keeps it
out of every other folder):

```sh
claude mcp add -s local eboekhouden -e OP_BIOMETRIC_UNLOCK_ENABLED=true -- \
  /path/to/mcp-eboekhouden/scripts/start-with-op.sh /path/to/mcp-eboekhouden/.env.op
```

`OP_BIOMETRIC_UNLOCK_ENABLED=true` works around a macOS privacy restriction that
can stop `op` from detecting the 1Password desktop-app integration ("No accounts
configured" or "not currently signed in"). Check with `claude mcp list`; restart
Claude Code after changes.

### Separate production install (optional)

To keep the server you use for real bookkeeping independent of a development
checkout, install `origin/main` into its own folder:

```sh
npm run install:prod   # default target: ~/.local/share/mcp-eboekhouden
```

The script clones or updates the repository (from `MCP_EBOEKHOUDEN_REPO`, or the
`origin` of this checkout), builds it and keeps its `.env.op` in sync with
`.env.op.example`: missing keys are appended, existing lines are never changed, and
commented optional keys are only reported. Register the production copy as shown
above, pointing at its `scripts/start-with-op.sh` and `.env.op`.

## Development

```sh
npm run lint          # ESLint + Prettier check
npm test              # Vitest; the HTTP layer is mocked, no real API calls
npm run test:scripts  # shell tests for the install helpers
npm run build
npm run secrets:scan  # gitleaks over git history and working tree
```

Git hooks (`.githooks/`): `pre-commit` runs gitleaks, `pre-push` blocks direct
pushes to `main` except fast-forwards to a pull request branch (see
[CONTRIBUTING.md](CONTRIBUTING.md)). CI runs gitleaks over the full history, lint, tests and build.

API research notes (endpoints, fields, error codes, observed behaviour) are in
[`docs/api-notes.md`](docs/api-notes.md).

## License

[MIT](LICENSE)

# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-09

### Added

- Stdio MCP server for the e-Boekhouden REST API.
- Read tools: `list_mutations`, `get_mutation`, `list_relations`, `get_relation`,
  `list_ledgers`, `list_cost_centers`, `list_outstanding_invoices`,
  `list_vat_codes`, `get_ledger_balance`, `vat_quarter_summary`.
- Write tools: `create_mutation` (all 7 mutation types), `create_relation`,
  `update_relation`. No tools to change or delete mutations.
- Validation before sending, a configurable marker on every created mutation
  (`EBOEKHOUDEN_MARKER`, default `[claude]`), exact and possible duplicate
  detection, and a local JSONL audit log.
- Session handling with lazy login, one re-login on HTTP 401, client-side
  throttling and one retry on HTTP 429.
- Token expiry warning (`EBOEKHOUDEN_API_TOKEN_EXPIRES`) and configurable session
  source (`EBOEKHOUDEN_SOURCE`).
- `scripts/start-with-op.sh` to start with secrets from 1Password and fail fast
  when the CLI is not signed in; `npm run install:prod` for a separate
  production install.

[0.1.0]: https://github.com/Sironite/mcp-eboekhouden/releases/tag/v0.1.0

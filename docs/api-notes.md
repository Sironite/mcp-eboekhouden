# e-Boekhouden REST API notes

Source: the official OpenAPI spec at `https://api.e-boekhouden.nl/openapi/v1.json`
(rendered at `https://api.e-boekhouden.nl/scalar/`), retrieved 2026-11-05.
There is one server for test and production: `https://api.e-boekhouden.nl`.

## Authentication

- `POST /v1/session` with `{ "accessToken": "<API token>", "source": "<id>" }`.
  `source` must match `^[\w_ ]{1,10}$` (no hyphens); this server sends `mcp_eb`
  unless `EBOEKHOUDEN_SOURCE` is set.
- Response `{ "token": "...", "expiresIn": <seconds> }`.
- Send the session token in the `Authorization` header.
  The quickstart shows `Authorization: SESSION_TOKEN`; the security scheme
  description shows `Authorization: Bearer SESSION_TOKEN`. The server uses the
  raw token (quickstart). Confirmed on 2026-11-05 with one read-only call
  (`POST /v1/session` 200, `GET /v1/ledger?limit=1` 200 with the raw token).
- Sessions last about one hour (`expiresIn` 3599).
- `DELETE /v1/session` ends a session (not used; sessions expire).
- Session errors: `API_SESSION_001` (source missing), `API_SESSION_002` (source
  pattern), `API_SESSION_003` (token missing), `API_SESSION_004` (token expired),
  `SECURITY_010` (not authenticated).

## Paging, filters, rate limits

- `limit` 1-2000 (default 100), `offset` >= 0. Responses are `{ items, count }`
  where `count` is the number of returned items (no total).
- Filters: `?field[op]=value`, ops `eq` (default), `not_eq`, `like`, `not_like`
  for strings (`%`/`?` wildcards); `gt`, `gte`, `lt`, `lte`, `range` for numbers
  and dates (`range` is inclusive, `a,b`).
- In `[like]` filters `[...]` is a character class (SQL Server LIKE): searching
  for `[claude]` matched almost every mutation until `[` was escaped as `[[]`
  (verified 2026-11-05).
- **Rate limits are not documented.** The server throttles to one request per
  250 ms and retries once on HTTP 429 (Retry-After, max 10 s).

## Mutations

- `GET /v1/mutation` filters: `type`, `id`, `description`, `invoiceNumber`,
  `date`. No relation filter; items contain no relation.
- `GET /v1/mutation/{id}` returns rows and `vat` totals per VAT code.
- `POST /v1/mutation` (201 `{ id }`). No PATCH/DELETE exists for mutations.
- Types: 1 invoice received, 2 invoice sent, 3 invoice payment received,
  4 invoice payment sent, 5 money received, 6 money sent, 7 general journal entry.
- Required: `type`, `date`, `ledgerId`; rows need `vatCode` and `amount`.
  Row `ledgerId` required for types 1, 2, 5, 6, 7; for 1, 2, 5, 6 the row ledger
  may not be `FIN`, `CRED` or `DEB`. Row `invoiceNumber` required for 3 and 4.
- `description` and `invoiceNumber` max 50 characters.
- `vatAmount` only with `AFW` / `AFW_VERK` (`MUTA_003`).
- Reverse-charge purchases must be `EX` (`MUT_026`).
- Selected errors: `MUT_005` period closed, `MUT_019` invoice number exists,
  `MUT_020` relation/invoice combination exists, `MUT_109` invalid VAT code,
  `MUT_110`/`MUT_111` VAT code must be purchase/sale, `MUT_119` relation inactive.

## VAT codes

No endpoint. The mutation enum has 16 NL codes: `HOOG_VERK_21`, `LAAG_VERK_9`,
`VERL_VERK`, `VERL_VERK_L9`, `AFW`, `BU_EU_VERK`, `BI_EU_VERK`, `BI_EU_VERK_D`,
`AFST_VERK`, `LAAG_INK_9`, `HOOG_INK_21`, `VERL_INK`, `AFW_VERK`, `BU_EU_INK`,
`BI_EU_INK`, `GEEN`.

The general VAT table in the docs differs from the enum in places (it lists
`BI_EU_VERK` as purchase and has extra codes such as `VERL_INK_L9`). This server
follows the enum descriptions (decision 2026-11-05).

Observed behaviour (checked against real bookings and a filed VAT return):

- For reverse-charged purchases (`BI_EU_INK`, box 4b) e-Boekhouden books 21%
  VAT on both the output VAT ledger and input VAT, but `GET /v1/mutation/{id}`
  reports `vat` 0 for the row. `vat_quarter_summary` therefore estimates this VAT
  as base x 21% and marks it `estimated`. `BU_EU_INK` (box 4a) and `VERL_INK`
  (box 2a) are treated the same way; not yet seen in real data.
- "Btw-aangifte verwerken" in e-Boekhouden creates general journal entries
  that move input and output VAT to the VAT current account (`BTWRC`). The
  amounts are the rounded return figures plus corrections from earlier periods,
  so small rounding differences remain on the VAT ledgers. The summary lists
  every mutation that posts directly on a VAT ledger separately and leaves it
  out of the totals.

## Relations

- `GET /v1/relation` (filters `code`, `type`, `email`, `name`, `contact`, `city`;
  items: `id`, `type`, `code`), `GET /v1/relation/{id}`, `POST /v1/relation`
  (only `name` required), `PATCH /v1/relation/{id}` (**`name` required**).
- Errors `REL_001`-`REL_059`.

## Ledgers and balances

- `GET /v1/ledger` (filters `code`, `category`), `GET /v1/ledger/{id}`.
- Categories: `BAL`, `VW`, `AF6`, `AF19`, `AFOVERIG`, `VOOR`, `BTWRC`, `FIN`,
  `DEB`, `CRED`.
- `GET /v1/ledger/{id}/balance` and `GET /v1/ledger/balances` with optional
  `from`, `to` (inclusive), `costCenterId`. With `from` the result is the
  movement over the period.

## Cost centers and outstanding invoices

- `GET /v1/costcenter` (filters `parentId`, `description`): `id`, `description`,
  `parentId`, `active`.
- `GET /v1/mutation/invoice/outstanding` with required `credDeb` (`C` creditors,
  `D` debtors) and optional `invoiceNumber`: `mutationId`, `invoiceNumber`,
  `relationId`, `company`, `totalAmount`, `paidAmount`, `outstandingAmount`.

## Errors

Error body: `{ type, code, title, message, status, traceId, errors }`. The docs
example uses PascalCase keys; the server accepts both.

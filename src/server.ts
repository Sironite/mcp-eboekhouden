import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AuditLogger } from "./audit.js";
import type { EBoekhoudenClient, Query } from "./client.js";
import { DEFAULT_MUTATION_MARKER, packageVersion, tokenExpiryWarning } from "./config.js";
import { EBoekhoudenApiError, ValidationError } from "./errors.js";
import { createMutation } from "./mutations.js";
import { createRelation, updateRelation } from "./relations.js";
import {
  createMutationInput,
  createRelationInput,
  id,
  isoDate,
  MUTATION_TYPE_NAMES,
  MUTATION_TYPES,
  paging,
  updateRelationInput,
} from "./schemas.js";
import { VAT_CODES } from "./vat.js";
import { vatQuarterSummary } from "./vatSummary.js";

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function toolError(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof EBoekhoudenApiError) text = err.toUserMessage();
  else if (err instanceof ValidationError)
    text = `${err.message}\nNothing was sent to e-Boekhouden.`;
  else text = "Unexpected error while calling e-Boekhouden. Check the server stderr output.";
  return { isError: true, content: [{ type: "text", text }] };
}

async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    if (!(err instanceof EBoekhoudenApiError) && !(err instanceof ValidationError)) {
      // Only the error class: never request data, administration data or tokens.
      console.error(`[mcp-eboekhouden] unexpected ${err instanceof Error ? err.name : "error"}`);
    }
    return toolError(err);
  }
}

/** Translates an optional from/to pair into an e-Boekhouden date filter. */
export function dateFilter(field: string, from?: string, to?: string): Query {
  if (from && to) return { [`${field}[range]`]: `${from},${to}` };
  if (from) return { [`${field}[gte]`]: from };
  if (to) return { [`${field}[lte]`]: to };
  return {};
}

/**
 * Builds a substring filter value for `[like]`. e-Boekhouden treats `[...]` as
 * a character class (SQL Server LIKE), so `[` is escaped as `[[]`; otherwise a
 * search for "[claude]" matches almost every description.
 */
export function like(value: string | undefined): string | undefined {
  return value === undefined ? undefined : `%${value.replaceAll("[", "[[]")}%`;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

export interface ServerOptions {
  tokenExpiresAt?: Date | undefined;
  /** Marker added to mutation descriptions (default: DEFAULT_MUTATION_MARKER). */
  marker?: string;
  now?: () => Date;
}

export function createServer(
  client: EBoekhoudenClient,
  audit: AuditLogger,
  options: ServerOptions = {},
): McpServer {
  const server = new McpServer({ name: "mcp-eboekhouden", version: packageVersion() });
  const marker = options.marker ?? DEFAULT_MUTATION_MARKER;
  const now = options.now ?? (() => new Date());

  /** Runs a tool and appends a warning when the API token is about to expire. */
  const run = async (fn: () => Promise<unknown>): Promise<CallToolResult> => {
    const result = await runTool(fn);
    const warning = tokenExpiryWarning(options.tokenExpiresAt, now());
    if (warning) result.content.push({ type: "text", text: warning });
    return result;
  };

  // ---------------------------------------------------------------- read tools

  server.registerTool(
    "list_mutations",
    {
      title: "List mutations",
      description:
        "List bookkeeping mutations (boekingen) in e-Boekhouden. Filter by type, date range, invoice number or description text. Returns id, type, date, invoice number, ledger and amount per mutation.",
      inputSchema: {
        type: z.enum(MUTATION_TYPE_NAMES).optional().describe("Only this mutation type."),
        dateFrom: isoDate.optional().describe("Start date (inclusive, YYYY-MM-DD)."),
        dateTo: isoDate.optional().describe("End date (inclusive, YYYY-MM-DD)."),
        invoiceNumber: z.string().max(50).optional().describe("Exact invoice number."),
        descriptionContains: z
          .string()
          .max(50)
          .optional()
          .describe("Text the description contains."),
        ...paging,
      },
      annotations: READ_ONLY,
    },
    (args) =>
      run(() =>
        client.get("/v1/mutation", {
          type: args.type ? MUTATION_TYPES[args.type] : undefined,
          invoiceNumber: args.invoiceNumber,
          "description[like]": like(args.descriptionContains),
          ...dateFilter("date", args.dateFrom, args.dateTo),
          limit: args.limit,
          offset: args.offset,
        }),
      ),
  );

  server.registerTool(
    "get_mutation",
    {
      title: "Get mutation",
      description: "Get one mutation by its ID, including rows, VAT codes and VAT totals per code.",
      inputSchema: { id: id.describe("Mutation ID.") },
      annotations: READ_ONLY,
    },
    (args) => run(() => client.get(`/v1/mutation/${args.id}`)),
  );

  server.registerTool(
    "list_relations",
    {
      title: "List relations",
      description:
        "List relations (customers and suppliers). Optionally filter by name or code (substring match), type, e-mail or city. Returns id, type and code per relation.",
      inputSchema: {
        nameContains: z.string().max(100).optional().describe("Text the (company) name contains."),
        codeContains: z.string().max(15).optional().describe("Text the relation code contains."),
        type: z.enum(["B", "P"]).optional().describe("Business (B) or private (P)."),
        email: z.string().max(150).optional().describe("Exact e-mail address."),
        city: z.string().max(50).optional().describe("Exact primary city."),
        ...paging,
      },
      annotations: READ_ONLY,
    },
    (args) =>
      run(() =>
        client.get("/v1/relation", {
          "name[like]": like(args.nameContains),
          "code[like]": like(args.codeContains),
          type: args.type,
          email: args.email,
          city: args.city,
          limit: args.limit,
          offset: args.offset,
        }),
      ),
  );

  server.registerTool(
    "get_relation",
    {
      title: "Get relation",
      description:
        "Get one relation (customer or supplier) by ID with name, contact details, VAT number, IBAN and default ledger.",
      inputSchema: { id: id.describe("Relation ID.") },
      annotations: READ_ONLY,
    },
    (args) => run(() => client.get(`/v1/relation/${args.id}`)),
  );

  server.registerTool(
    "list_ledgers",
    {
      title: "List ledgers",
      description:
        "List ledger accounts (grootboekrekeningen) with id, code, description and category (BAL, VW, FIN, DEB, CRED, AF6, AF19, AFOVERIG, VOOR, BTWRC). Use the id in create_mutation.",
      inputSchema: {
        code: z.string().max(10).optional().describe("Exact ledger code."),
        category: z
          .enum(["BAL", "VW", "AF6", "AF19", "AFOVERIG", "VOOR", "BTWRC", "FIN", "DEB", "CRED"])
          .optional()
          .describe("Only ledgers of this category."),
        ...paging,
      },
      annotations: READ_ONLY,
    },
    (args) =>
      run(() =>
        client.get("/v1/ledger", {
          code: args.code,
          category: args.category,
          limit: args.limit,
          offset: args.offset,
        }),
      ),
  );

  server.registerTool(
    "list_vat_codes",
    {
      title: "List VAT codes",
      description:
        "List the Dutch VAT codes accepted by create_mutation, with rate and whether they are sales, purchase or reverse-charge codes. Taken from the e-Boekhouden API documentation (the API has no VAT code endpoint).",
      inputSchema: {},
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    () =>
      run(() => Promise.resolve({ source: "e-Boekhouden API documentation", vatCodes: VAT_CODES })),
  );

  server.registerTool(
    "get_ledger_balance",
    {
      title: "Get ledger balance",
      description:
        "Get the balance of one ledger. Without dateFrom it is the balance up to dateTo (or today); with dateFrom it is the movement over the period.",
      inputSchema: {
        ledgerId: id.describe("Ledger ID."),
        dateFrom: isoDate.optional().describe("Start date (YYYY-MM-DD)."),
        dateTo: isoDate.optional().describe("End date, inclusive (YYYY-MM-DD)."),
        costCenterId: id.optional().describe("Only this cost center."),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      run(() =>
        client.get(`/v1/ledger/${args.ledgerId}/balance`, {
          from: args.dateFrom,
          to: args.dateTo,
          costCenterId: args.costCenterId,
        }),
      ),
  );

  server.registerTool(
    "list_cost_centers",
    {
      title: "List cost centers",
      description:
        "List cost centers (kostenplaatsen) with id, description, parent id and whether they are active. Use the id as costCenterId on create_mutation rows.",
      inputSchema: {
        descriptionContains: z
          .string()
          .max(100)
          .optional()
          .describe("Text the description contains."),
        ...paging,
      },
      annotations: READ_ONLY,
    },
    (args) =>
      run(() =>
        client.get("/v1/costcenter", {
          "description[like]": like(args.descriptionContains),
          limit: args.limit,
          offset: args.offset,
        }),
      ),
  );

  server.registerTool(
    "list_outstanding_invoices",
    {
      title: "List outstanding invoices",
      description:
        "List invoices that are not fully paid: purchase invoices (side 'creditors') or sales invoices (side 'debtors'). Returns mutation id, invoice number, relation, total, paid and outstanding amount. Use before booking invoice_payment_received / invoice_payment_sent.",
      inputSchema: {
        side: z
          .enum(["creditors", "debtors"])
          .describe("creditors = purchase invoices to pay, debtors = sales invoices to receive."),
        invoiceNumber: z.string().max(50).optional().describe("Exact invoice number."),
        ...paging,
      },
      annotations: READ_ONLY,
    },
    (args) =>
      run(() =>
        client.get("/v1/mutation/invoice/outstanding", {
          credDeb: args.side === "creditors" ? "C" : "D",
          invoiceNumber: args.invoiceNumber,
          limit: args.limit,
          offset: args.offset,
        }),
      ),
  );

  server.registerTool(
    "vat_quarter_summary",
    {
      title: "VAT quarter control overview",
      description:
        "Control overview of VAT for one quarter: VAT per code, total sales VAT, deductible input VAT and the resulting amount payable or refundable, plus VAT ledger balances as a cross-check. This is NOT a VAT return.",
      inputSchema: {
        year: z.number().int().min(2000).max(2100).describe("Year, e.g. 2026."),
        quarter: z.number().int().min(1).max(4).describe("Quarter 1-4."),
      },
      annotations: READ_ONLY,
    },
    (args) => run(() => vatQuarterSummary(client, args.year, args.quarter)),
  );

  // --------------------------------------------------------------- write tools

  server.registerTool(
    "create_mutation",
    {
      title: "Create mutation",
      description: [
        "Create a bookkeeping mutation in e-Boekhouden.",
        "Types: invoice_received (purchase invoice), invoice_sent (sales invoice), invoice_payment_received, invoice_payment_sent, money_received, money_sent, general_journal (memoriaal).",
        `Every description (header and rows) gets the marker '${marker}' unless it already contains it.`,
        "Ledgers, relations, VAT codes, amounts and the date are validated before anything is sent.",
        "If a matching mutation already exists (same type, date, relation, total amount and invoice number, or description when there is no invoice number) it is returned instead of creating a new one.",
        "If another mutation has the same type, date, relation and amount but a different invoice number or description (for example one entered by hand), the call is rejected as a possible duplicate; only after checking it, call again with confirmNotDuplicate: true.",
        "Existing mutations cannot be changed or deleted through this server.",
      ].join(" "),
      inputSchema: createMutationInput.shape,
      annotations: { ...WRITE, idempotentHint: true },
    },
    (args) => run(() => createMutation(client, audit, args, { marker })),
  );

  server.registerTool(
    "create_relation",
    {
      title: "Create relation",
      description:
        "Create a relation (customer or supplier) in e-Boekhouden. Only name is required; the code is generated when omitted.",
      inputSchema: createRelationInput.shape,
      annotations: WRITE,
    },
    (args) => run(() => createRelation(client, audit, args)),
  );

  server.registerTool(
    "update_relation",
    {
      title: "Update relation",
      description:
        "Update fields of an existing relation. Only the fields you pass are changed; the current name is kept when name is omitted.",
      inputSchema: updateRelationInput.shape,
      annotations: { ...WRITE, idempotentHint: true },
    },
    (args) => run(() => updateRelation(client, audit, args)),
  );

  return server;
}

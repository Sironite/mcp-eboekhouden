import type { AuditLogger } from "./audit.js";
import type { EBoekhoudenClient } from "./client.js";
import { MUTATION_DESCRIPTION_MAX, MUTATION_MARKER } from "./config.js";
import { EBoekhoudenApiError, ValidationError } from "./errors.js";
import { createMutationInput, MUTATION_TYPES, type CreateMutationInput } from "./schemas.js";
import { VAT_CODES_WITH_AMOUNT, vatCodeInfo } from "./vat.js";

/** Mutation detail as returned by GET /v1/mutation/{id}. */
export interface MutationDetail {
  id: number;
  type: string | number;
  date: string;
  description?: string | null;
  ledgerId?: number | null;
  relationId?: number | null;
  inExVat?: string | null;
  invoiceNumber?: string | null;
  entryNumber?: string | null;
  rows?: {
    ledgerId?: number | null;
    vatCode?: string | null;
    vatAmount?: number | null;
    amount?: number | null;
    description?: string | null;
    invoiceNumber?: string | null;
    relationId?: number | null;
  }[];
  vat?: { vatCode?: string | null; amount?: number | null }[];
}

interface MutationListItem {
  id: number;
}

interface Ledger {
  id: number;
  code?: string;
  description?: string;
  category?: string;
}

interface Relation {
  id: number;
  inactive?: boolean | null;
}

export type CreateMutationResult =
  | { status: "created"; mutationId: number; description: string }
  | { status: "duplicate"; mutationId: number; description: string; message: string };

const PAYMENT_TYPES = new Set<number>([
  MUTATION_TYPES.invoice_payment_received,
  MUTATION_TYPES.invoice_payment_sent,
]);
/** Types 1, 2, 5, 6: row ledgers may not be FIN, CRED or DEB (per API docs). */
const RESTRICTED_ROW_LEDGER_TYPES = new Set([1, 2, 5, 6]);
const RESTRICTED_ROW_CATEGORIES = new Set(["FIN", "CRED", "DEB"]);

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Maximum length of a row description, including the marker (own limit; the API documents none). */
const ROW_DESCRIPTION_MAX = 200;

/** Adds the marker in front unless the text already contains it (at the start or the end). */
export function markedDescription(description: string | undefined): string {
  const text = description?.trim() ?? "";
  if (text.includes(MUTATION_MARKER)) return text;
  return text.length > 0 ? `${MUTATION_MARKER} ${text}` : MUTATION_MARKER;
}

/** Checks that need no API call. Returns a list of problems (empty when valid). */
export function validateMutationLocally(input: CreateMutationInput): string[] {
  const issues: string[] = [];
  const type = MUTATION_TYPES[input.type];

  const description = markedDescription(input.description);
  if (description.length > MUTATION_DESCRIPTION_MAX) {
    issues.push(
      `description is too long: with the '${MUTATION_MARKER} ' prefix it is ${description.length} characters, max is ${MUTATION_DESCRIPTION_MAX}`,
    );
  }

  input.rows.forEach((row, i) => {
    const at = `rows[${i}]`;
    if (markedDescription(row.description ?? input.description).length > ROW_DESCRIPTION_MAX) {
      issues.push(`${at}.description is too long with the marker (max ${ROW_DESCRIPTION_MAX})`);
    }
    const vat = vatCodeInfo(row.vatCode);
    if (!PAYMENT_TYPES.has(type) && row.ledgerId === undefined) {
      issues.push(`${at}.ledgerId is required for type ${input.type}`);
    }
    if (PAYMENT_TYPES.has(type) && !row.invoiceNumber) {
      issues.push(`${at}.invoiceNumber is required for type ${input.type}`);
    }
    if (row.vatAmount !== undefined && !VAT_CODES_WITH_AMOUNT.includes(row.vatCode)) {
      issues.push(`${at}.vatAmount is only allowed with vatCode AFW or AFW_VERK`);
    }
    if (type === MUTATION_TYPES.invoice_received && vat?.kind === "sale") {
      issues.push(
        `${at}.vatCode ${row.vatCode} is a sales code; invoice_received needs a purchase code or GEEN`,
      );
    }
    if (type === MUTATION_TYPES.invoice_sent && vat?.kind === "purchase") {
      issues.push(
        `${at}.vatCode ${row.vatCode} is a purchase code; invoice_sent needs a sales code or GEEN`,
      );
    }
    if (vat?.requiresEx && input.inExVat !== "EX") {
      issues.push(`${at}.vatCode ${row.vatCode} (domestic reverse charge) requires inExVat EX`);
    }
  });

  return issues;
}

async function fetchOrNull<T>(client: EBoekhoudenClient, path: string): Promise<T | null> {
  try {
    return await client.get<T>(path);
  } catch (err) {
    if (err instanceof EBoekhoudenApiError && err.status === 404) return null;
    throw err;
  }
}

/** Checks ledgers and relations against the administration. */
export async function validateMutationRemotely(
  client: EBoekhoudenClient,
  input: CreateMutationInput,
): Promise<string[]> {
  const issues: string[] = [];
  const type = MUTATION_TYPES[input.type];

  const ledgerIds = new Set([
    input.ledgerId,
    ...input.rows.flatMap((r) => (r.ledgerId ? [r.ledgerId] : [])),
  ]);
  const ledgers = new Map<number, Ledger | null>();
  for (const ledgerId of ledgerIds) {
    ledgers.set(ledgerId, await fetchOrNull<Ledger>(client, `/v1/ledger/${ledgerId}`));
  }
  if (!ledgers.get(input.ledgerId)) issues.push(`ledgerId ${input.ledgerId} does not exist`);

  input.rows.forEach((row, i) => {
    if (row.ledgerId === undefined) return;
    const ledger = ledgers.get(row.ledgerId);
    if (!ledger) {
      issues.push(`rows[${i}].ledgerId ${row.ledgerId} does not exist`);
    } else if (
      RESTRICTED_ROW_LEDGER_TYPES.has(type) &&
      ledger.category &&
      RESTRICTED_ROW_CATEGORIES.has(ledger.category)
    ) {
      issues.push(
        `rows[${i}].ledgerId ${row.ledgerId} has category ${ledger.category}, which is not allowed on rows for type ${input.type}`,
      );
    }
  });

  const relationIds = new Set([
    ...(input.relationId ? [input.relationId] : []),
    ...input.rows.flatMap((r) => (r.relationId ? [r.relationId] : [])),
  ]);
  for (const relationId of relationIds) {
    const relation = await fetchOrNull<Relation>(client, `/v1/relation/${relationId}`);
    if (!relation) issues.push(`relationId ${relationId} does not exist`);
    else if (relation.inactive === true) issues.push(`relationId ${relationId} is inactive`);
  }

  return issues;
}

function totalOf(rows: { amount?: number | null }[] | undefined): number {
  return round2((rows ?? []).reduce((sum, r) => sum + (r.amount ?? 0), 0));
}

function sameOptional<T>(a: T | null | undefined, b: T | null | undefined): boolean {
  const norm = (v: T | null | undefined) =>
    v === null || v === undefined || v === 0 || v === "" ? undefined : v;
  return norm(a) === norm(b);
}

export interface DuplicateCheck {
  /** Existing mutation that matches the request exactly; nothing should be created. */
  exact: MutationDetail | null;
  /** Same type, date, relation and total amount, but a different invoice number or description. */
  possible: MutationDetail[];
}

/**
 * Compares the request with all mutations of the same type on the same date,
 * including mutations entered by hand in e-Boekhouden.
 *
 * Exact match with an invoice number: same type, date, invoice number, relation and total.
 * Exact match without: same type, date, relation, total and (marked) description.
 * Possible duplicate: same type, date, relation and total, otherwise different.
 */
export async function checkDuplicates(
  client: EBoekhoudenClient,
  input: CreateMutationInput,
  description: string,
): Promise<DuplicateCheck> {
  const type = MUTATION_TYPES[input.type];
  const candidates = await client.getAll<MutationListItem>("/v1/mutation", {
    type,
    date: input.date,
  });
  const total = totalOf(input.rows);
  const result: DuplicateCheck = { exact: null, possible: [] };

  for (const candidate of candidates) {
    const detail = await client.get<MutationDetail>(`/v1/mutation/${candidate.id}`);
    const sameCore =
      Number(detail.type) === type &&
      detail.date.slice(0, 10) === input.date &&
      sameOptional(detail.relationId, input.relationId) &&
      totalOf(detail.rows) === total;
    if (!sameCore) continue;
    const sameIdentity = input.invoiceNumber
      ? detail.invoiceNumber === input.invoiceNumber
      : (detail.description ?? "").trim() === description;
    if (sameIdentity) {
      result.exact = detail;
      return result;
    }
    result.possible.push(detail);
  }
  return result;
}

export function toApiPayload(
  input: CreateMutationInput,
  description: string,
): Record<string, unknown> {
  return {
    type: MUTATION_TYPES[input.type],
    date: input.date,
    ledgerId: input.ledgerId,
    relationId: input.relationId,
    invoiceNumber: input.invoiceNumber,
    description,
    inExVat: input.inExVat,
    termOfPayment: input.termOfPayment,
    paymentReference: input.paymentReference,
    rows: input.rows.map((row) => ({
      ledgerId: row.ledgerId,
      vatCode: row.vatCode,
      amount: row.amount,
      vatAmount: row.vatAmount,
      // Rows carry the marker too; without a row description the header text is used.
      description: markedDescription(row.description ?? input.description),
      invoiceNumber: row.invoiceNumber,
      relationId: row.relationId,
      costCenterId: row.costCenterId,
    })),
  };
}

export async function createMutation(
  client: EBoekhoudenClient,
  audit: AuditLogger,
  rawInput: unknown,
): Promise<CreateMutationResult> {
  const parsed = createMutationInput.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
    await audit.write({ tool: "create_mutation", outcome: "rejected", payload: rawInput });
    throw new ValidationError(issues);
  }
  const input = parsed.data;
  const description = markedDescription(input.description);

  try {
    const issues = validateMutationLocally(input);
    if (issues.length === 0) issues.push(...(await validateMutationRemotely(client, input)));
    if (issues.length > 0) throw new ValidationError(issues);

    const { exact: duplicate, possible } = await checkDuplicates(client, input, description);
    if (!duplicate && possible.length > 0 && input.confirmNotDuplicate !== true) {
      const list = possible
        .map((m) => `#${m.id} (${m.invoiceNumber || m.description || "no description"})`)
        .join(", ");
      throw new ValidationError([
        `Possible duplicate: mutation ${list} has the same type, date, relation and total amount. Check it in e-Boekhouden; if this is really a separate booking, call again with confirmNotDuplicate: true.`,
      ]);
    }
    if (duplicate) {
      await audit.write({
        tool: "create_mutation",
        outcome: "duplicate",
        payload: input,
        mutationId: duplicate.id,
      });
      return {
        status: "duplicate",
        mutationId: duplicate.id,
        description: duplicate.description ?? description,
        message: "A matching mutation already exists; nothing was created.",
      };
    }

    const created = await client.post<{ id: number }>(
      "/v1/mutation",
      toApiPayload(input, description),
    );
    await audit.write({
      tool: "create_mutation",
      outcome: "created",
      payload: input,
      mutationId: created.id,
    });
    return { status: "created", mutationId: created.id, description };
  } catch (err) {
    await audit.write({
      tool: "create_mutation",
      outcome: err instanceof ValidationError ? "rejected" : "error",
      payload: input,
      errorCode: err instanceof EBoekhoudenApiError ? err.code : undefined,
    });
    throw err;
  }
}

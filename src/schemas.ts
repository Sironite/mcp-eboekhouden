import { z } from "zod";
import { VAT_CODE_VALUES } from "./vat.js";

export const MUTATION_TYPES = {
  invoice_received: 1,
  invoice_sent: 2,
  invoice_payment_received: 3,
  invoice_payment_sent: 4,
  money_received: 5,
  money_sent: 6,
  general_journal: 7,
} as const;

export type MutationTypeName = keyof typeof MUTATION_TYPES;
export const MUTATION_TYPE_NAMES = Object.keys(MUTATION_TYPES) as [
  MutationTypeName,
  ...MutationTypeName[],
];

export function mutationTypeName(value: string | number): MutationTypeName | undefined {
  const n = Number(value);
  return MUTATION_TYPE_NAMES.find((name) => MUTATION_TYPES[name] === n);
}

function isCalendarDate(value: string): boolean {
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
  .refine(isCalendarDate, "Date is not a valid calendar date")
  .refine((v) => {
    const year = Number(v.slice(0, 4));
    return year >= 2000 && year <= new Date().getUTCFullYear() + 1;
  }, "Date year is out of range (2000 up to next year)");

export const id = z.number().int().positive().max(2_147_483_647);

/** Money amount in euros: finite, at most 2 decimals, within a sane range. */
export const amount = z
  .number()
  .refine((v) => Math.abs(v) <= 1_000_000_000, "Amount is out of range")
  .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6, "Amount has more than 2 decimals");

export const paging = {
  limit: z.number().int().min(1).max(2000).optional().describe("Max items (1-2000, default 100)."),
  offset: z.number().int().min(0).optional().describe("Items to skip (default 0)."),
};

/** Rejects ASCII control characters except tab, line feed and carriage return. */
function hasNoControlChars(value: string): boolean {
  for (const ch of value) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return false;
  }
  return true;
}

const safeText = (max: number) =>
  z.string().max(max).refine(hasNoControlChars, "Control characters are not allowed");

// ---------------------------------------------------------------------------
// Mutations

export const mutationRow = z.object({
  ledgerId: id
    .optional()
    .describe(
      "Ledger (grootboekrekening) ID of the row. Required for all types except invoice payments.",
    ),
  vatCode: z.enum(VAT_CODE_VALUES).describe("VAT code of the row. See list_vat_codes."),
  amount: amount
    .refine((v) => v !== 0, "Row amount must not be 0")
    .describe("Row amount in EUR, including or excluding VAT according to inExVat."),
  vatAmount: amount
    .optional()
    .describe("Explicit VAT amount. Only allowed with vatCode AFW or AFW_VERK."),
  description: safeText(200).optional().describe("Row description."),
  invoiceNumber: safeText(50)
    .optional()
    .describe("Invoice being paid. Required for invoice_payment_received / invoice_payment_sent."),
  relationId: id.optional().describe("Relation ID for this row."),
  costCenterId: id.optional().describe("Cost center ID for this row."),
});

export const createMutationInput = z.object({
  type: z.enum(MUTATION_TYPE_NAMES).describe("Mutation type."),
  date: isoDate.describe("Booking date (YYYY-MM-DD)."),
  ledgerId: id.describe(
    "Ledger ID of the mutation itself, e.g. the bank account for money_received/money_sent or the debtors/creditors ledger for invoices.",
  ),
  relationId: id.optional().describe("Relation (customer/supplier) ID."),
  invoiceNumber: safeText(50).optional().describe("Invoice number (max 50 chars)."),
  description: safeText(50)
    .optional()
    .describe(
      "Description. The server prefixes it with '[claude] '; the combined text must fit in 50 characters.",
    ),
  inExVat: z.enum(["IN", "EX"]).describe("Whether row amounts include (IN) or exclude (EX) VAT."),
  termOfPayment: z.number().int().min(0).max(999).optional().describe("Payment term in days."),
  paymentReference: safeText(50).optional().describe("Payment reference."),
  rows: z.array(mutationRow).min(1).max(100).describe("Mutation rows (at least one)."),
  confirmNotDuplicate: z
    .boolean()
    .optional()
    .describe(
      "Set to true only after checking that a reported possible duplicate (same type, date, relation and amount) is really a different booking.",
    ),
});

export type CreateMutationInput = z.infer<typeof createMutationInput>;

// ---------------------------------------------------------------------------
// Relations

const relationFields = {
  type: z.enum(["B", "P"]).optional().describe("Business (B) or private person (P)."),
  code: safeText(15).optional().describe("Relation code (max 15)."),
  contact: safeText(50).optional(),
  salutation: safeText(50).optional(),
  gender: z.enum(["m", "v", "a"]).optional().describe("m = male, v = female, a = department."),
  address: safeText(150).optional(),
  postalCode: safeText(50).optional(),
  city: safeText(50).optional(),
  country: safeText(50).optional(),
  address2: safeText(150).optional(),
  postalCode2: safeText(50).optional(),
  city2: safeText(50).optional(),
  country2: safeText(50).optional(),
  phoneNumber: safeText(50).optional(),
  mobilePhoneNumber: safeText(50).optional(),
  emailAddress: z.email().max(150).optional(),
  emailAddressInvoice: z.email().max(150).optional(),
  emailAddressReminder: z.email().max(150).optional(),
  website: safeText(50).optional(),
  note: safeText(40000).optional(),
  vatNumber: safeText(50).optional(),
  companyRegistrationNumber: z
    .string()
    .regex(/^\d{1,50}$/, "Company registration number must be numeric")
    .optional()
    .describe("KVK number (digits only)."),
  iban: z
    .string()
    .max(50)
    .regex(/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/, "IBAN must be uppercase without spaces")
    .optional(),
  bic: safeText(20).optional(),
  termOfPayment: z.number().int().min(0).max(999).optional().describe("Payment term in days."),
  inactive: z.boolean().optional(),
  ledgerId: id.optional().describe("Default ledger ID (category BAL or VW)."),
};

export const createRelationInput = z.object({
  name: safeText(100).min(1).describe("(Company) name."),
  ...relationFields,
});

export const updateRelationInput = z.object({
  id: id.describe("Relation ID to update."),
  name: safeText(100).min(1).optional().describe("(Company) name."),
  ...relationFields,
});

export type CreateRelationInput = z.infer<typeof createRelationInput>;
export type UpdateRelationInput = z.infer<typeof updateRelationInput>;

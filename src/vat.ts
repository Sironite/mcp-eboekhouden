/**
 * NL VAT codes accepted by POST /v1/mutation (the `VatCode` enum in the official
 * OpenAPI spec). The API has no endpoint to list VAT codes, so this table is
 * taken from the documentation.
 *
 * - `kind`: `sale` codes are owed VAT, `purchase` codes are deductible input VAT.
 * - `reverseCharge`: VAT is shifted. On purchases the VAT is both owed and
 *   deductible; e-Boekhouden books it on the VAT ledgers but reports 0 VAT for
 *   the row in GET /v1/mutation/{id} (observed for BI_EU_INK).
 * - `rate`: VAT percentage; for reverse-charge purchases the rate e-Boekhouden
 *   uses to compute the shifted VAT (21% confirmed for BI_EU_INK).
 * - `returnBox`: box (rubriek) of the Dutch VAT return the code feeds into.
 *   Purchase codes feed box 5b with their input VAT.
 * - `requiresEx`: row amounts must be excluding VAT (MUT_026).
 */
export const VAT_CODES = [
  {
    code: "HOOG_VERK_21",
    kind: "sale",
    rate: 21,
    reverseCharge: false,
    returnBox: "1a",
    requiresEx: false,
    description: "Sale, 21% VAT",
  },
  {
    code: "LAAG_VERK_9",
    kind: "sale",
    rate: 9,
    reverseCharge: false,
    returnBox: "1b",
    requiresEx: false,
    description: "Sale, 9% VAT",
  },
  {
    code: "VERL_VERK",
    kind: "sale",
    rate: 21,
    reverseCharge: true,
    returnBox: "1e",
    requiresEx: false,
    description: "Sale, VAT reverse-charged to the customer (21%)",
  },
  {
    code: "VERL_VERK_L9",
    kind: "sale",
    rate: 9,
    reverseCharge: true,
    returnBox: "1e",
    requiresEx: false,
    description: "Sale, VAT reverse-charged to the customer (9%)",
  },
  {
    code: "AFW_VERK",
    kind: "sale",
    rate: null,
    reverseCharge: false,
    returnBox: null,
    requiresEx: false,
    description: "Sale, unspecified VAT percentage (requires vatAmount)",
  },
  {
    code: "BU_EU_VERK",
    kind: "sale",
    rate: 0,
    reverseCharge: false,
    returnBox: "3a",
    requiresEx: false,
    description: "Sale, deliveries outside the EU, 0% VAT",
  },
  {
    code: "BI_EU_VERK",
    kind: "sale",
    rate: 0,
    reverseCharge: false,
    returnBox: "3b",
    requiresEx: false,
    description: "Sale, goods inside the EU, 0% VAT",
  },
  {
    code: "BI_EU_VERK_D",
    kind: "sale",
    rate: 0,
    reverseCharge: false,
    returnBox: "3b",
    requiresEx: false,
    description: "Sale, services inside the EU, 0% VAT",
  },
  {
    code: "AFST_VERK",
    kind: "sale",
    rate: 0,
    reverseCharge: false,
    returnBox: "3c",
    requiresEx: false,
    description: "Sale, distance sales inside the EU, 0% VAT",
  },
  {
    code: "HOOG_INK_21",
    kind: "purchase",
    rate: 21,
    reverseCharge: false,
    returnBox: "5b",
    requiresEx: false,
    description: "Purchase, 21% VAT",
  },
  {
    code: "LAAG_INK_9",
    kind: "purchase",
    rate: 9,
    reverseCharge: false,
    returnBox: "5b",
    requiresEx: false,
    description: "Purchase, 9% VAT",
  },
  {
    code: "VERL_INK",
    kind: "purchase",
    rate: 21,
    reverseCharge: true,
    returnBox: "2a",
    requiresEx: true,
    description: "Purchase, domestic reverse charge 21% (amounts must be EX)",
  },
  {
    code: "AFW",
    kind: "purchase",
    rate: null,
    reverseCharge: false,
    returnBox: "5b",
    requiresEx: false,
    description: "Purchase, unspecified VAT percentage (requires vatAmount)",
  },
  {
    code: "BU_EU_INK",
    kind: "purchase",
    rate: 21,
    reverseCharge: true,
    returnBox: "4a",
    requiresEx: false,
    description: "Purchase of goods/services from outside the EU, VAT reverse-charged",
  },
  {
    code: "BI_EU_INK",
    kind: "purchase",
    rate: 21,
    reverseCharge: true,
    returnBox: "4b",
    requiresEx: false,
    description: "Purchase of goods/services from inside the EU, VAT reverse-charged (21%)",
  },
  {
    code: "GEEN",
    kind: "none",
    rate: 0,
    reverseCharge: false,
    returnBox: null,
    requiresEx: false,
    description: "No VAT",
  },
] as const;

export type VatCodeInfo = (typeof VAT_CODES)[number];
export type VatCode = VatCodeInfo["code"];

export const VAT_CODE_VALUES = VAT_CODES.map((v) => v.code) as [VatCode, ...VatCode[]];

const byCode = new Map<string, VatCodeInfo>(VAT_CODES.map((v) => [v.code, v]));

export function vatCodeInfo(code: string): VatCodeInfo | undefined {
  return byCode.get(code);
}

/**
 * Reverse-charge purchase codes whose VAT rate in e-Boekhouden has been
 * confirmed against real bookings and a filed VAT return (BI_EU_INK).
 * For BU_EU_INK and VERL_INK the 21% is an assumption.
 */
export const VERIFIED_REVERSE_CHARGE_CODES: readonly VatCode[] = ["BI_EU_INK"];

/** VAT codes that require an explicit `vatAmount` on the row (MUTA_003). */
export const VAT_CODES_WITH_AMOUNT: readonly VatCode[] = ["AFW", "AFW_VERK"];

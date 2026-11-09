import type { EBoekhoudenClient } from "./client.js";
import { round2, type MutationDetail } from "./mutations.js";
import { VERIFIED_REVERSE_CHARGE_CODES, vatCodeInfo, type VatCodeInfo } from "./vat.js";

/** Ledger categories that hold VAT balances in e-Boekhouden. */
const VAT_LEDGER_CATEGORIES = new Set(["AF6", "AF19", "AFOVERIG", "VOOR", "BTWRC"]);

export interface VatCodeLine {
  vatCode: string;
  kind: string;
  returnBox: string | null;
  reverseCharge: boolean;
  /** Amount excluding VAT. */
  base: number;
  vat: number;
  /**
   * `estimated`: the API reported no VAT, so it was computed as base x rate.
   * `estimated_unverified`: same, but the rate for this code has not been
   * confirmed against real e-Boekhouden bookings.
   */
  vatSource: "api" | "estimated" | "estimated_unverified";
  mutations: number;
}

export interface VatQuarterSummary {
  label: string;
  period: { year: number; quarter: number; from: string; to: string };
  mutationsScanned: number;
  perVatCode: VatCodeLine[];
  /** Boxes 1a-4b with base and VAT, followed by 5a, 5b and 5g (VAT only). */
  perReturnBox: { box: string; base?: number; vat: number }[];
  totals: {
    owedVat: number;
    deductibleVat: number;
    balance: number;
    balanceMeaning: "payable" | "refundable" | "zero";
  };
  vatLedgerMutations: {
    id: number;
    date: string;
    type: number;
    description: string;
    amount: number;
  }[];
  vatLedgerBalances: {
    code: string;
    description?: string | undefined;
    category: string;
    balance: number;
  }[];
  notes: string[];
}

interface Ledger {
  id: number;
  code: string;
  description?: string;
  category?: string;
}

interface CodeAccumulator {
  info: VatCodeInfo | undefined;
  base: number;
  vat: number;
  estimated: boolean;
  mutationIds: Set<number>;
}

export function quarterRange(year: number, quarter: number): { from: string; to: string } {
  const startMonth = (quarter - 1) * 3;
  const from = new Date(Date.UTC(year, startMonth, 1));
  const to = new Date(Date.UTC(year, startMonth + 3, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

type Row = NonNullable<MutationDetail["rows"]>[number];

/** Row amount excluding VAT. */
function rowBase(row: Row, inExVat: string | null | undefined, info: VatCodeInfo | undefined) {
  const amount = row.amount ?? 0;
  if (inExVat !== "IN") return amount;
  if (typeof row.vatAmount === "number") return amount - row.vatAmount;
  if (info?.rate && !info.reverseCharge) return (amount * 100) / (100 + info.rate);
  return amount;
}

function touchesVatLedger(detail: MutationDetail, vatLedgerIds: Set<number>): boolean {
  if (detail.ledgerId && vatLedgerIds.has(detail.ledgerId)) return true;
  return (detail.rows ?? []).some((r) => r.ledgerId && vatLedgerIds.has(r.ledgerId));
}

/** Adds the base and VAT of one mutation to the per-code accumulators. */
function accumulate(detail: MutationDetail, perCode: Map<string, CodeAccumulator>): void {
  const entryFor = (code: string) => {
    let entry = perCode.get(code);
    if (!entry) {
      entry = {
        info: vatCodeInfo(code),
        base: 0,
        vat: 0,
        estimated: false,
        mutationIds: new Set(),
      };
      perCode.set(code, entry);
    }
    entry.mutationIds.add(detail.id);
    return entry;
  };

  const basePerCode = new Map<string, number>();
  for (const row of detail.rows ?? []) {
    if (!row.vatCode) continue;
    const base = rowBase(row, detail.inExVat, vatCodeInfo(row.vatCode));
    basePerCode.set(row.vatCode, (basePerCode.get(row.vatCode) ?? 0) + base);
    entryFor(row.vatCode).base += base;
  }

  const reportedVat = new Map<string, number>();
  for (const line of detail.vat ?? []) {
    if (line.vatCode) {
      reportedVat.set(line.vatCode, (reportedVat.get(line.vatCode) ?? 0) + (line.amount ?? 0));
    }
  }

  for (const code of new Set([...basePerCode.keys(), ...reportedVat.keys()])) {
    const entry = entryFor(code);
    const reported = reportedVat.get(code) ?? 0;
    const info = entry.info;
    if (reported === 0 && info?.kind === "purchase" && info.reverseCharge) {
      // The API reports 0 VAT for reverse-charged purchases, while e-Boekhouden
      // books base x rate on the VAT ledgers.
      entry.vat += round2(((basePerCode.get(code) ?? 0) * info.rate) / 100);
      entry.estimated = true;
    } else {
      entry.vat += reported;
    }
  }
}

/**
 * Builds a VAT check overview for a quarter, grouped by VAT code and by box of
 * the Dutch VAT return. Mutations that post directly on a VAT ledger (VAT
 * return processing, VAT payments and refunds) are listed separately and left
 * out of the totals. This is a control overview, not a VAT return.
 */
export async function vatQuarterSummary(
  client: EBoekhoudenClient,
  year: number,
  quarter: number,
): Promise<VatQuarterSummary> {
  const { from, to } = quarterRange(year, quarter);

  const ledgers = await client.getAll<Ledger>("/v1/ledger");
  const vatLedgers = ledgers.filter((l) => l.category && VAT_LEDGER_CATEGORIES.has(l.category));
  const vatLedgerIds = new Set(vatLedgers.map((l) => l.id));

  const list = await client.getAll<{ id: number }>("/v1/mutation", {
    "date[range]": `${from},${to}`,
  });

  const perCode = new Map<string, CodeAccumulator>();
  const vatLedgerMutations: VatQuarterSummary["vatLedgerMutations"] = [];
  for (const { id } of list) {
    const detail = await client.get<MutationDetail>(`/v1/mutation/${id}`);
    if (touchesVatLedger(detail, vatLedgerIds)) {
      vatLedgerMutations.push({
        id: detail.id,
        date: detail.date.slice(0, 10),
        type: Number(detail.type),
        description: detail.description ?? "",
        amount: round2((detail.rows ?? []).reduce((s, r) => s + (r.amount ?? 0), 0)),
      });
    } else {
      accumulate(detail, perCode);
    }
  }

  const perVatCode: VatCodeLine[] = [...perCode.entries()]
    .map(([vatCode, e]) => ({
      vatCode,
      kind: e.info?.kind ?? "unknown",
      returnBox: e.info?.returnBox ?? null,
      reverseCharge: e.info?.reverseCharge ?? false,
      base: round2(e.base),
      vat: round2(e.vat),
      vatSource: !e.estimated
        ? ("api" as const)
        : VERIFIED_REVERSE_CHARGE_CODES.some((c) => c === vatCode)
          ? ("estimated" as const)
          : ("estimated_unverified" as const),
      mutations: e.mutationIds.size,
    }))
    .sort((a, b) => a.vatCode.localeCompare(b.vatCode));

  const boxes = new Map<string, { base: number; vat: number }>();
  for (const line of perVatCode) {
    // Domestic input VAT only appears in box 5b, which is computed below.
    if (!line.returnBox || line.returnBox === "5b") continue;
    const box = boxes.get(line.returnBox) ?? { base: 0, vat: 0 };
    box.base += line.base;
    box.vat += line.vat;
    boxes.set(line.returnBox, box);
  }

  const sum = (pred: (l: VatCodeLine) => boolean) =>
    round2(perVatCode.filter(pred).reduce((s, l) => s + l.vat, 0));
  const reverseChargedPurchases = (l: VatCodeLine) => l.kind === "purchase" && l.reverseCharge;
  const owedVat = round2(
    sum((l) => l.kind === "sale" && !l.reverseCharge) + sum(reverseChargedPurchases),
  );
  const deductibleVat = sum((l) => l.kind === "purchase");
  const balance = round2(owedVat - deductibleVat);

  const perReturnBox: VatQuarterSummary["perReturnBox"] = [
    ...[...boxes.entries()]
      .map(([box, v]) => ({ box, base: round2(v.base), vat: round2(v.vat) }))
      .sort((a, b) => a.box.localeCompare(b.box)),
    { box: "5a", vat: owedVat },
    { box: "5b", vat: deductibleVat },
    { box: "5g", vat: balance },
  ];

  const vatLedgerByCode = new Map(vatLedgers.map((l) => [l.code, l]));
  const balances = await client.get<{ items?: { code: string; balance?: number }[] }>(
    "/v1/ledger/balances",
    { from, to },
  );
  const vatLedgerBalances = (balances.items ?? []).flatMap((b) => {
    const ledger = vatLedgerByCode.get(b.code);
    return ledger
      ? [
          {
            code: b.code,
            description: ledger.description,
            category: ledger.category ?? "",
            balance: round2(b.balance ?? 0),
          },
        ]
      : [];
  });

  const notes = [
    "CONTROL OVERVIEW ONLY - this is not a VAT return (geen btw-aangifte). Verify in e-Boekhouden before filing.",
    "Amounts are in euro cents; the VAT return rounds to whole euros.",
    "owedVat corresponds to box 5a (sales VAT plus reverse-charged VAT on purchases), deductibleVat to box 5b (input VAT including reverse-charged VAT). Corrections from earlier periods are not included.",
    "vatLedgerMutations post directly on a VAT ledger (VAT return processing, VAT payments and refunds) and are excluded from the totals.",
    "vatLedgerBalances show the movement on the VAT ledgers in this period, including vatLedgerMutations and rounding differences.",
  ];
  const unverified = perVatCode.filter((l) => l.vatSource === "estimated_unverified");
  if (unverified.length > 0) {
    notes.push(
      `UNVERIFIED: reverse-charged VAT for ${unverified.map((l) => l.vatCode).join(", ")} is assumed to be 21%; this has not been checked against e-Boekhouden. Compare with the VAT ledgers or the VAT return in e-Boekhouden.`,
    );
  }
  if (perVatCode.some((l) => l.vatSource !== "api")) {
    notes.push(
      "VAT marked 'estimated' is reverse-charged VAT: the API reports 0 for these rows, so it is computed as base x rate. e-Boekhouden books the actual amount on the VAT ledgers.",
    );
  }
  if (perVatCode.some((l) => l.kind === "unknown" || (l.kind !== "none" && !l.returnBox))) {
    notes.push(
      "Some VAT codes have no known return box (e.g. AFW_VERK or unknown codes); check them manually.",
    );
  }

  return {
    label: "VAT control overview (not a VAT return)",
    period: { year, quarter, from, to },
    mutationsScanned: list.length,
    perVatCode,
    perReturnBox,
    totals: {
      owedVat,
      deductibleVat,
      balance,
      balanceMeaning: balance > 0 ? "payable" : balance < 0 ? "refundable" : "zero",
    },
    vatLedgerMutations,
    vatLedgerBalances,
    notes,
  };
}

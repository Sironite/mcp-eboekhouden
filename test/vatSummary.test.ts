import { describe, expect, it } from "vitest";
import type { MutationDetail } from "../src/mutations.js";
import { quarterRange, vatQuarterSummary } from "../src/vatSummary.js";
import { fakeApi, json } from "./helpers.js";

const LEDGERS = [
  { id: 100, code: "1010", description: "Bank", category: "FIN" },
  { id: 101, code: "1600", description: "Voorbelasting", category: "VOOR" },
  { id: 102, code: "1630", description: "Btw af te dragen hoog", category: "AF19" },
  { id: 103, code: "1650", description: "Btw r/c", category: "BTWRC" },
  { id: 104, code: "1700", description: "Crediteuren", category: "CRED" },
  { id: 105, code: "1300", description: "Debiteuren", category: "DEB" },
  { id: 106, code: "4500", description: "Abonnementen", category: "VW" },
  { id: 107, code: "8000", description: "Omzet", category: "VW" },
];

/** Synthetic quarter: sales, purchases, an EU reverse-charge purchase and VAT settlements. */
const MUTATIONS: MutationDetail[] = [
  {
    id: 1,
    type: "2",
    date: "2026-07-10",
    ledgerId: 105,
    inExVat: "EX",
    rows: [{ ledgerId: 107, vatCode: "HOOG_VERK_21", vatAmount: 210, amount: 1000 }],
    vat: [{ vatCode: "HOOG_VERK_21", amount: 210 }],
  },
  {
    id: 2,
    type: "1",
    date: "2026-07-15",
    ledgerId: 104,
    inExVat: "IN",
    rows: [{ ledgerId: 106, vatCode: "HOOG_INK_21", vatAmount: 21, amount: 121 }],
    vat: [{ vatCode: "HOOG_INK_21", amount: 21 }],
  },
  {
    id: 3,
    type: "6",
    date: "2026-08-03",
    ledgerId: 100,
    inExVat: "IN",
    rows: [{ ledgerId: 106, vatCode: "HOOG_INK_21", vatAmount: 21, amount: 121 }],
    vat: [{ vatCode: "HOOG_INK_21", amount: 21 }],
  },
  {
    // EU service: the API reports 0 VAT, e-Boekhouden books 21% reverse charge.
    id: 4,
    type: "1",
    date: "2026-08-04",
    ledgerId: 104,
    inExVat: "EX",
    rows: [{ ledgerId: 106, vatCode: "BI_EU_INK", vatAmount: 0, amount: 50 }],
    vat: [{ vatCode: "BI_EU_INK", amount: 0 }],
  },
  {
    // Payment of an invoice: no VAT ledger, no VAT.
    id: 5,
    type: "4",
    date: "2026-08-07",
    ledgerId: 100,
    inExVat: "IN",
    rows: [{ vatCode: "GEEN", amount: 121, invoiceNumber: "X-1" }],
    vat: [{ vatCode: "GEEN", amount: 0 }],
  },
  {
    // VAT refund of the previous quarter received on the bank.
    id: 6,
    type: "5",
    date: "2026-07-20",
    ledgerId: 100,
    description: "BTW-teruggave Q2",
    inExVat: "IN",
    rows: [{ ledgerId: 103, vatCode: "GEEN", vatAmount: 0, amount: 22 }],
    vat: [{ vatCode: "GEEN", amount: 0 }],
  },
  {
    // VAT return processing: moves input VAT to the VAT current account.
    id: 7,
    type: "7",
    date: "2026-09-30",
    ledgerId: 103,
    description: "Btw-aangifte",
    inExVat: "IN",
    rows: [{ ledgerId: 101, vatCode: "GEEN", amount: 53 }],
    vat: [],
  },
];

function quarterApi() {
  return fakeApi((req) => {
    const path = req.url.pathname;
    if (path === "/v1/ledger") return json(200, { items: LEDGERS });
    if (path === "/v1/mutation") {
      return json(200, { items: MUTATIONS.map((m) => ({ id: m.id })) });
    }
    const m = /^\/v1\/mutation\/(\d+)$/.exec(path);
    if (m)
      return json(
        200,
        MUTATIONS.find((x) => x.id === Number(m[1])),
      );
    if (path === "/v1/ledger/balances") {
      return json(200, {
        items: [
          { code: "1600", balance: 0.5 },
          { code: "1630", balance: -0.5 },
          { code: "1650", balance: 31 },
          { code: "8000", balance: -1000 },
        ],
      });
    }
    return undefined;
  });
}

describe("vat_quarter_summary", () => {
  it("computes quarter boundaries", () => {
    expect(quarterRange(2026, 1)).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(quarterRange(2024, 1)).toEqual({ from: "2024-01-01", to: "2024-03-31" });
    expect(quarterRange(2026, 4)).toEqual({ from: "2026-10-01", to: "2026-12-31" });
  });

  it("labels the result as a control overview", async () => {
    const summary = await vatQuarterSummary(quarterApi().client, 2026, 3);
    expect(summary.label).toContain("not a VAT return");
    expect(summary.notes[0]).toContain("geen btw-aangifte");
    expect(summary.mutationsScanned).toBe(7);
  });

  it("includes reverse-charged VAT on EU purchases in both 5a and 5b", async () => {
    const summary = await vatQuarterSummary(quarterApi().client, 2026, 3);

    expect(summary.perVatCode.find((l) => l.vatCode === "BI_EU_INK")).toEqual({
      vatCode: "BI_EU_INK",
      kind: "purchase",
      returnBox: "4b",
      reverseCharge: true,
      base: 50,
      vat: 10.5,
      vatSource: "estimated",
      mutations: 1,
    });
    expect(summary.perVatCode.find((l) => l.vatCode === "HOOG_INK_21")).toMatchObject({
      base: 200,
      vat: 42,
      vatSource: "api",
      mutations: 2,
    });
    expect(summary.totals).toEqual({
      owedVat: 220.5,
      deductibleVat: 52.5,
      balance: 168,
      balanceMeaning: "payable",
    });
    expect(summary.notes.join(" ")).toContain("estimated");
  });

  it("groups amounts per VAT return box", async () => {
    const summary = await vatQuarterSummary(quarterApi().client, 2026, 3);
    expect(summary.perReturnBox).toEqual([
      { box: "1a", base: 1000, vat: 210 },
      { box: "4b", base: 50, vat: 10.5 },
      { box: "5a", vat: 220.5 },
      { box: "5b", vat: 52.5 },
      { box: "5g", vat: 168 },
    ]);
  });

  it("lists VAT ledger mutations separately and leaves them out of the totals", async () => {
    const summary = await vatQuarterSummary(quarterApi().client, 2026, 3);
    expect(summary.vatLedgerMutations).toEqual([
      { id: 6, date: "2026-07-20", type: 5, description: "BTW-teruggave Q2", amount: 22 },
      { id: 7, date: "2026-09-30", type: 7, description: "Btw-aangifte", amount: 53 },
    ]);
    expect(summary.perVatCode.find((l) => l.vatCode === "GEEN")?.mutations).toBe(1);
    expect(summary.vatLedgerBalances.map((b) => b.code)).toEqual(["1600", "1630", "1650"]);
  });

  it("marks reverse-charge estimates for codes not yet verified", async () => {
    const api = fakeApi((req) => {
      const path = req.url.pathname;
      if (path === "/v1/ledger") return json(200, { items: LEDGERS });
      if (path === "/v1/mutation") return json(200, { items: [{ id: 8 }] });
      if (path === "/v1/mutation/8") {
        return json(200, {
          id: 8,
          type: "1",
          date: "2026-07-02",
          ledgerId: 104,
          inExVat: "EX",
          rows: [{ ledgerId: 106, vatCode: "BU_EU_INK", vatAmount: 0, amount: 100 }],
          vat: [{ vatCode: "BU_EU_INK", amount: 0 }],
        });
      }
      if (path === "/v1/ledger/balances") return json(200, { items: [] });
      return undefined;
    });

    const summary = await vatQuarterSummary(api.client, 2026, 3);
    expect(summary.perVatCode[0]).toMatchObject({
      vatCode: "BU_EU_INK",
      returnBox: "4a",
      vat: 21,
      vatSource: "estimated_unverified",
    });
    expect(summary.notes.join(" ")).toContain("UNVERIFIED: reverse-charged VAT for BU_EU_INK");
  });

  it("uses the API VAT for non-reverse codes and derives the base from IN amounts", async () => {
    const api = fakeApi((req) => {
      const path = req.url.pathname;
      if (path === "/v1/ledger") return json(200, { items: LEDGERS });
      if (path === "/v1/mutation") return json(200, { items: [{ id: 9 }] });
      if (path === "/v1/mutation/9") {
        return json(200, {
          id: 9,
          type: "6",
          date: "2026-07-01",
          ledgerId: 100,
          inExVat: "IN",
          rows: [{ ledgerId: 106, vatCode: "HOOG_INK_21", amount: 1.5 }],
          vat: [{ vatCode: "HOOG_INK_21", amount: 0.26 }],
        });
      }
      if (path === "/v1/ledger/balances") return json(200, { items: [] });
      return undefined;
    });

    const summary = await vatQuarterSummary(api.client, 2026, 3);
    expect(summary.perVatCode).toEqual([
      expect.objectContaining({ vatCode: "HOOG_INK_21", base: 1.24, vat: 0.26 }),
    ]);
    const list = api.calls("GET", "/v1/mutation")[0]!;
    expect(list.url.searchParams.get("date[range]")).toBe("2026-07-01,2026-09-30");
    const balances = api.calls("GET", "/v1/ledger/balances")[0]!;
    expect(balances.url.searchParams.get("from")).toBe("2026-07-01");
    expect(balances.url.searchParams.get("to")).toBe("2026-09-30");
  });
});

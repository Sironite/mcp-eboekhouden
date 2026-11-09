import { describe, expect, it } from "vitest";
import { EBoekhoudenApiError, ValidationError } from "../src/errors.js";
import { createMutation, markedDescription, type MutationDetail } from "../src/mutations.js";
import {
  API_TOKEN,
  MemoryAudit,
  SESSION_TOKEN,
  fakeApi,
  json,
  type RecordedRequest,
} from "./helpers.js";

const LEDGERS: Record<number, { id: number; code: string; category: string }> = {
  10: { id: 10, code: "8000", category: "VW" },
  11: { id: 11, code: "4000", category: "VW" },
  20: { id: 20, code: "1100", category: "FIN" },
  30: { id: 30, code: "1300", category: "DEB" },
  40: { id: 40, code: "1600", category: "CRED" },
};
const RELATIONS: Record<number, { id: number; name: string; inactive: boolean }> = {
  5: { id: 5, name: "Klant BV", inactive: false },
  6: { id: 6, name: "Oud BV", inactive: true },
};

/** Fake administration with ledgers, relations and optional existing mutations. */
function administration(opts: { existing?: MutationDetail[]; postResponse?: Response } = {}) {
  const existing = opts.existing ?? [];
  const handler = (req: RecordedRequest): Response | undefined => {
    const path = req.url.pathname;
    let m: RegExpMatchArray | null;
    if ((m = /^\/v1\/ledger\/(\d+)$/.exec(path))) {
      const ledger = LEDGERS[Number(m[1])];
      return ledger
        ? json(200, ledger)
        : json(404, { code: "LEDG_011", title: "Ledger not found." });
    }
    if ((m = /^\/v1\/relation\/(\d+)$/.exec(path))) {
      const relation = RELATIONS[Number(m[1])];
      return relation
        ? json(200, relation)
        : json(404, { code: "REL_055", title: "Relation not found." });
    }
    if (path === "/v1/mutation" && req.method === "GET") {
      const q = req.url.searchParams;
      const items = existing.filter(
        (e) =>
          String(e.type) === q.get("type") &&
          e.date === q.get("date") &&
          (!q.has("invoiceNumber") || e.invoiceNumber === q.get("invoiceNumber")) &&
          (!q.has("description") || e.description === q.get("description")),
      );
      return json(200, { items: items.map((e) => ({ id: e.id })), count: items.length });
    }
    if ((m = /^\/v1\/mutation\/(\d+)$/.exec(path))) {
      const found = existing.find((e) => e.id === Number(m![1]));
      return found
        ? json(200, found)
        : json(404, { code: "MUT_300", title: "Mutation not found." });
    }
    if (path === "/v1/mutation" && req.method === "POST") {
      return opts.postResponse ?? json(201, { id: 9001 });
    }
    return undefined;
  };
  const api = fakeApi(handler);
  const audit = new MemoryAudit();
  return { ...api, audit, create: (input: unknown) => createMutation(api.client, audit, input) };
}

const salesInvoice = {
  type: "invoice_sent",
  date: "2026-10-15",
  ledgerId: 30,
  relationId: 5,
  invoiceNumber: "2026-0042",
  description: "Consultancy oktober",
  inExVat: "EX",
  rows: [{ ledgerId: 10, vatCode: "HOOG_VERK_21", amount: 1500 }],
};

async function rejected(promise: Promise<unknown>): Promise<string[]> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ValidationError);
  return (err as ValidationError).issues;
}

describe("create_mutation validation", () => {
  it.each([
    ["invalid date", { date: "2026-02-30" }, "valid calendar date"],
    ["wrong date format", { date: "15-10-2026" }, "YYYY-MM-DD"],
    [
      "unknown VAT code",
      { rows: [{ ledgerId: 10, vatCode: "BTW_21", amount: 10 }] },
      "rows.0.vatCode",
    ],
    [
      "three decimals",
      { rows: [{ ledgerId: 10, vatCode: "HOOG_VERK_21", amount: 10.005 }] },
      "2 decimals",
    ],
    [
      "zero amount",
      { rows: [{ ledgerId: 10, vatCode: "HOOG_VERK_21", amount: 0 }] },
      "must not be 0",
    ],
    ["no rows", { rows: [] }, "rows"],
    ["unknown type", { type: "refund" }, "type"],
    ["negative ledger id", { ledgerId: -1 }, "ledgerId"],
  ])("rejects %s without calling the API", async (_name, patch, expected) => {
    const admin = administration();
    const issues = await rejected(admin.create({ ...salesInvoice, ...patch }));
    expect(issues.join(" ")).toContain(expected);
    expect(admin.requests).toHaveLength(0);
    expect(admin.audit.entries[0]?.outcome).toBe("rejected");
  });

  it.each([
    [
      "description too long with marker",
      { description: "x".repeat(45) },
      "description is too long",
    ],
    [
      "purchase VAT code on a sales invoice",
      { rows: [{ ledgerId: 10, vatCode: "HOOG_INK_21", amount: 10 }] },
      "invoice_sent needs a sales code",
    ],
    [
      "sales VAT code on a purchase invoice",
      {
        type: "invoice_received",
        ledgerId: 40,
        rows: [{ ledgerId: 11, vatCode: "HOOG_VERK_21", amount: 10 }],
      },
      "invoice_received needs a purchase code",
    ],
    [
      "vatAmount with a fixed-rate code",
      { rows: [{ ledgerId: 10, vatCode: "HOOG_VERK_21", amount: 10, vatAmount: 2.1 }] },
      "only allowed with vatCode AFW",
    ],
    [
      "reverse charge purchase including VAT",
      {
        type: "invoice_received",
        ledgerId: 40,
        inExVat: "IN",
        rows: [{ ledgerId: 11, vatCode: "VERL_INK", amount: 100 }],
      },
      "requires inExVat EX",
    ],
    [
      "row without ledger",
      { rows: [{ vatCode: "HOOG_VERK_21", amount: 10 }] },
      "rows[0].ledgerId is required",
    ],
    [
      "invoice payment row without invoice number",
      { type: "invoice_payment_received", ledgerId: 20, rows: [{ vatCode: "GEEN", amount: 10 }] },
      "rows[0].invoiceNumber is required",
    ],
  ])("rejects %s before sending", async (_name, patch, expected) => {
    const admin = administration();
    const issues = await rejected(admin.create({ ...salesInvoice, ...patch }));
    expect(issues.join(" ")).toContain(expected);
    expect(admin.calls("POST", "/v1/mutation")).toHaveLength(0);
  });

  it("rejects unknown ledgers, forbidden row categories and inactive relations", async () => {
    const admin = administration();
    const issues = await rejected(
      admin.create({
        ...salesInvoice,
        ledgerId: 999,
        relationId: 6,
        rows: [{ ledgerId: 20, vatCode: "HOOG_VERK_21", amount: 10 }],
      }),
    );
    expect(issues).toContain("ledgerId 999 does not exist");
    expect(issues.join(" ")).toContain("category FIN, which is not allowed");
    expect(issues).toContain("relationId 6 is inactive");
    expect(admin.calls("POST", "/v1/mutation")).toHaveLength(0);
  });

  it("allows any row ledger category on a general journal entry", async () => {
    const admin = administration();
    const result = await admin.create({
      type: "general_journal",
      date: "2026-10-31",
      ledgerId: 20,
      description: "Herclassificatie",
      inExVat: "EX",
      rows: [{ ledgerId: 30, vatCode: "GEEN", amount: 50 }],
    });
    expect(result.status).toBe("created");
  });
});

describe("create_mutation marker and payload", () => {
  it("prefixes the description with [claude] and maps the type", async () => {
    const admin = administration();
    const result = await admin.create(salesInvoice);

    expect(result).toEqual({
      status: "created",
      mutationId: 9001,
      description: "[claude] Consultancy oktober",
    });
    const [post] = admin.calls("POST", "/v1/mutation");
    expect(post?.body).toMatchObject({
      type: 2,
      date: "2026-10-15",
      ledgerId: 30,
      relationId: 5,
      invoiceNumber: "2026-0042",
      description: "[claude] Consultancy oktober",
      inExVat: "EX",
      rows: [{ ledgerId: 10, vatCode: "HOOG_VERK_21", amount: 1500 }],
    });
  });

  it("does not double the marker, wherever it is", () => {
    expect(markedDescription("[claude] already")).toBe("[claude] already");
    expect(markedDescription("Cloud server 05/2027 [claude]")).toBe(
      "Cloud server 05/2027 [claude]",
    );
    expect(markedDescription(undefined)).toBe("[claude]");
  });

  it("marks row descriptions and falls back to the header description", async () => {
    const admin = administration();
    await admin.create({
      ...salesInvoice,
      description: "Consultancy [claude]",
      rows: [
        { ledgerId: 10, vatCode: "HOOG_VERK_21", amount: 1000, description: "Uren oktober" },
        { ledgerId: 10, vatCode: "HOOG_VERK_21", amount: 500 },
      ],
    });
    const body = admin.calls("POST", "/v1/mutation")[0]?.body as {
      description: string;
      rows: { description: string }[];
    };
    expect(body.description).toBe("Consultancy [claude]");
    expect(body.rows.map((r) => r.description)).toEqual([
      "[claude] Uren oktober",
      "Consultancy [claude]",
    ]);
  });

  it("rejects a row description that is too long with the marker", async () => {
    const admin = administration();
    const issues = await rejected(
      admin.create({
        ...salesInvoice,
        rows: [{ ledgerId: 10, vatCode: "HOOG_VERK_21", amount: 10, description: "x".repeat(195) }],
      }),
    );
    expect(issues.join(" ")).toContain("rows[0].description is too long");
  });
});

describe("create_mutation idempotency", () => {
  const existingInvoice: MutationDetail = {
    id: 777,
    type: "2",
    date: "2026-10-15",
    relationId: 5,
    invoiceNumber: "2026-0042",
    description: "[claude] Consultancy oktober",
    inExVat: "EX",
    rows: [{ ledgerId: 10, vatCode: "HOOG_VERK_21", amount: 1500 }],
  };

  it("returns the existing mutation instead of creating a duplicate", async () => {
    const admin = administration({ existing: [existingInvoice] });
    const result = await admin.create(salesInvoice);

    expect(result).toMatchObject({ status: "duplicate", mutationId: 777 });
    expect(admin.calls("POST", "/v1/mutation")).toHaveLength(0);
    const search = admin.calls("GET", "/v1/mutation")[0]!;
    expect(search.url.searchParams.get("type")).toBe("2");
    expect(search.url.searchParams.get("date")).toBe("2026-10-15");
    expect(admin.audit.entries).toEqual([
      expect.objectContaining({ tool: "create_mutation", outcome: "duplicate", mutationId: 777 }),
    ]);
  });

  it.each<[string, Partial<MutationDetail>]>([
    ["different amount", { rows: [{ ledgerId: 10, vatCode: "HOOG_VERK_21", amount: 1499.99 }] }],
    ["different relation", { relationId: 99 }],
  ])("creates a new mutation when the match has a %s", async (_name, patch) => {
    const admin = administration({ existing: [{ ...existingInvoice, ...patch }] });
    const result = await admin.create(salesInvoice);
    expect(result.status).toBe("created");
  });

  it("matches on description when there is no invoice number", async () => {
    const moneySent = {
      type: "money_sent",
      date: "2026-10-20",
      ledgerId: 20,
      relationId: 5,
      description: "Hosting",
      inExVat: "IN",
      rows: [{ ledgerId: 11, vatCode: "HOOG_INK_21", amount: 24.2 }],
    };
    const admin = administration({
      existing: [
        {
          id: 555,
          type: 6,
          date: "2026-10-20",
          relationId: 5,
          description: "[claude] Hosting",
          rows: [{ ledgerId: 11, vatCode: "HOOG_INK_21", amount: 24.2 }],
        },
      ],
    });

    const result = await admin.create(moneySent);
    expect(result).toMatchObject({ status: "duplicate", mutationId: 555 });
    const search = admin.calls("GET", "/v1/mutation")[0]!;
    expect(search.url.searchParams.get("type")).toBe("6");
    expect(search.url.searchParams.has("description")).toBe(false);
  });

  it("rejects a possible duplicate entered by hand with a different description", async () => {
    const admin = administration({
      existing: [
        {
          id: 556,
          type: 6,
          date: "2026-10-20",
          relationId: 5,
          description: "Hosting oktober",
          rows: [{ ledgerId: 11, vatCode: "HOOG_INK_21", amount: 24.2 }],
        },
      ],
    });
    const input = {
      type: "money_sent",
      date: "2026-10-20",
      ledgerId: 20,
      relationId: 5,
      description: "Hosting",
      inExVat: "IN",
      rows: [{ ledgerId: 11, vatCode: "HOOG_INK_21", amount: 24.2 }],
    };

    const issues = await rejected(admin.create(input));
    expect(issues.join(" ")).toContain("Possible duplicate: mutation #556 (Hosting oktober)");
    expect(admin.calls("POST", "/v1/mutation")).toHaveLength(0);
    expect(admin.audit.entries.at(-1)?.outcome).toBe("rejected");

    const confirmed = await admin.create({ ...input, confirmNotDuplicate: true });
    expect(confirmed.status).toBe("created");
    expect(admin.calls("POST", "/v1/mutation")[0]?.body).not.toHaveProperty("confirmNotDuplicate");
  });

  it("rejects a possible duplicate with a different invoice number", async () => {
    const admin = administration({
      existing: [{ ...existingInvoice, invoiceNumber: "2026-0043" }],
    });
    const issues = await rejected(admin.create(salesInvoice));
    expect(issues.join(" ")).toContain("#777 (2026-0043)");
  });
});

describe("create_mutation audit log", () => {
  it("logs the created mutation id and never the tokens", async () => {
    const admin = administration();
    await admin.create(salesInvoice);

    expect(admin.audit.entries).toHaveLength(1);
    const entry = admin.audit.entries[0]!;
    expect(entry).toMatchObject({ tool: "create_mutation", outcome: "created", mutationId: 9001 });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(API_TOKEN);
    expect(serialized).not.toContain(SESSION_TOKEN);
  });

  it("logs API errors with the e-Boekhouden error code", async () => {
    const admin = administration({
      postResponse: json(400, { code: "MUT_005", title: "Period is closed." }),
    });
    const err = await admin.create(salesInvoice).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EBoekhoudenApiError);
    expect(admin.audit.entries).toEqual([
      expect.objectContaining({ outcome: "error", errorCode: "MUT_005" }),
    ]);
  });
});

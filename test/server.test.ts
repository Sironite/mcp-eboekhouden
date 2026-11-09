import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer, dateFilter, like, type ServerOptions } from "../src/server.js";
import { MemoryAudit, SESSION_TOKEN, fakeApi, json, type Handler } from "./helpers.js";

async function connect(handler: Handler, options: ServerOptions = {}) {
  const api = fakeApi(handler);
  const server = createServer(api.client, new MemoryAudit(), options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, api };
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text: string }[];
  return content.map((c) => c.text).join("\n");
}

describe("MCP server", () => {
  it("exposes exactly the intended tools and nothing to change or delete mutations", async () => {
    const { client } = await connect(() => undefined);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_mutation",
      "create_relation",
      "get_ledger_balance",
      "get_mutation",
      "get_relation",
      "list_cost_centers",
      "list_ledgers",
      "list_mutations",
      "list_outstanding_invoices",
      "list_relations",
      "list_vat_codes",
      "update_relation",
      "vat_quarter_summary",
    ]);
    for (const tool of tools) expect(tool.description?.length).toBeGreaterThan(20);
  });

  it("returns e-Boekhouden errors as MCP tool errors with the code", async () => {
    const { client } = await connect((req) =>
      req.url.pathname === "/v1/mutation/5"
        ? json(404, { code: "MUT_300", title: "Mutation not found." })
        : undefined,
    );
    const result = await client.callTool({ name: "get_mutation", arguments: { id: 5 } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("MUT_300");
    expect(text(result)).not.toContain(SESSION_TOKEN);
  });

  it("rejects invalid tool arguments", async () => {
    const { client, api } = await connect(() => undefined);
    const result = await client.callTool({ name: "get_mutation", arguments: { id: "../../etc" } });
    expect(result.isError).toBe(true);
    expect(api.requests).toHaveLength(0);
  });

  it("translates list_mutations filters to e-Boekhouden query parameters", async () => {
    const { client, api } = await connect((req) =>
      req.url.pathname === "/v1/mutation" ? json(200, { items: [], count: 0 }) : undefined,
    );
    await client.callTool({
      name: "list_mutations",
      arguments: {
        type: "money_sent",
        dateFrom: "2026-01-01",
        dateTo: "2026-03-31",
        descriptionContains: "claude",
      },
    });
    const params = api.calls("GET", "/v1/mutation")[0]!.url.searchParams;
    expect(params.get("type")).toBe("6");
    expect(params.get("date[range]")).toBe("2026-01-01,2026-03-31");
    expect(params.get("description[like]")).toBe("%claude%");
  });

  it("escapes [ in substring filters so [claude] is matched literally", async () => {
    expect(like("[claude]")).toBe("%[[]claude]%");
    expect(like("plain")).toBe("%plain%");
    expect(like(undefined)).toBeUndefined();

    const { client, api } = await connect((req) =>
      req.url.pathname === "/v1/mutation" || req.url.pathname === "/v1/relation"
        ? json(200, { items: [], count: 0 })
        : undefined,
    );
    await client.callTool({
      name: "list_mutations",
      arguments: { descriptionContains: "[claude]" },
    });
    await client.callTool({ name: "list_relations", arguments: { nameContains: "[x]" } });
    expect(api.calls("GET", "/v1/mutation")[0]!.url.searchParams.get("description[like]")).toBe(
      "%[[]claude]%",
    );
    expect(api.calls("GET", "/v1/relation")[0]!.url.searchParams.get("name[like]")).toBe("%[[]x]%");
  });

  it("maps the new read tools to the right endpoints", async () => {
    const { client, api } = await connect((req) => {
      const p = req.url.pathname;
      if (p === "/v1/relation/12") return json(200, { id: 12, name: "Klant BV" });
      if (p === "/v1/costcenter" || p === "/v1/mutation/invoice/outstanding") {
        return json(200, { items: [], count: 0 });
      }
      return undefined;
    });

    const relation = await client.callTool({ name: "get_relation", arguments: { id: 12 } });
    expect(text(relation)).toContain("Klant BV");

    await client.callTool({
      name: "list_cost_centers",
      arguments: { descriptionContains: "Hosting" },
    });
    expect(api.calls("GET", "/v1/costcenter")[0]!.url.searchParams.get("description[like]")).toBe(
      "%Hosting%",
    );

    await client.callTool({ name: "list_outstanding_invoices", arguments: { side: "creditors" } });
    await client.callTool({ name: "list_outstanding_invoices", arguments: { side: "debtors" } });
    const outstanding = api.calls("GET", "/v1/mutation/invoice/outstanding");
    expect(outstanding.map((r) => r.url.searchParams.get("credDeb"))).toEqual(["C", "D"]);
  });

  it("adds a token expiry warning to tool results when expiry is near", async () => {
    const { client } = await connect(() => undefined, {
      tokenExpiresAt: new Date("2027-12-31T00:00:00Z"),
      now: () => new Date("2027-12-20T00:00:00Z"),
    });
    const result = await client.callTool({ name: "list_vat_codes", arguments: {} });
    expect(text(result)).toContain("API token expires on 2027-12-31 (11 days)");
  });

  it("builds date filters", () => {
    expect(dateFilter("date", "2026-01-01")).toEqual({ "date[gte]": "2026-01-01" });
    expect(dateFilter("date", undefined, "2026-01-31")).toEqual({ "date[lte]": "2026-01-31" });
    expect(dateFilter("date")).toEqual({});
  });
});

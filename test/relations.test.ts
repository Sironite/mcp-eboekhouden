import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors.js";
import { createRelation, updateRelation } from "../src/relations.js";
import { MemoryAudit, fakeApi, json } from "./helpers.js";

describe("relations", () => {
  it("creates a relation and audits the new id", async () => {
    const api = fakeApi((req) =>
      req.method === "POST" && req.url.pathname === "/v1/relation"
        ? json(201, { id: 12, code: "KLANT1" })
        : undefined,
    );
    const audit = new MemoryAudit();

    const result = await createRelation(api.client, audit, { name: "Klant BV", type: "B" });

    expect(result).toEqual({ status: "created", relationId: 12, code: "KLANT1" });
    expect(api.calls("POST", "/v1/relation")[0]?.body).toEqual({ name: "Klant BV", type: "B" });
    expect(audit.entries[0]).toMatchObject({
      tool: "create_relation",
      outcome: "created",
      relationId: 12,
    });
  });

  it("rejects invalid fields before calling the API", async () => {
    const api = fakeApi(() => undefined);
    const audit = new MemoryAudit();
    const err = await createRelation(api.client, audit, {
      name: "",
      emailAddress: "no-email",
      companyRegistrationNumber: "12AB",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(api.requests).toHaveLength(0);
    expect(audit.entries[0]?.outcome).toBe("rejected");
  });

  it("keeps the current name on update because PATCH requires it", async () => {
    const api = fakeApi((req) => {
      if (req.method === "GET" && req.url.pathname === "/v1/relation/12") {
        return json(200, { id: 12, name: "Klant BV" });
      }
      if (req.method === "PATCH" && req.url.pathname === "/v1/relation/12") return json(204);
      return undefined;
    });
    const audit = new MemoryAudit();

    const result = await updateRelation(api.client, audit, { id: 12, city: "Utrecht" });

    expect(result).toEqual({ status: "updated", relationId: 12 });
    expect(api.calls("PATCH", "/v1/relation/12")[0]?.body).toEqual({
      city: "Utrecht",
      name: "Klant BV",
    });
    expect(audit.entries[0]).toMatchObject({
      tool: "update_relation",
      outcome: "updated",
      relationId: 12,
    });
  });

  it("refuses an update without fields", async () => {
    const api = fakeApi(() => undefined);
    const err = await updateRelation(api.client, new MemoryAudit(), { id: 12 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(api.requests).toHaveLength(0);
  });
});

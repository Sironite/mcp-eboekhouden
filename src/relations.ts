import type { z } from "zod";
import type { AuditLogger } from "./audit.js";
import type { EBoekhoudenClient } from "./client.js";
import { EBoekhoudenApiError, ValidationError } from "./errors.js";
import { createRelationInput, updateRelationInput } from "./schemas.js";

export function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "input"}: ${i.message}`),
    );
  }
  return parsed.data;
}

async function audited<T>(
  audit: AuditLogger,
  tool: string,
  payload: unknown,
  fn: () => Promise<T & { relationId: number }>,
  outcome: "created" | "updated",
): Promise<T & { relationId: number }> {
  try {
    const result = await fn();
    await audit.write({ tool, outcome, payload, relationId: result.relationId });
    return result;
  } catch (err) {
    await audit.write({
      tool,
      outcome: err instanceof ValidationError ? "rejected" : "error",
      payload,
      errorCode: err instanceof EBoekhoudenApiError ? err.code : undefined,
    });
    throw err;
  }
}

export async function createRelation(
  client: EBoekhoudenClient,
  audit: AuditLogger,
  raw: unknown,
): Promise<{ status: "created"; relationId: number; code: string | undefined }> {
  return audited(
    audit,
    "create_relation",
    raw,
    async () => {
      const input = parseOrThrow(createRelationInput, raw);
      const created = await client.post<{ id: number; code?: string }>("/v1/relation", input);
      return { status: "created" as const, relationId: created.id, code: created.code };
    },
    "created",
  );
}

export async function updateRelation(
  client: EBoekhoudenClient,
  audit: AuditLogger,
  raw: unknown,
): Promise<{ status: "updated"; relationId: number }> {
  return audited(
    audit,
    "update_relation",
    raw,
    async () => {
      const { id, ...fields } = parseOrThrow(updateRelationInput, raw);
      if (Object.keys(fields).length === 0) throw new ValidationError(["No fields to update"]);
      // PATCH /v1/relation/{id} requires `name`; keep the current name when not changing it.
      let name = fields.name;
      if (name === undefined) {
        const current = await client.get<{ name?: string }>(`/v1/relation/${id}`);
        name = current.name;
        if (!name) throw new ValidationError([`Relation ${id} has no name; pass name explicitly`]);
      }
      await client.patch(`/v1/relation/${id}`, { ...fields, name });
      return { status: "updated" as const, relationId: id };
    },
    "updated",
  );
}

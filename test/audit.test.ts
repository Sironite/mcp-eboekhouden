import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAuditLogger, redact } from "../src/audit.js";

describe("audit log", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("appends one JSON line per write with timestamp, tool and mutation id", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "audit-"));
    const file = path.join(dir, "logs", "audit.jsonl");
    const logger = new FileAuditLogger(file, () => new Date("2026-11-05T10:00:00Z"));

    await logger.write({
      tool: "create_mutation",
      outcome: "created",
      payload: { a: 1 },
      mutationId: 42,
    });
    await logger.write({
      tool: "create_relation",
      outcome: "created",
      payload: { name: "X" },
      relationId: 7,
    });

    const lines = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      timestamp: "2026-11-05T10:00:00.000Z",
      tool: "create_mutation",
      outcome: "created",
      mutationId: 42,
      payload: { a: 1 },
    });
    expect(lines[1]?.["relationId"]).toBe(7);
  });

  it("strips credential-like keys at any depth", () => {
    expect(
      redact({
        accessToken: "x",
        nested: { Authorization: "y", apiToken: "z", keep: 1 },
        list: [{ password: "p", amount: 2 }],
      }),
    ).toEqual({ nested: { keep: 1 }, list: [{ amount: 2 }] });
  });
});

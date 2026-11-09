import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface AuditEntry {
  tool: string;
  outcome: "created" | "updated" | "duplicate" | "rejected" | "error";
  payload: unknown;
  mutationId?: number | undefined;
  relationId?: number | undefined;
  errorCode?: string | undefined;
}

export interface AuditLogger {
  write(entry: AuditEntry): Promise<void>;
}

const SENSITIVE_KEY = /token|secret|password|authorization|credential/i;

/** Removes any key that looks like it could carry a credential, at any depth. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SENSITIVE_KEY.test(key))
        .map(([key, v]) => [key, redact(v)]),
    );
  }
  return value;
}

/** Appends one JSON line per write action to a local file (logs/ is git-ignored). */
export class FileAuditLogger implements AuditLogger {
  readonly #file: string;
  readonly #now: () => Date;

  constructor(file: string, now: () => Date = () => new Date()) {
    this.#file = file;
    this.#now = now;
  }

  async write(entry: AuditEntry): Promise<void> {
    const line = JSON.stringify({
      timestamp: this.#now().toISOString(),
      tool: entry.tool,
      outcome: entry.outcome,
      mutationId: entry.mutationId,
      relationId: entry.relationId,
      errorCode: entry.errorCode,
      payload: redact(entry.payload),
    });
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    await appendFile(this.#file, `${line}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

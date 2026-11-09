/** Error returned by the e-Boekhouden API, normalised from its JSON error body. */
export class EBoekhoudenApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: string[];
  readonly traceId: string | undefined;

  constructor(opts: {
    status: number;
    code?: string | undefined;
    title: string;
    details?: string[];
    traceId?: string | undefined;
  }) {
    super(opts.title);
    this.name = "EBoekhoudenApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details ?? [];
    this.traceId = opts.traceId;
  }

  toUserMessage(): string {
    const code = this.code ?? "UNKNOWN";
    const parts = [`e-Boekhouden error ${code} (HTTP ${this.status}): ${this.message}`];
    if (this.details.length > 0) parts.push(`Details: ${this.details.join("; ")}`);
    if (this.traceId) parts.push(`TraceId: ${this.traceId}`);
    return parts.join("\n");
  }
}

/** Input rejected by this server before anything was sent to e-Boekhouden. */
export class ValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Validation failed: ${issues.join("; ")}`);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

function pick(body: Record<string, unknown>, key: string): unknown {
  // The docs show both camelCase (schema) and PascalCase (example) keys.
  return body[key] ?? body[key.charAt(0).toUpperCase() + key.slice(1)];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function collectDetails(errors: unknown): string[] {
  if (Array.isArray(errors)) return errors.filter((e): e is string => typeof e === "string");
  if (errors && typeof errors === "object") {
    return Object.entries(errors as Record<string, unknown>).flatMap(([field, msgs]) =>
      Array.isArray(msgs) ? msgs.map((m) => `${field}: ${String(m)}`) : [],
    );
  }
  return [];
}

export function parseApiError(status: number, body: unknown): EBoekhoudenApiError {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    return new EBoekhoudenApiError({
      status,
      code: asString(pick(b, "code")),
      title: asString(pick(b, "title")) ?? asString(pick(b, "message")) ?? `HTTP ${status}`,
      details: collectDetails(pick(b, "errors")),
      traceId: asString(pick(b, "traceId")),
    });
  }
  return new EBoekhoudenApiError({ status, title: `HTTP ${status}` });
}

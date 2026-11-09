import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const API_BASE_URL = "https://api.e-boekhouden.nl";

/** Default integration identifier sent to POST /v1/session. */
export const DEFAULT_SESSION_SOURCE = "mcp_eb";

/**
 * Integration identifier sent to POST /v1/session (helps e-Boekhouden support
 * trace requests). EBOEKHOUDEN_SOURCE overrides the default; it must match the
 * API pattern ^[\w ]{1,10}$ (letters, digits, underscore, space; max 10).
 */
export function sessionSource(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["EBOEKHOUDEN_SOURCE"]?.trim();
  if (!configured) return DEFAULT_SESSION_SOURCE;
  if (!/^[\w ]{1,10}$/.test(configured)) {
    throw new Error(
      "EBOEKHOUDEN_SOURCE must be 1-10 characters: letters, digits, underscore or space.",
    );
  }
  return configured;
}

/** Default marker added to the description of every mutation created through this server. */
export const DEFAULT_MUTATION_MARKER = "[claude]";

/**
 * Marker for mutations created through this server. EBOEKHOUDEN_MARKER overrides
 * the default; it must be 1-20 printable characters.
 */
export function mutationMarker(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["EBOEKHOUDEN_MARKER"]?.trim();
  if (!configured) return DEFAULT_MUTATION_MARKER;
  if (configured.length > 20 || hasControlChar(configured)) {
    throw new Error("EBOEKHOUDEN_MARKER must be 1-20 printable characters.");
  }
  return configured;
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Hard limit of the mutation description field (POST /v1/mutation). */
export const MUTATION_DESCRIPTION_MAX = 50;

/** Minimum time between two outgoing API requests (client-side throttle). */
export const MIN_REQUEST_INTERVAL_MS = 250;

/** Maximum wait honoured from a Retry-After header on HTTP 429. */
export const MAX_RETRY_AFTER_MS = 10_000;

/** Page size used when the server walks through all pages of a list endpoint. */
export const PAGE_SIZE = 2000;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_AUDIT_LOG_PATH = path.join(projectRoot, "logs", "audit.jsonl");

/** Version from package.json (src/ and dist/ both sit one level below the project root). */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Audit log location. EBOEKHOUDEN_AUDIT_LOG may point elsewhere (for example the
 * bookkeeping folder); it must be an absolute path to a .jsonl file.
 */
export function auditLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["EBOEKHOUDEN_AUDIT_LOG"]?.trim();
  if (!configured) return DEFAULT_AUDIT_LOG_PATH;
  if (!path.isAbsolute(configured) || !configured.endsWith(".jsonl")) {
    throw new Error("EBOEKHOUDEN_AUDIT_LOG must be an absolute path to a .jsonl file.");
  }
  return path.normalize(configured);
}

/**
 * Optional expiry of the API token, from EBOEKHOUDEN_API_TOKEN_EXPIRES (Unix
 * seconds, as in the 1Password `expires` field, or an ISO date). Invalid values
 * are ignored.
 */
export function readTokenExpiry(env: NodeJS.ProcessEnv = process.env): Date | undefined {
  const raw = env["EBOEKHOUDEN_API_TOKEN_EXPIRES"]?.trim();
  if (!raw) return undefined;
  const date = /^\d+$/.test(raw) ? new Date(Number(raw) * 1000) : new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Days before expiry from which every tool result carries a warning. */
export const TOKEN_EXPIRY_WARNING_DAYS = 30;

export function tokenExpiryWarning(expiresAt: Date | undefined, now: Date): string | undefined {
  if (!expiresAt) return undefined;
  const days = Math.floor((expiresAt.getTime() - now.getTime()) / 86_400_000);
  if (days > TOKEN_EXPIRY_WARNING_DAYS) return undefined;
  const when = expiresAt.toISOString().slice(0, 10);
  return days < 0
    ? `WARNING: the e-Boekhouden API token expired on ${when}. Create a new API token in e-Boekhouden and update the secret behind EBOEKHOUDEN_API_TOKEN.`
    : `WARNING: the e-Boekhouden API token expires on ${when} (${days} days). Create a new API token in e-Boekhouden and update the secret behind EBOEKHOUDEN_API_TOKEN.`;
}

export function readApiToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env["EBOEKHOUDEN_API_TOKEN"]?.trim();
  if (!token) {
    throw new Error(
      "EBOEKHOUDEN_API_TOKEN is not set. Start the server with `op run --env-file=.env.op -- node dist/index.js`.",
    );
  }
  return token;
}

import { vi } from "vitest";
import type { AuditEntry, AuditLogger } from "../src/audit.js";
import { EBoekhoudenClient } from "../src/client.js";

export const API_TOKEN = "test-api-token-SECRET";
export const SESSION_TOKEN = "test-session-token-SECRET";

export function requestUrl(input: string | URL | Request): URL {
  if (typeof input === "string") return new URL(input);
  return input instanceof URL ? input : new URL(input.url);
}

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export type Handler = (req: RecordedRequest) => Response | undefined;

export function json(status: number, body?: unknown, headers?: Record<string, string>): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Fake HTTP layer. POST /v1/session is answered automatically unless a handler
 * returns something for it; any request without a handler fails the test.
 */
export function fakeApi(handler: Handler) {
  const requests: RecordedRequest[] = [];
  const fetchFn = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    const req: RecordedRequest = {
      method: init?.method ?? "GET",
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(req);
    const res = handler(req);
    if (res) return Promise.resolve(res);
    if (req.method === "POST" && url.pathname === "/v1/session") {
      return Promise.resolve(json(200, { token: SESSION_TOKEN, expiresIn: 3600 }));
    }
    throw new Error(`Unexpected request ${req.method} ${url.pathname}${url.search}`);
  });
  const client = new EBoekhoudenClient({
    apiToken: API_TOKEN,
    fetch: fetchFn,
    minRequestIntervalMs: 0,
    sleep: () => Promise.resolve(),
  });
  const calls = (method: string, pathname: string) =>
    requests.filter((r) => r.method === method && r.url.pathname === pathname);
  return { client, requests, fetchFn, calls };
}

export class MemoryAudit implements AuditLogger {
  entries: AuditEntry[] = [];
  write(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

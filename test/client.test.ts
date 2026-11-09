import { describe, expect, it, vi } from "vitest";
import { EBoekhoudenClient, retryAfterMs } from "../src/client.js";
import { EBoekhoudenApiError } from "../src/errors.js";
import { API_TOKEN, SESSION_TOKEN, fakeApi, json, requestUrl } from "./helpers.js";

describe("session handling", () => {
  it("logs in lazily with the API token and the default source", async () => {
    const api = fakeApi((req) =>
      req.url.pathname === "/v1/ledger" ? json(200, { items: [] }) : undefined,
    );
    expect(api.requests).toHaveLength(0);

    await api.client.get("/v1/ledger");

    const [login, call] = api.requests;
    expect(login?.method).toBe("POST");
    expect(login?.url.pathname).toBe("/v1/session");
    expect(login?.body).toEqual({ accessToken: API_TOKEN, source: "mcp_eb" });
    expect(call?.headers["Authorization"]).toBe(SESSION_TOKEN);
  });

  it("reuses the cached session", async () => {
    const api = fakeApi((req) =>
      req.url.pathname === "/v1/ledger" ? json(200, { items: [] }) : undefined,
    );
    await api.client.get("/v1/ledger");
    await api.client.get("/v1/ledger");
    expect(api.calls("POST", "/v1/session")).toHaveLength(1);
  });

  it("shares one login between concurrent requests", async () => {
    const api = fakeApi((req) =>
      req.url.pathname === "/v1/ledger" ? json(200, { items: [] }) : undefined,
    );
    await Promise.all([api.client.get("/v1/ledger"), api.client.get("/v1/ledger")]);
    expect(api.calls("POST", "/v1/session")).toHaveLength(1);
  });

  it("logs in again once after a 401 and retries the request", async () => {
    let ledgerCalls = 0;
    const api = fakeApi((req) => {
      if (req.url.pathname !== "/v1/ledger") return undefined;
      ledgerCalls += 1;
      return ledgerCalls === 1
        ? json(401, { type: "security", code: "SECURITY_010", title: "Not authenticated." })
        : json(200, { items: [{ id: 1 }] });
    });

    await expect(api.client.get("/v1/ledger")).resolves.toEqual({ items: [{ id: 1 }] });
    expect(api.calls("POST", "/v1/session")).toHaveLength(2);
  });

  it("gives up after the second 401", async () => {
    const api = fakeApi((req) =>
      req.url.pathname === "/v1/ledger"
        ? json(401, { code: "SECURITY_010", title: "Not authenticated." })
        : undefined,
    );

    const err = await api.client.get("/v1/ledger").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EBoekhoudenApiError);
    expect((err as EBoekhoudenApiError).code).toBe("SECURITY_010");
    expect(api.calls("POST", "/v1/session")).toHaveLength(2);
    expect(api.calls("GET", "/v1/ledger")).toHaveLength(2);
  });

  it("refreshes an expired session before the request", async () => {
    let now = 0;
    const fetchFn = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (init?.method === "POST" && url.pathname === "/v1/session") {
        return Promise.resolve(json(200, { token: SESSION_TOKEN, expiresIn: 60 }));
      }
      return Promise.resolve(json(200, {}));
    });
    const client = new EBoekhoudenClient({
      apiToken: API_TOKEN,
      fetch: fetchFn,
      minRequestIntervalMs: 0,
      now: () => now,
    });

    await client.get("/v1/ledger");
    now = 45_000; // inside the 30 s safety margin of a 60 s session
    await client.get("/v1/ledger");

    const logins = fetchFn.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(logins).toHaveLength(2);
  });

  it("explains an expired API token", async () => {
    const api = fakeApi((req) =>
      req.url.pathname === "/v1/session"
        ? json(400, { code: "API_SESSION_004", title: "Access token has expired." })
        : undefined,
    );
    const err = (await api.client
      .get("/v1/ledger")
      .catch((e: unknown) => e)) as EBoekhoudenApiError;
    expect(err.code).toBe("API_SESSION_004");
    expect(err.message).toContain("API token has expired");
    expect(err.message).toContain("EBOEKHOUDEN_API_TOKEN");
  });

  it("reports a failed login with the e-Boekhouden code and without the token", async () => {
    const api = fakeApi((req) =>
      req.url.pathname === "/v1/session"
        ? json(400, { code: "API_SESSION_004", title: "Access token has expired." })
        : undefined,
    );

    const err = (await api.client
      .get("/v1/ledger")
      .catch((e: unknown) => e)) as EBoekhoudenApiError;
    expect(err.code).toBe("API_SESSION_004");
    expect(err.toUserMessage()).not.toContain(API_TOKEN);
    expect(err.toUserMessage()).not.toContain(SESSION_TOKEN);
  });
});

describe("errors, throttling and paging", () => {
  it("parses PascalCase error bodies as shown in the docs example", async () => {
    const api = fakeApi((req) =>
      req.url.pathname === "/v1/mutation"
        ? json(400, {
            Errors: { "object.field": ["Field is missing."] },
            Type: "validation",
            Code: "MUT_019",
            Title: "Invoice number already exists.",
            Status: 400,
            TraceId: "ABC-1",
          })
        : undefined,
    );

    const err = (await api.client
      .post("/v1/mutation", {})
      .catch((e: unknown) => e)) as EBoekhoudenApiError;
    expect(err.code).toBe("MUT_019");
    expect(err.toUserMessage()).toContain("MUT_019");
    expect(err.toUserMessage()).toContain("object.field: Field is missing.");
  });

  it("retries once on 429 after Retry-After", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fetchFn = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (init?.method === "POST")
        return Promise.resolve(json(200, { token: "t", expiresIn: 3600 }));
      if (url.pathname !== "/v1/ledger") throw new Error("unexpected");
      calls += 1;
      return Promise.resolve(
        calls === 1 ? json(429, {}, { "retry-after": "2" }) : json(200, { ok: true }),
      );
    });
    const client = new EBoekhoudenClient({
      apiToken: API_TOKEN,
      fetch: fetchFn,
      minRequestIntervalMs: 0,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });

    await expect(client.get("/v1/ledger")).resolves.toEqual({ ok: true });
    expect(sleeps).toContain(2000);
  });

  it("caps Retry-After and defaults to 1 s", () => {
    expect(retryAfterMs("120")).toBe(10_000);
    expect(retryAfterMs(null)).toBe(1000);
    expect(retryAfterMs("abc")).toBe(1000);
  });

  it("walks all pages in getAll", async () => {
    const api = fakeApi((req) => {
      if (req.url.pathname !== "/v1/mutation") return undefined;
      const offset = Number(req.url.searchParams.get("offset"));
      const count = offset === 0 ? 2000 : 3;
      return json(200, { items: Array.from({ length: count }, (_, i) => ({ id: offset + i })) });
    });

    const all = await api.client.getAll<{ id: number }>("/v1/mutation", { type: 1 });
    expect(all).toHaveLength(2003);
    const pages = api.calls("GET", "/v1/mutation");
    expect(pages.map((p) => p.url.searchParams.get("offset"))).toEqual(["0", "2000"]);
    expect(pages[0]?.url.searchParams.get("limit")).toBe("2000");
    expect(pages[0]?.url.searchParams.get("type")).toBe("1");
  });
});

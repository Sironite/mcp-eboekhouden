import {
  API_BASE_URL,
  MAX_RETRY_AFTER_MS,
  MIN_REQUEST_INTERVAL_MS,
  PAGE_SIZE,
  DEFAULT_SESSION_SOURCE,
} from "./config.js";
import { EBoekhoudenApiError, parseApiError } from "./errors.js";

export type FetchFn = typeof fetch;
export type QueryValue = string | number | boolean | undefined;
export type Query = Record<string, QueryValue>;

export interface ClientOptions {
  apiToken: string;
  /** Integration identifier for POST /v1/session (default: DEFAULT_SESSION_SOURCE). */
  source?: string;
  fetch?: FetchFn;
  baseUrl?: string;
  minRequestIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Session {
  token: string;
  expiresAt: number;
}

/** Refresh the session this long before it expires. */
const SESSION_EXPIRY_MARGIN_MS = 30_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Thin client for the e-Boekhouden REST API.
 *
 * - Exchanges the API token for a session token lazily and caches it.
 * - On HTTP 401 it logs in again once; a second 401 is reported as an error.
 * - Throttles requests client-side and retries once on HTTP 429.
 * - Never includes the API token or session token in errors or logs.
 */
export class EBoekhoudenClient {
  readonly #apiToken: string;
  readonly #source: string;
  readonly #fetch: FetchFn;
  readonly #baseUrl: string;
  readonly #minInterval: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  #session: Session | undefined;
  #sessionPromise: Promise<Session> | undefined;
  #queue: Promise<void> = Promise.resolve();
  #lastRequestAt = 0;

  constructor(opts: ClientOptions) {
    this.#apiToken = opts.apiToken;
    this.#source = opts.source ?? DEFAULT_SESSION_SOURCE;
    this.#fetch = opts.fetch ?? fetch;
    this.#baseUrl = opts.baseUrl ?? API_BASE_URL;
    this.#minInterval = opts.minRequestIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#now = opts.now ?? Date.now;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.#request<T>("GET", path, query);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.#request<T>("POST", path, undefined, body);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.#request<T>("PATCH", path, undefined, body);
  }

  /** Walks all pages of a list endpoint that returns `{ items, count }`. */
  async getAll<T>(path: string, query: Query = {}): Promise<T[]> {
    const all: T[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await this.get<{ items?: T[] }>(path, { ...query, limit: PAGE_SIZE, offset });
      const items = page.items ?? [];
      all.push(...items);
      if (items.length < PAGE_SIZE) return all;
    }
  }

  async #request<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
    let session = await this.#getSession();
    let res = await this.#send(method, path, query, body, session.token);
    if (res.status === 401) {
      this.#invalidate(session);
      session = await this.#getSession();
      res = await this.#send(method, path, query, body, session.token);
    }
    return this.#handle<T>(res);
  }

  #invalidate(session: Session): void {
    if (this.#session === session) this.#session = undefined;
  }

  async #getSession(): Promise<Session> {
    if (this.#session && this.#session.expiresAt > this.#now()) return this.#session;
    this.#sessionPromise ??= this.#login().finally(() => {
      this.#sessionPromise = undefined;
    });
    return this.#sessionPromise;
  }

  async #login(): Promise<Session> {
    const res = await this.#throttled(() =>
      this.#fetch(`${this.#baseUrl}/v1/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ accessToken: this.#apiToken, source: this.#source }),
      }),
    );
    const data = await this.#handle<{ token?: unknown; expiresIn?: unknown }>(res).catch(
      (err: unknown) => {
        throw explainLoginError(err);
      },
    );
    if (typeof data.token !== "string" || data.token.length === 0) {
      throw new EBoekhoudenApiError({ status: res.status, title: "Session response has no token" });
    }
    const expiresIn = typeof data.expiresIn === "number" ? data.expiresIn : 0;
    const session = {
      token: data.token,
      expiresAt: this.#now() + expiresIn * 1000 - SESSION_EXPIRY_MARGIN_MS,
    };
    this.#session = session;
    return session;
  }

  async #send(
    method: string,
    path: string,
    query: Query | undefined,
    body: unknown,
    sessionToken: string,
  ): Promise<Response> {
    const url = this.#buildUrl(path, query);
    const init: RequestInit = {
      method,
      headers: {
        Authorization: sessionToken,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    let res = await this.#throttled(() => this.#fetch(url, init));
    if (res.status === 429) {
      await this.#sleep(retryAfterMs(res.headers.get("retry-after")));
      res = await this.#throttled(() => this.#fetch(url, init));
    }
    return res;
  }

  #buildUrl(path: string, query?: Query): string {
    const url = new URL(path, this.#baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.append(key, String(value));
    }
    return url.toString();
  }

  async #handle<T>(res: Response): Promise<T> {
    const text = await res.text();
    let body: unknown = undefined;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    if (!res.ok) throw parseApiError(res.status, body);
    return body as T;
  }

  /** Serialises requests and keeps at least `minInterval` ms between them. */
  #throttled(fn: () => Promise<Response>): Promise<Response> {
    const run = this.#queue.then(async () => {
      const wait = this.#lastRequestAt + this.#minInterval - this.#now();
      if (wait > 0) await this.#sleep(wait);
      this.#lastRequestAt = this.#now();
      return fn();
    });
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

const TOKEN_HELP =
  "Create a new API token in the e-Boekhouden account settings and update the secret behind EBOEKHOUDEN_API_TOKEN (for example the 1Password item referenced in .env.op).";

/** Turns API token problems at login into an actionable message. */
export function explainLoginError(err: unknown): unknown {
  if (!(err instanceof EBoekhoudenApiError)) return err;
  if (err.code === "API_SESSION_004") {
    return new EBoekhoudenApiError({
      status: err.status,
      code: err.code,
      title: `The e-Boekhouden API token has expired. ${TOKEN_HELP}`,
      traceId: err.traceId,
    });
  }
  if (err.code === "API_SESSION_003" || err.status === 401 || err.status === 403) {
    return new EBoekhoudenApiError({
      status: err.status,
      code: err.code,
      title: `The e-Boekhouden API token was rejected (${err.message}). ${TOKEN_HELP}`,
      traceId: err.traceId,
    });
  }
  return err;
}

export function retryAfterMs(header: string | null): number {
  const seconds = header === null ? NaN : Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return 1000;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

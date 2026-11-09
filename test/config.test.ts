import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditLogPath,
  mutationMarker,
  packageVersion,
  readApiToken,
  readTokenExpiry,
  sessionSource,
  tokenExpiryWarning,
} from "../src/config.js";

describe("config", () => {
  it("uses logs/audit.jsonl in the install by default", () => {
    expect(auditLogPath({})).toMatch(/logs[/\\]audit\.jsonl$/);
  });

  it("accepts an absolute .jsonl path from EBOEKHOUDEN_AUDIT_LOG", () => {
    const file = path.join(path.sep, "tmp", "x", "..", "audit.jsonl");
    expect(auditLogPath({ EBOEKHOUDEN_AUDIT_LOG: file })).toBe(path.normalize(file));
  });

  it.each(["relative/audit.jsonl", "/tmp/audit.txt"])("rejects audit path %s", (value) => {
    expect(() => auditLogPath({ EBOEKHOUDEN_AUDIT_LOG: value })).toThrow("absolute path");
  });

  it("reads the token expiry as Unix seconds or ISO date", () => {
    expect(readTokenExpiry({ EBOEKHOUDEN_API_TOKEN_EXPIRES: "1830254460" })?.toISOString()).toBe(
      "2027-12-31T12:01:00.000Z",
    );
    expect(readTokenExpiry({ EBOEKHOUDEN_API_TOKEN_EXPIRES: "2027-12-31" })?.getUTCFullYear()).toBe(
      2027,
    );
    expect(readTokenExpiry({ EBOEKHOUDEN_API_TOKEN_EXPIRES: "soon" })).toBeUndefined();
    expect(readTokenExpiry({})).toBeUndefined();
  });

  it("warns only within 30 days of token expiry", () => {
    const expires = new Date("2027-12-31T00:00:00Z");
    expect(tokenExpiryWarning(expires, new Date("2027-11-01T00:00:00Z"))).toBeUndefined();
    expect(tokenExpiryWarning(expires, new Date("2027-12-21T00:00:00Z"))).toContain("(10 days)");
    expect(tokenExpiryWarning(expires, new Date("2028-01-02T00:00:00Z"))).toContain("expired on");
    expect(tokenExpiryWarning(undefined, new Date())).toBeUndefined();
  });

  it("uses a configurable session source within the API pattern", () => {
    expect(sessionSource({})).toBe("mcp_eb");
    expect(sessionSource({ EBOEKHOUDEN_SOURCE: "my_app" })).toBe("my_app");
    expect(() => sessionSource({ EBOEKHOUDEN_SOURCE: "far-too-long-name" })).toThrow("1-10");
    expect(() => sessionSource({ EBOEKHOUDEN_SOURCE: "a-b" })).toThrow("1-10");
  });

  it("uses a configurable marker", () => {
    expect(mutationMarker({})).toBe("[claude]");
    expect(mutationMarker({ EBOEKHOUDEN_MARKER: " [ai] " })).toBe("[ai]");
    expect(() => mutationMarker({ EBOEKHOUDEN_MARKER: "x".repeat(21) })).toThrow("1-20");
    expect(() => mutationMarker({ EBOEKHOUDEN_MARKER: "a\u0007b" })).toThrow("printable");
  });

  it("reads the version from package.json", () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("requires the API token", () => {
    expect(() => readApiToken({})).toThrow("EBOEKHOUDEN_API_TOKEN is not set");
    expect(readApiToken({ EBOEKHOUDEN_API_TOKEN: " abc " })).toBe("abc");
  });
});

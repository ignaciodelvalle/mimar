// Unit tests for createClientFromBearer() — lib/supabase/bearer.ts.
//
// The non-cookie entry point. PO decision 2026-08-19: native talks to our own
// /api/v1 with a bearer token, NOT directly to Supabase — so this factory's job
// is to make a bearer request resolvable by the SAME guard (requireLiveUser)
// that resolves a cookie request. No route consumes it yet; Track 2 is its
// first caller.
//
// @supabase/supabase-js is mocked so the tests assert on the CONFIGURATION we
// hand it (which key, which header, session persistence off) rather than
// standing up a real client.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateSdkClient = vi.fn(() => ({ auth: { getUser: vi.fn() } }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => mockCreateSdkClient(...(args as [])),
}));

import { createClientFromBearer, parseBearerToken } from "@/lib/supabase/bearer";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-for-tests";
});

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

describe("parseBearerToken()", () => {
  it("extracts the token from a well-formed header", () => {
    expect(parseBearerToken("Bearer abc.def.ghi")).toEqual({ ok: true, token: "abc.def.ghi" });
  });

  // RFC 7235 §2.1: the auth-scheme is case-insensitive.
  it("accepts any casing of the scheme", () => {
    expect(parseBearerToken("bearer abc")).toEqual({ ok: true, token: "abc" });
    expect(parseBearerToken("BEARER abc")).toEqual({ ok: true, token: "abc" });
  });

  it("tolerates surrounding whitespace and repeated separators", () => {
    expect(parseBearerToken("  Bearer   abc  ")).toEqual({ ok: true, token: "abc" });
  });

  it.each([null, undefined, "", "   "])("reports MISSING for %p", (header) => {
    expect(parseBearerToken(header)).toEqual({ ok: false, reason: "MISSING" });
  });

  it.each([
    ["Basic dXNlcjpwYXNz", "a different scheme"],
    ["Bearer", "scheme with no token"],
    ["Bearer   ", "scheme with blank token"],
    ["abc.def.ghi", "a naked token with no scheme"],
    ["Bearer abc def", "a token containing whitespace"],
  ])("reports MALFORMED for %p (%s)", (header) => {
    expect(parseBearerToken(header)).toEqual({ ok: false, reason: "MALFORMED" });
  });
});

// ---------------------------------------------------------------------------
// Client construction
// ---------------------------------------------------------------------------

describe("createClientFromBearer()", () => {
  it("refuses without building a client when the header is missing", () => {
    const result = createClientFromBearer(null);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("MISSING");
    expect(mockCreateSdkClient).not.toHaveBeenCalled();
  });

  it("refuses without building a client when the scheme is wrong", () => {
    const result = createClientFromBearer("Basic dXNlcjpwYXNz");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("MALFORMED");
    expect(mockCreateSdkClient).not.toHaveBeenCalled();
  });

  it("builds a client that forwards the caller's token as the Authorization header", () => {
    const result = createClientFromBearer("Bearer abc.def.ghi");

    expect(result.ok).toBe(true);
    const [, , options] = mockCreateSdkClient.mock.calls[0] as unknown as [
      string,
      string,
      { global: { headers: Record<string, string> } },
    ];
    expect(options.global.headers.Authorization).toBe("Bearer abc.def.ghi");
  });

  // The load-bearing one. Using the service-role key here would hand a bearer
  // caller RLS-bypassing reach; the ANON key keeps the request inside the same
  // policy set a cookie request runs under.
  it("uses the ANON key, never the service-role key", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-must-not-leak";

    createClientFromBearer("Bearer abc");

    const [url, key] = mockCreateSdkClient.mock.calls[0] as unknown as [string, string];
    expect(url).toBe("http://127.0.0.1:54321");
    expect(key).toBe("anon-key-for-tests");
    expect(key).not.toBe("service-role-must-not-leak");
  });

  // A per-request client on a server has nowhere to persist a session to and
  // nothing to refresh it for; leaving either on leaks state across requests.
  it("disables session persistence and auto-refresh", () => {
    createClientFromBearer("Bearer abc");

    const [, , options] = mockCreateSdkClient.mock.calls[0] as unknown as [
      string,
      string,
      { auth: { persistSession: boolean; autoRefreshToken: boolean } },
    ];
    expect(options.auth.persistSession).toBe(false);
    expect(options.auth.autoRefreshToken).toBe(false);
  });

  it("returns the parsed token alongside the client", () => {
    const result = createClientFromBearer("Bearer abc.def.ghi");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.token).toBe("abc.def.ghi");
    expect(result.supabase).toBeDefined();
  });
});

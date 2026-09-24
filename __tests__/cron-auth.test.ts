// Unit tests for lib/cron-auth.ts + fitness scan asserting every cron route
// uses the shared helper.
//
// Part (a): unit tests for authorizeCronRequest covering all security-relevant
//   cases without any DB or network access.
//
// Part (b): source-level fitness scan. Every app/api/cron/*/route.ts must
//   import `authorizeCronRequest` from `@/lib/cron-auth` (or use
//   `checkCronSecret` from `@/lib/case-cron`, which itself delegates to the
//   helper). A route that introduces a bespoke check will fail this scan.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authorizeCronRequest } from "@/lib/domain/cron-auth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(headers: Record<string, string>): {
  headers: { get(name: string): string | null };
} {
  return {
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Part (a): unit tests for authorizeCronRequest
// ---------------------------------------------------------------------------

describe("authorizeCronRequest", () => {
  const SECRET = "test-secret-abc123";

  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts Authorization: Bearer <CRON_SECRET>", () => {
    const req = makeReq({ authorization: `Bearer ${SECRET}` });
    expect(authorizeCronRequest(req)).toBeNull();
  });

  it("accepts x-cron-secret: <CRON_SECRET>", () => {
    const req = makeReq({ "x-cron-secret": SECRET });
    expect(authorizeCronRequest(req)).toBeNull();
  });

  it("rejects a wrong secret in Authorization: Bearer", () => {
    const req = makeReq({ authorization: "Bearer wrong-secret" });
    const result = authorizeCronRequest(req);
    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
  });

  it("rejects a wrong secret in x-cron-secret", () => {
    const req = makeReq({ "x-cron-secret": "wrong-secret" });
    const result = authorizeCronRequest(req);
    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
  });

  it("rejects when neither header is present", () => {
    const req = makeReq({});
    const result = authorizeCronRequest(req);
    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
  });

  it("rejects Authorization header that is not Bearer-prefixed", () => {
    const req = makeReq({ authorization: SECRET });
    const result = authorizeCronRequest(req);
    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
  });

  it("rejects when CRON_SECRET is unset in production (fail-closed)", () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    // Send a header that would be valid if there were a secret — must still fail.
    const req = makeReq({ authorization: "Bearer anything" });
    const result = authorizeCronRequest(req);
    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
    expect(result?.error).toMatch(/CRON_SECRET not configured/i);
  });

  it("allows request without CRON_SECRET in non-production (dev fallback)", () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("NODE_ENV", "test");
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const req = makeReq({});
    const result = authorizeCronRequest(req);
    expect(result).toBeNull();
    consoleSpy.mockRestore();
  });

  it("Bearer token with correct value but different length candidate is rejected", () => {
    // Ensures length check prevents false pass on timing-safe comparison.
    const req = makeReq({ authorization: `Bearer ${SECRET}X` });
    const result = authorizeCronRequest(req);
    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
  });

  it("rejects a multibyte candidate with the same JS char length without throwing", () => {
    // 'é' is 1 JS char but 2 UTF-8 bytes. A char-length guard would pass and
    // then timingSafeEqual would throw (500); the byte-length guard must catch
    // it and return 401 cleanly.
    vi.stubEnv("CRON_SECRET", "abc");
    const req = makeReq({ "x-cron-secret": "aéb" });
    // A char-length guard would throw here (500); the byte-length guard must
    // return 401 cleanly. If it throws, this call fails the test.
    const result = authorizeCronRequest(req);
    expect(result?.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Part (b): fitness scan — every cron route uses the shared helper
// ---------------------------------------------------------------------------

describe("cron route auth fitness scan", () => {
  const CRON_DIR = join(process.cwd(), "app", "api", "cron");

  // A route satisfies the check if it actually CALLS the shared auth — either
  // `authorizeCronRequest(` directly or `checkCronSecret(` (the case-cron
  // wrapper, which delegates to authorizeCronRequest). We assert on the call,
  // not merely the import, so a route that imports but forgets to invoke is
  // still flagged. Commented lines are stripped first.
  const ACCEPTED_CALLS = [/\bauthorizeCronRequest\s*\(/, /\bcheckCronSecret\s*\(/];

  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "")) // line comments
      .join("\n");
  }

  function listCronRoutes(): string[] {
    return readdirSync(CRON_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(CRON_DIR, e.name, "route.ts"));
  }

  it("finds at least one cron route", () => {
    const routes = listCronRoutes();
    expect(routes.length).toBeGreaterThan(0);
  });

  it("every cron route actually calls the shared cron-auth helper", () => {
    const routes = listCronRoutes();
    const offenders: string[] = [];

    for (const routePath of routes) {
      let src: string;
      try {
        src = stripComments(readFileSync(routePath, "utf8"));
      } catch {
        offenders.push(`${routePath}: file not found`);
        continue;
      }

      const callsSharedHelper = ACCEPTED_CALLS.some((pattern) => pattern.test(src));
      if (!callsSharedHelper) {
        offenders.push(
          `${routePath}: does not call authorizeCronRequest(req) or checkCronSecret(req). Add \`const authError = authorizeCronRequest(req); if (authError) return NextResponse.json(authError, { status: authError.status });\`.`,
        );
      }
    }

    expect(
      offenders,
      `The following cron routes have bespoke or missing auth — migrate them:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// The /p/{token} canonical redirect (2026-09-23, after pre-push review).
//
// A lowercase or space-padded token (`/p/dim-pamp-0001`) names the issued
// `DIM-PAMP-0001` and used to 404. The fix is a 308 at the EDGE, not a folding
// lookup predicate: every limiter key and the scan log on this route family
// are built from the raw route param, so folding case downstream let one
// credential be read under every spelling with a fresh limiter bucket each.
//
// Three layers: the pure normaliser (lib/domain/dim-token.ts), the pure path
// decision (`canonicalPublicTokenRedirectPath`), and `middleware()` itself —
// which must answer a real 308 with the right Location, and must leave every
// other path to the session refresh it always ran.

import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalDimToken, normalizeDimTokenInput } from "@/lib/domain/dim-token";

const mockUpdateSession = vi.fn();
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: (req: NextRequest) => mockUpdateSession(req),
}));

import { canonicalPublicTokenRedirectPath, middleware } from "@/middleware";

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateSession.mockImplementation(async () => NextResponse.next());
});

describe("canonicalDimToken — ASCII-only fold, token shape only", () => {
  it.each([
    ["dim-pamp-0001", "DIM-PAMP-0001"],
    ["DiM-PaMp-0001", "DIM-PAMP-0001"],
    ["  DIM-PAMP-0001 ", "DIM-PAMP-0001"],
    ["DIM-PAMP-0001", "DIM-PAMP-0001"],
  ])("%j → %s", (raw, canonical) => {
    expect(canonicalDimToken(raw)).toBe(canonical);
  });

  it.each([
    // Turkish dotless i: `toUpperCase()` maps it to a plain `I`, which would
    // turn a string nobody was issued into a real token.
    "dım-pamp-0001",
    // Long s → S under toUpperCase().
    "DIM-ſALT-0001",
    // Fullwidth letters.
    "ＤＩＭ-PAMP-0001",
    "not-a-token",
    "DIM-PAMP-00011",
    "LBR-PAMP-0001",
    "",
  ])("refuses %j (null: no redirect, the route 404s it as typed)", (raw) => {
    expect(canonicalDimToken(raw)).toBeNull();
  });

  it("the normaliser leaves non-ASCII letters exactly as typed", () => {
    expect(normalizeDimTokenInput(" dım-ſ ")).toBe("DıM-ſ");
  });
});

describe("canonicalPublicTokenRedirectPath", () => {
  it.each([
    ["/p/dim-pamp-0001", "/p/DIM-PAMP-0001"],
    ["/p/%20dim-pamp-0001%20", "/p/DIM-PAMP-0001"],
    ["/p/DIM-PAMP-0001%20", "/p/DIM-PAMP-0001"],
    ["/p/dim-pamp-0001/encontre", "/p/DIM-PAMP-0001/encontre"],
    ["/p/dim-pamp-0001/sighting", "/p/DIM-PAMP-0001/sighting"],
  ])("GET %s → %s", (path, target) => {
    expect(canonicalPublicTokenRedirectPath("GET", path)).toBe(target);
    expect(canonicalPublicTokenRedirectPath("HEAD", path)).toBe(target);
  });

  it.each([
    ["already canonical", "/p/DIM-PAMP-0001"],
    ["already canonical, sub-path", "/p/DIM-PAMP-0001/encontre"],
    ["unicode lookalike (dotless i)", `/p/${encodeURIComponent("dım-pamp-0001")}`],
    ["not a token", "/p/hola"],
    ["malformed escape", "/p/%E0%A4%A"],
    ["bare /p", "/p"],
    ["another tree with a token", "/mis-mascotas/dim-pamp-0001"],
    ["a path that merely starts with /p", "/perdidos/dim-pamp-0001"],
  ])("does not redirect: %s", (_label, path) => {
    expect(canonicalPublicTokenRedirectPath("GET", path)).toBeNull();
  });

  it("never redirects a POST — a server action cannot follow a 308 without re-sending", () => {
    expect(canonicalPublicTokenRedirectPath("POST", "/p/dim-pamp-0001/encontre")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The anonymous `/api/v1` reader — native-review C-2 / N-12-02 (2026-09-29).
//
// `GET /api/v1/pets/{token}/credential` is the ONE `/api/v1` route that
// resolves this token without a bearer/session guard (@no-auth-required), so
// it shares `/p`'s failure mode: a lowercase or space-padded token 404s, and
// fragments the per-lookup limiter (`${publicToken}:${ip}`) exactly like `/p`
// did before 2026-09-23. Every OTHER `/api/v1/pets/{token}/*` route sits
// behind `requirePetAccess` and is deliberately left alone below.
// ---------------------------------------------------------------------------

describe("canonicalPublicTokenRedirectPath — the anonymous /api/v1 credential reader", () => {
  it.each([
    ["/api/v1/pets/dim-pamp-0001/credential", "/api/v1/pets/DIM-PAMP-0001/credential"],
    ["/api/v1/pets/%20dim-pamp-0001%20/credential", "/api/v1/pets/DIM-PAMP-0001/credential"],
    ["/api/v1/pets/DiM-PaMp-0001/credential", "/api/v1/pets/DIM-PAMP-0001/credential"],
  ])("GET %s → %s", (path, target) => {
    expect(canonicalPublicTokenRedirectPath("GET", path)).toBe(target);
    expect(canonicalPublicTokenRedirectPath("HEAD", path)).toBe(target);
  });

  it.each([
    ["already canonical", "/api/v1/pets/DIM-PAMP-0001/credential"],
    [
      "unicode lookalike (dotless i)",
      `/api/v1/pets/${encodeURIComponent("dım-pamp-0001")}/credential`,
    ],
    ["not a token", "/api/v1/pets/hola/credential"],
    ["malformed escape", "/api/v1/pets/%E0%A4%A/credential"],
    // A DIFFERENT, AUTHENTICATED route under the same [publicToken] segment —
    // out of scope on purpose (see the function's docblock): an authenticated
    // caller is not the anonymous-enumeration problem this redirect exists for.
    ["a sibling authenticated route, not /credential", "/api/v1/pets/dim-pamp-0001/profile"],
    ["the bare pet resource, not /credential", "/api/v1/pets/dim-pamp-0001"],
    ["a nested authenticated route", "/api/v1/pets/dim-pamp-0001/events/credential"],
  ])("does not redirect: %s", (_label, path) => {
    expect(canonicalPublicTokenRedirectPath("GET", path)).toBeNull();
  });

  it("never redirects a POST on this path shape either", () => {
    expect(
      canonicalPublicTokenRedirectPath("POST", "/api/v1/pets/dim-pamp-0001/credential"),
    ).toBeNull();
  });
});

describe("middleware() — the wire", () => {
  it("answers 308 with the canonical Location, query string preserved, no session refresh", async () => {
    const res = await middleware(new NextRequest("http://localhost:3000/p/dim-pamp-0001?src=qr"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("http://localhost:3000/p/DIM-PAMP-0001?src=qr");
    expect(mockUpdateSession).not.toHaveBeenCalled();
  });

  it("redirects a space-padded token on a sibling route", async () => {
    const res = await middleware(
      new NextRequest("http://localhost:3000/p/%20dim-pamp-0001/encontre"),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("http://localhost:3000/p/DIM-PAMP-0001/encontre");
  });

  it.each([
    ["the canonical token", "http://localhost:3000/p/DIM-PAMP-0001"],
    ["a unicode lookalike", `http://localhost:3000/p/${encodeURIComponent("dım-pamp-0001")}`],
    ["a non-/p path", "http://localhost:3000/mis-mascotas/dim-pamp-0001"],
  ])("passes %s through untouched to the session refresh", async (_label, url) => {
    const res = await middleware(new NextRequest(url));
    expect(res.status).not.toBe(308);
    expect(res.headers.get("location")).toBeNull();
    expect(mockUpdateSession).toHaveBeenCalledTimes(1);
  });

  it("passes a lowercase POST through (server actions are not redirected)", async () => {
    const res = await middleware(
      new NextRequest("http://localhost:3000/p/dim-pamp-0001/encontre", { method: "POST" }),
    );
    expect(res.status).not.toBe(308);
    expect(mockUpdateSession).toHaveBeenCalledTimes(1);
  });

  it("308s a lowercase /api/v1 credential request to the canonical Location", async () => {
    const res = await middleware(
      new NextRequest("http://localhost:3000/api/v1/pets/dim-pamp-0001/credential"),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(
      "http://localhost:3000/api/v1/pets/DIM-PAMP-0001/credential",
    );
    expect(mockUpdateSession).not.toHaveBeenCalled();
  });

  it("passes a lowercase /api/v1 request through for a sibling, authenticated route", async () => {
    const res = await middleware(
      new NextRequest("http://localhost:3000/api/v1/pets/dim-pamp-0001/profile"),
    );
    expect(res.status).not.toBe(308);
    expect(res.headers.get("location")).toBeNull();
    expect(mockUpdateSession).toHaveBeenCalledTimes(1);
  });
});

// Tests for the edge-level permanent redirects in middleware.ts.
//
// Coverage here is scoped to the legacy pet-profile lens routes
// (/vacunas, /historial, /libreta) — the QA regression (engram #635) that
// motivated this file: their page-level permanentRedirect() calls stream a
// 200 shell (loading.tsx boundary) instead of a real HTTP 308 in prod. The
// middleware redirect added alongside the AC3 pattern (/admin/cola,
// /admin/usuarios, /admin/organizaciones → /gob/*, see middleware.ts) fixes
// that by returning the 308 before the request ever reaches the page.
//
// The redirect-hit cases below never reach updateSession() (the Supabase
// session-refresh call) — they return early. The two fall-through cases
// (unmatched paths) DO reach it, so updateSession is mocked to a plain
// pass-through response; otherwise those assertions would depend on a local
// Supabase stack being up and reachable.

import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: vi.fn(async (request: NextRequest) => NextResponse.next({ request })),
}));

const { middleware } = await import("./middleware");

const PUBLIC_TOKEN = "DIM-9HAK-D5Z4";

function requestFor(pathname: string, search = "") {
  return new NextRequest(new URL(`https://dim.test${pathname}${search}`));
}

describe("middleware — legacy pet-profile lens redirects", () => {
  it.each([
    ["vacunas", "vacunas"],
    ["historial", "historial"],
    ["libreta", "libreta"],
  ])(
    "redirects /mis-mascotas/[publicToken]/%s to ?tab=%s with a real 308",
    async (segment, tab) => {
      const request = requestFor(`/mis-mascotas/${PUBLIC_TOKEN}/${segment}`);
      const response = await middleware(request);

      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe(
        `https://dim.test/mis-mascotas/${PUBLIC_TOKEN}?tab=${tab}`,
      );
    },
  );

  it("does NOT match a trailing slash — exact segment match only, same as the page.tsx route it replaces", async () => {
    const request = requestFor(`/mis-mascotas/${PUBLIC_TOKEN}/vacunas/`);
    const response = await middleware(request);

    expect(response.status).not.toBe(308);
    expect(response.headers.get("location")).toBeNull();
  });

  it("drops any incoming query string — the target is always the fixed ?tab= value, matching the page-level permanentRedirect()", async () => {
    const request = requestFor(`/mis-mascotas/${PUBLIC_TOKEN}/historial`, "?lente=oficial&foo=bar");
    const response = await middleware(request);

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      `https://dim.test/mis-mascotas/${PUBLIC_TOKEN}?tab=historial`,
    );
  });

  it("does NOT redirect /vacunas/programar — it's a real page (schedule-a-vaccine form), not a legacy lens route", async () => {
    const request = requestFor(`/mis-mascotas/${PUBLIC_TOKEN}/vacunas/programar`);
    const response = await middleware(request);

    // Falls through to updateSession(), which returns a plain pass-through
    // NextResponse.next() — i.e. NOT a redirect.
    expect(response.status).not.toBe(308);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does NOT redirect an unrelated /mis-mascotas/[publicToken] path (no lens segment)", async () => {
    const request = requestFor(`/mis-mascotas/${PUBLIC_TOKEN}`);
    const response = await middleware(request);

    expect(response.status).not.toBe(308);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("middleware — x-portal-base stamping (portal-follows-viewer)", () => {
  it('stamps "/admin" for any /admin/* path', async () => {
    const request = requestFor("/admin/reglas/AR/_/_");
    await middleware(request);
    expect(request.headers.get("x-portal-base")).toBe("/admin");
  });

  it('stamps "/admin" for the /admin root itself', async () => {
    const request = requestFor("/admin");
    await middleware(request);
    expect(request.headers.get("x-portal-base")).toBe("/admin");
  });

  it('stamps "/gob" for any /gob/* path', async () => {
    const request = requestFor("/gob/reglas/AR/_/_");
    await middleware(request);
    expect(request.headers.get("x-portal-base")).toBe("/gob");
  });

  it('stamps "/gob" for an unrelated path (default)', async () => {
    const request = requestFor("/inicio");
    await middleware(request);
    expect(request.headers.get("x-portal-base")).toBe("/gob");
  });
});

// Bug fix (qa-triage-2026-07-23, finding #13): a session-expiry bounce to
// /login used to drop the operator's exact work URL (pathname + query string
// both lost) — x-pathname alone can't carry the query string. x-full-path
// carries both, so lib/infra/auth-guards.ts's guards can build a `returnTo`
// that restores the FULL attempted deep link (e.g. /gob/denuncias?etapa=
// triage&queue=mine), not just the bare route.
describe("middleware — x-full-path stamping (session-kick returnTo fix)", () => {
  it("stamps pathname + query string together", async () => {
    const request = requestFor("/gob/denuncias", "?etapa=triage&queue=mine");
    await middleware(request);
    expect(request.headers.get("x-full-path")).toBe("/gob/denuncias?etapa=triage&queue=mine");
  });

  it("stamps the bare pathname when there is no query string", async () => {
    const request = requestFor("/gob/perdidas");
    await middleware(request);
    expect(request.headers.get("x-full-path")).toBe("/gob/perdidas");
  });
});

describe("middleware — /admin/jurisdicciones → /admin/reglas remap", () => {
  it("redirects the bare /admin/jurisdicciones index to /admin/reglas with a real 308", async () => {
    const request = requestFor("/admin/jurisdicciones");
    const response = await middleware(request);

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://dim.test/admin/reglas");
  });

  it("redirects a full jurisdiction CRUD path, dropping the trailing /reglas segment", async () => {
    const request = requestFor("/admin/jurisdicciones/AR/Salta/Cafayate/reglas");
    const response = await middleware(request);

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://dim.test/admin/reglas/AR/Salta/Cafayate",
    );
  });

  it("preserves a nested rest segment (e.g. /nueva) after the dropped /reglas segment", async () => {
    const request = requestFor("/admin/jurisdicciones/AR/Salta/Cafayate/reglas/nueva");
    const response = await middleware(request);

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://dim.test/admin/reglas/AR/Salta/Cafayate/nueva",
    );
  });

  it("does NOT redirect a jurisdicciones path that never reaches the /reglas segment", async () => {
    const request = requestFor("/admin/jurisdicciones/AR/Salta/Cafayate");
    const response = await middleware(request);

    expect(response.status).not.toBe(308);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does NOT redirect /admin/reglas itself (the live surface, not the legacy alias)", async () => {
    const request = requestFor("/admin/reglas");
    const response = await middleware(request);

    expect(response.status).not.toBe(308);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("middleware — the old AC3-era /admin→/gob 308s are gone (portal-follows-viewer)", () => {
  it.each(["/admin/cola", "/admin/usuarios", "/admin/organizaciones", "/admin/servicios"])(
    "does NOT redirect %s — it now serves a real page",
    async (pathname) => {
      const request = requestFor(pathname);
      const response = await middleware(request);

      expect(response.status).not.toBe(308);
      expect(response.headers.get("location")).toBeNull();
    },
  );
});

// A Set-Cookie on a server action's response reads to the client router as
// "cookies changed" (`x-action-revalidated: [[],0,1]`) and triggers the refresh
// transition that never commits in a Next 15.5 production build: the Atender
// VisitCard stayed disabled forever (e2e/vet-visit-intake.spec.ts). The
// remember-last-org cookie is therefore written on navigations only.
describe("middleware — dim_last_org is never set on a server action", () => {
  it("sets it on a navigation under /org/[orgToken]", async () => {
    const response = await middleware(requestFor("/org/DIM-PMAV-E2VT/atender"));
    expect(response.cookies.get("dim_last_org")?.value).toBe("DIM-PMAV-E2VT");
  });

  it("does not set it when the request is a server action", async () => {
    const request = new NextRequest(new URL("https://dim.test/org/DIM-PMAV-E2VT/atender"), {
      method: "POST",
      headers: { "next-action": "78162a249b280135e2b02c019275460155fcc678a3" },
    });
    const response = await middleware(request);
    expect(response.cookies.get("dim_last_org")).toBeUndefined();
    expect(response.headers.get("set-cookie") ?? "").not.toContain("dim_last_org");
  });
});

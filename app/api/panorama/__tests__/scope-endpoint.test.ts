// Route-level tests for GET /api/panorama/scope — the embedded-drill scope
// bundle (panorama Theme 1). The endpoint returns the selected province's
// localities + centroids so a client-side drill can repopulate the switcher
// dropdown + the map's autozoom centroids without a reload. These mock the
// shared institutional gate + the reference-data loaders, asserting the auth
// posture and the bundle shape without a DB.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveActor = vi.fn();
vi.mock("../_guard", () => ({
  resolveInstitutionalPanoramaActor: () => mockResolveActor(),
}));

const mockListLocalities = vi.fn();
const mockListCentroids = vi.fn();
vi.mock("@/lib/infra/ar-localidades", () => ({
  listLocalitiesByProvince: (...a: unknown[]) => mockListLocalities(...a),
  listLocalityCentroids: (...a: unknown[]) => mockListCentroids(...a),
}));

import { NextResponse } from "next/server";
import { GET as scopeGET } from "../scope/route";

function actorOk(
  role: "admin" | "govt",
  jurisdictions: Array<{ province: string; locality: string }> = [],
) {
  return { ok: true, actor: { role, profile: { role }, jurisdictions } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListLocalities.mockResolvedValue([
    { slug: "la-plata", name: "La Plata" },
    { slug: "mar-del-plata", name: "Mar del Plata" },
  ]);
  mockListCentroids.mockResolvedValue({ "la-plata": [-57.95, -34.92] });
});

describe("GET /api/panorama/scope — auth gate", () => {
  it("returns the guard's response when the actor is not authorized", async () => {
    mockResolveActor.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    const res = await scopeGET(new Request("http://localhost/api/panorama/scope?province=AR-B"));
    expect(res.status).toBe(403);
    // No reference-data query is issued for an unauthorized caller.
    expect(mockListLocalities).not.toHaveBeenCalled();
  });
});

describe("GET /api/panorama/scope — bundle", () => {
  it("returns the province's localities + centroids for an authorized actor", async () => {
    mockResolveActor.mockResolvedValue(actorOk("admin"));
    const res = await scopeGET(new Request("http://localhost/api/panorama/scope?province=AR-B"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      localities: Array<{ slug: string; name: string }>;
      localityCentroids: Record<string, [number, number]>;
    };
    expect(body.localities).toHaveLength(2);
    expect(body.localityCentroids["la-plata"]).toEqual([-57.95, -34.92]);
    // Reused the exact server-page reference loaders with the ISO→code province.
    expect(mockListLocalities).toHaveBeenCalledWith("AR-B");
    expect(mockListCentroids).toHaveBeenCalledWith("AR-B");
  });

  it("returns an EMPTY bundle for national scope (no province)", async () => {
    mockResolveActor.mockResolvedValue(actorOk("govt"));
    const res = await scopeGET(new Request("http://localhost/api/panorama/scope"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      localities: unknown[];
      localityCentroids: Record<string, unknown>;
    };
    expect(body.localities).toEqual([]);
    expect(body.localityCentroids).toEqual({});
    // No province → no reference query.
    expect(mockListLocalities).not.toHaveBeenCalled();
  });

  it("returns an EMPTY bundle for an unknown province code", async () => {
    mockResolveActor.mockResolvedValue(actorOk("admin"));
    const res = await scopeGET(
      new Request("http://localhost/api/panorama/scope?province=NOT-REAL"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { localities: unknown[] };
    expect(body.localities).toEqual([]);
    expect(mockListLocalities).not.toHaveBeenCalled();
  });
});

// Defense-in-depth guard (QA fix, 2026-07-11 §1): a crafted `?province=`
// outside a govt actor's assignments must resolve to the SAME empty bundle as
// "no province selected" — the same narrowGovtScope posture the sibling
// [layer]/kpis routes already enforce. Harmless today (public padrón
// geography, not PII) but closes the gap before any scope-derived field is
// ever added to this route.
describe("GET /api/panorama/scope — govt defense-in-depth (out-of-scope province)", () => {
  it("returns an EMPTY bundle when a govt actor requests a province OUTSIDE their assignments", async () => {
    // A CABA-only govt operator (e.g. govt-local/Palermo) forces ?province=AR-V
    // (Tierra del Fuego) — a leak probe outside their jurisdiction.
    mockResolveActor.mockResolvedValue(
      actorOk("govt", [{ province: "CABA", locality: "Palermo" }]),
    );
    const res = await scopeGET(new Request("http://localhost/api/panorama/scope?province=AR-V"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      localities: unknown[];
      localityCentroids: Record<string, unknown>;
    };
    expect(body.localities).toEqual([]);
    expect(body.localityCentroids).toEqual({});
    // No reference query is issued for an out-of-scope province.
    expect(mockListLocalities).not.toHaveBeenCalled();
  });

  it("still returns the bundle when a govt actor requests a province WITHIN their assignments", async () => {
    mockResolveActor.mockResolvedValue(
      actorOk("govt", [{ province: "Buenos Aires", locality: "La Plata" }]),
    );
    const res = await scopeGET(new Request("http://localhost/api/panorama/scope?province=AR-B"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { localities: Array<{ slug: string; name: string }> };
    expect(body.localities).toHaveLength(2);
    expect(mockListLocalities).toHaveBeenCalledWith("AR-B");
  });

  it("admin bypasses the scope narrowing (universal scope, same as [layer]/route.ts)", async () => {
    mockResolveActor.mockResolvedValue(actorOk("admin", []));
    const res = await scopeGET(new Request("http://localhost/api/panorama/scope?province=AR-V"));
    expect(res.status).toBe(200);
    // Admin has no jurisdictions array populated but is never narrowed.
    expect(mockListLocalities).toHaveBeenCalledWith("AR-V");
  });
});

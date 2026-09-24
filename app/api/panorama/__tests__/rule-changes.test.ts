// Route-level tests for GET /api/panorama/rule-changes — the TimeScrubber's
// rule-change marker layer (política → resultado on the timeline).
//
// These mock the shared institutional gate + the policy-outcome fetcher and
// pin the SECURITY posture: a govt actor's scope is intersected server-side
// (never the raw client param — G1 for /gob/panorama), out-of-scope requests
// fail closed with an empty list and NO query, and national rules flow
// through for scoped actors (fetchRuleChanges' scope contract).

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveActor = vi.fn();
vi.mock("../_guard", () => ({
  resolveInstitutionalPanoramaActor: () => mockResolveActor(),
}));

const mockFetchRuleChanges = vi.fn();
vi.mock("@/lib/analytics/policy-outcome", () => ({
  POLICY_OUTCOME_MAX_CHANGES: 12,
  fetchRuleChanges: (...a: unknown[]) => mockFetchRuleChanges(...a),
}));

const mockLocalityByName = vi.fn();
vi.mock("@/lib/infra/ar-localidades", () => ({
  localityByName: (...a: unknown[]) => mockLocalityByName(...a),
}));

import { NextResponse } from "next/server";
import { GET as ruleChangesGET } from "../rule-changes/route";

function actorOk(
  role: "admin" | "govt",
  jurisdictions: Array<{ province: string; locality: string }> = [],
) {
  return { ok: true, actor: { role, profile: { role }, jurisdictions } };
}

function ruleChangeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    auditId: "audit-1",
    action: "govt_business_rule_updated",
    ruleType: "microchip_required",
    province: "Buenos Aires",
    locality: null,
    changedAt: new Date("2026-06-15T12:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchRuleChanges.mockResolvedValue([ruleChangeRow()]);
  mockLocalityByName.mockResolvedValue({ localityName: "La Plata" });
});

describe("GET /api/panorama/rule-changes — auth gate", () => {
  it("returns the guard's response when the actor is not authorized, without querying", async () => {
    mockResolveActor.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    const res = await ruleChangesGET(new Request("http://localhost/api/panorama/rule-changes"));
    expect(res.status).toBe(403);
    expect(mockFetchRuleChanges).not.toHaveBeenCalled();
  });
});

describe("GET /api/panorama/rule-changes — govt scope enforcement (G1)", () => {
  it("fails CLOSED for a govt actor requesting a province OUTSIDE their assignments", async () => {
    // A Buenos Aires operator probes ?province=AR-V (Tierra del Fuego).
    mockResolveActor.mockResolvedValue(
      actorOk("govt", [{ province: "Buenos Aires", locality: "La Plata" }]),
    );
    const res = await ruleChangesGET(
      new Request("http://localhost/api/panorama/rule-changes?province=AR-V"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changes: unknown[] };
    expect(body.changes).toEqual([]);
    // Fail-closed means NO audit-log query is ever issued for the probe.
    expect(mockFetchRuleChanges).not.toHaveBeenCalled();
  });

  it("scopes a locality-assigned govt actor to their OWN locality (never province-wide)", async () => {
    mockResolveActor.mockResolvedValue(
      actorOk("govt", [{ province: "Buenos Aires", locality: "La Plata" }]),
    );
    const res = await ruleChangesGET(new Request("http://localhost/api/panorama/rule-changes"));
    expect(res.status).toBe(200);
    expect(mockFetchRuleChanges).toHaveBeenCalledTimes(1);
    expect(mockFetchRuleChanges).toHaveBeenCalledWith(12, {
      province: "Buenos Aires",
      locality: "La Plata",
    });
  });

  it("queries province-wide for a WHOLE-PROVINCE assignment (empty locality)", async () => {
    mockResolveActor.mockResolvedValue(actorOk("govt", [{ province: "Salta", locality: "" }]));
    const res = await ruleChangesGET(new Request("http://localhost/api/panorama/rule-changes"));
    expect(res.status).toBe(200);
    expect(mockFetchRuleChanges).toHaveBeenCalledWith(12, { province: "Salta" });
  });

  it("ignores the client param and uses the INTERSECTED scope when the request is in-scope", async () => {
    mockResolveActor.mockResolvedValue(actorOk("govt", [{ province: "Salta", locality: "" }]));
    await ruleChangesGET(new Request("http://localhost/api/panorama/rule-changes?province=AR-A"));
    // Whole-province Salta narrowed by the Salta request → still Salta only.
    expect(mockFetchRuleChanges).toHaveBeenCalledWith(12, { province: "Salta" });
  });

  it("govt with NO active assignments gets an empty list, no query", async () => {
    mockResolveActor.mockResolvedValue(actorOk("govt", []));
    const res = await ruleChangesGET(new Request("http://localhost/api/panorama/rule-changes"));
    const body = (await res.json()) as { changes: unknown[] };
    expect(body.changes).toEqual([]);
    expect(mockFetchRuleChanges).not.toHaveBeenCalled();
  });
});

describe("GET /api/panorama/rule-changes — national rules always included", () => {
  it("passes through national rows (province null) returned for a SCOPED govt actor", async () => {
    mockResolveActor.mockResolvedValue(actorOk("govt", [{ province: "Salta", locality: "" }]));
    mockFetchRuleChanges.mockResolvedValue([
      ruleChangeRow({ auditId: "nat-1", province: null, locality: null }),
      ruleChangeRow({ auditId: "salta-1", province: "Salta" }),
    ]);
    const res = await ruleChangesGET(new Request("http://localhost/api/panorama/rule-changes"));
    const body = (await res.json()) as { changes: Array<{ auditId: string }> };
    expect(body.changes.map((c) => c.auditId)).toContain("nat-1");
    expect(body.changes.map((c) => c.auditId)).toContain("salta-1");
  });

  it("dedupes the national rows a MULTI-TUPLE govt actor receives once per scope", async () => {
    mockResolveActor.mockResolvedValue(
      actorOk("govt", [
        { province: "Buenos Aires", locality: "La Plata" },
        { province: "Buenos Aires", locality: "Mar del Plata" },
      ]),
    );
    // The same national change comes back from BOTH per-tuple queries.
    mockFetchRuleChanges.mockResolvedValue([
      ruleChangeRow({ auditId: "nat-1", province: null, locality: null }),
    ]);
    const res = await ruleChangesGET(new Request("http://localhost/api/panorama/rule-changes"));
    const body = (await res.json()) as { changes: Array<{ auditId: string }> };
    expect(mockFetchRuleChanges).toHaveBeenCalledTimes(2);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0].auditId).toBe("nat-1");
  });
});

describe("GET /api/panorama/rule-changes — admin drill-down", () => {
  it("admin without params queries PLATFORM-WIDE (unscoped)", async () => {
    mockResolveActor.mockResolvedValue(actorOk("admin"));
    await ruleChangesGET(new Request("http://localhost/api/panorama/rule-changes"));
    expect(mockFetchRuleChanges).toHaveBeenCalledWith(12, undefined);
  });

  it("admin with province+locality params queries the resolved canonical names", async () => {
    mockResolveActor.mockResolvedValue(actorOk("admin"));
    await ruleChangesGET(
      new Request("http://localhost/api/panorama/rule-changes?province=AR-B&locality=la-plata"),
    );
    expect(mockLocalityByName).toHaveBeenCalledWith("AR-B", "la-plata");
    expect(mockFetchRuleChanges).toHaveBeenCalledWith(12, {
      province: "Buenos Aires",
      locality: "La Plata",
    });
  });
});

describe("GET /api/panorama/rule-changes — response shape", () => {
  it("serializes changedAt as an ISO string (transaction basis: audit performed_at)", async () => {
    mockResolveActor.mockResolvedValue(actorOk("admin"));
    const res = await ruleChangesGET(new Request("http://localhost/api/panorama/rule-changes"));
    const body = (await res.json()) as { changes: Array<{ changedAt: string }> };
    expect(body.changes[0].changedAt).toBe("2026-06-15T12:00:00.000Z");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 503 with an empty list when the fetch rejects (never crashes the lambda)", async () => {
    mockResolveActor.mockResolvedValue(actorOk("admin"));
    mockFetchRuleChanges.mockRejectedValue(new Error("db down"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await ruleChangesGET(new Request("http://localhost/api/panorama/rule-changes"));
    consoleSpy.mockRestore();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { changes: unknown[] };
    expect(body.changes).toEqual([]);
  });
});

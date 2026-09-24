// Route-wiring + 404-no-leak tests for the govt inspector API (task #12).
//
// Proves the two inspector routes:
//   1. gate through resolveInstitutionalGobActor and short-circuit on rejection
//      (401/403 answered verbatim, the loader never runs);
//   2. map BOTH "does not exist" and "out of your jurisdiction" — the loader's
//      single { ok: false } — to an identical 404, so existence never leaks.
//
// The loader internals (scope predicate + audit-on-open) are covered separately
// in lib/infra/__tests__/welfare-inspector-detail.test.ts.

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGuard = vi.fn();
const mockLoadCase = vi.fn();
const mockLoadPet = vi.fn();

vi.mock("@/app/api/gob/_guard", () => ({
  resolveInstitutionalGobActor: () => mockGuard(),
}));
vi.mock("@/lib/infra/welfare-inspector-detail", () => ({
  loadWelfareInspectorDetail: (...args: unknown[]) => mockLoadCase(...args),
}));
vi.mock("@/lib/infra/gob-pet-subview", () => ({
  loadGobPetSubView: (...args: unknown[]) => mockLoadPet(...args),
}));

import { GET as caseGET } from "@/app/api/gob/maltrato/[id]/route";
import { GET as petGET } from "@/app/api/gob/mascotas/[token]/route";

const OK_ACTOR = {
  ok: true as const,
  actor: {
    profile: { id: "u-1" },
    role: "govt" as const,
    jurisdictions: [{ province: "CABA", locality: "Palermo" }],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

function caseReq(id = "rep-1") {
  return caseGET(new Request(`http://localhost/api/gob/maltrato/${id}`), {
    params: Promise.resolve({ id }),
  });
}
function petReq(token = "DIM-AAAA-BBBB") {
  return petGET(new Request(`http://localhost/api/gob/mascotas/${token}`), {
    params: Promise.resolve({ token }),
  });
}

describe("GET /api/gob/maltrato/[id]", () => {
  it("returns the gate's rejection response and never loads the case", async () => {
    mockGuard.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    const res = await caseReq();
    expect(res.status).toBe(403);
    expect(mockLoadCase).not.toHaveBeenCalled();
  });

  it("maps loader { ok:false } (non-existent OR out-of-scope) to 404 — no leak", async () => {
    mockGuard.mockResolvedValue(OK_ACTOR);
    mockLoadCase.mockResolvedValue({ ok: false });
    const res = await caseReq();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("returns 200 with the detail when in scope", async () => {
    mockGuard.mockResolvedValue(OK_ACTOR);
    mockLoadCase.mockResolvedValue({ ok: true, detail: { id: "rep-1", referenceCode: "DEN-1" } });
    const res = await caseReq();
    expect(res.status).toBe(200);
    expect((await res.json()).referenceCode).toBe("DEN-1");
    // The loader receives a session shaped from the actor (profile.id === user id).
    expect(mockLoadCase).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: { id: "u-1", role: "govt" },
        user: { id: "u-1" },
      }),
      "rep-1",
    );
  });
});

describe("GET /api/gob/mascotas/[token]", () => {
  it("returns the gate's rejection response and never loads the pet", async () => {
    mockGuard.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const res = await petReq();
    expect(res.status).toBe(401);
    expect(mockLoadPet).not.toHaveBeenCalled();
  });

  it("maps loader { ok:false } (no in-jurisdiction linking case) to 404 — no leak", async () => {
    mockGuard.mockResolvedValue(OK_ACTOR);
    mockLoadPet.mockResolvedValue({ ok: false });
    const res = await petReq();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("returns 200 with the pet projection when reachable", async () => {
    mockGuard.mockResolvedValue(OK_ACTOR);
    mockLoadPet.mockResolvedValue({
      ok: true,
      pet: { publicToken: "DIM-AAAA-BBBB", name: "Pampa" },
    });
    const res = await petReq();
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("Pampa");
  });
});

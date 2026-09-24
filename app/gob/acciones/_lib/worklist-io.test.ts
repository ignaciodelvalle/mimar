// worklist-io.test — the /gob/acciones fan-out contract (G5).
//
// Uses INJECTED fake fetchers (loadWorklist's `fetchers` parameter exists
// for exactly this) — no query ever executes, but the file transitively
// imports the DB client so the partition places it in the "db" project.
//
// Pins:
//   1. FAIL-CLOSED: a govt scope with zero jurisdictions returns the empty
//      worklist WITHOUT calling any domain fetcher (the cross-tenant-leak
//      boundary this screen inherits from resolveJurisdictionScope).
//   2. One failing domain degrades ALONE — flagged by name, the other two
//      domains still ranked and rendered.
//   3. The merged result is deadline-ranked across domains.

import { describe, expect, it, vi } from "vitest";

import { mapCaseRows, mapObservationRows } from "./worklist-core";
import { type WorklistFetchers, type WorklistScope, loadWorklist } from "./worklist-io";

const NOW = new Date("2026-08-02T15:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (d: number) => new Date(NOW.getTime() + d * DAY_MS);

const GOVT_EMPTY: WorklistScope = { role: "govt", jurisdictions: [] };
const GOVT_SCOPED: WorklistScope = {
  role: "govt",
  jurisdictions: [{ province: "Buenos Aires", locality: "La Plata" }],
};

const obsItems = mapObservationRows(
  [
    {
      petId: "p-1",
      petPublicToken: "DIM-TEST-0001",
      petName: "Pampa",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
      dueAt: daysFromNow(-3),
    },
  ],
  NOW,
);
const caseItems = mapCaseRows(
  [
    {
      id: "c-1",
      publicCode: "CAS-0001-0001",
      caseKind: "bite_incident",
      primaryPetName: null,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      openedAt: daysFromNow(-1),
    },
  ],
  NOW,
);

function fakeFetchers(over: Partial<WorklistFetchers> = {}): WorklistFetchers {
  return {
    observaciones: vi.fn(async () => obsItems),
    denuncias: vi.fn(async () => []),
    casos: vi.fn(async () => caseItems),
    ...over,
  };
}

describe("loadWorklist — scope fail-closed", () => {
  it("govt with ZERO jurisdictions returns empty WITHOUT touching any domain fetcher", async () => {
    const fetchers = fakeFetchers();
    const result = await loadWorklist(GOVT_EMPTY, "user-1", NOW, fetchers);

    expect(fetchers.observaciones).not.toHaveBeenCalled();
    expect(fetchers.denuncias).not.toHaveBeenCalled();
    expect(fetchers.casos).not.toHaveBeenCalled();
    expect(result).toEqual({
      items: [],
      totalCount: 0,
      counts: { observaciones: 0, denuncias: 0, casos: 0 },
      degraded: { observaciones: false, denuncias: false, casos: false },
    });
  });

  it("a scoped govt operator fans out to all three domains with the SAME scope object", async () => {
    const fetchers = fakeFetchers();
    await loadWorklist(GOVT_SCOPED, "user-1", NOW, fetchers);
    expect(fetchers.observaciones).toHaveBeenCalledWith(GOVT_SCOPED, NOW);
    expect(fetchers.denuncias).toHaveBeenCalledWith(GOVT_SCOPED, "user-1", NOW);
    expect(fetchers.casos).toHaveBeenCalledWith(GOVT_SCOPED, NOW);
  });
});

describe("loadWorklist — per-domain degradation", () => {
  it("one rejecting domain degrades alone: flagged by name, the others fully ranked", async () => {
    const fetchers = fakeFetchers({
      denuncias: vi.fn(async () => {
        throw new Error("pooler degraded");
      }),
    });
    const result = await loadWorklist(GOVT_SCOPED, "user-1", NOW, fetchers);

    expect(result.degraded).toEqual({ observaciones: false, denuncias: true, casos: false });
    expect(result.counts).toEqual({ observaciones: 1, denuncias: 0, casos: 1 });
    // Cross-domain deadline ranking survives the degradation: the overdue
    // observation leads, the on-time case follows.
    expect(result.items.map((i) => i.key)).toEqual(["obs:p-1", "caso:c-1"]);
    expect(result.totalCount).toBe(2);
  });
});

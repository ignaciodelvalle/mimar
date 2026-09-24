// The TimeScrubber histogram must not publish what the map is hatching.
//
// WHY (historical-reviews closing report 2026-08-22, finding M3 / fix queue
// row 13): `loadScopeDailyCounts` returned raw per-day counts with NO
// suppression, justified by a comment saying a scope total is "strictly coarser"
// than the per-unit aggregation k-anon already governs. That is true only while
// the scope holds MORE THAN ONE unit. Drill to a single locality and the scope
// total IS the unit count — and the histogram hands back not just the number the
// map refused to show, but the exact DATE of every event behind it.
//
// Reproduced against real data: CABA / Retiro, layer `sintomas`, 4 observations
// — under k, so the map hatches the cell. The histogram returned four dated
// buckets: 1895-09-08, 2017-03-15, 2022-01-20, 2024-12-08. Exact sum plus the
// date of each observation the hatching was protecting.
//
// Where the bypass is NEW is `sintomas` and `zoonosis`: the skeptics checked and
// `mordeduras` / `perdidas` / `denuncias` already give this same actor a points
// mode that reveals MORE in one call (exact lat/long + full timestamp), so there
// the histogram is not the shortest path. The guard is layer-agnostic anyway —
// a rule with an exception list is a rule someone will read the exception off.
//
// The envelope is DECLARED (`suppressed: true`), never a silent empty array: an
// empty array reads as "no data here", which is a different — and false —
// statement about a jurisdiction.

import { describe, expect, it } from "vitest";

import { ANONYMITY_K } from "@/lib/metrics/anonymity";
import {
  applyHistogramKAnon,
  scopeResolvesToSingleUnit,
} from "@/src/modules/panorama/infrastructure/repository-histogram";

const CABA = "Ciudad Autónoma de Buenos Aires";

/** The four dated buckets the repro pulled out of a hatched cell. */
const RETIRO_SINTOMAS = [
  { date: "1895-09-08", count: 1 },
  { date: "2017-03-15", count: 1 },
  { date: "2022-01-20", count: 1 },
  { date: "2024-12-08", count: 1 },
];

describe("histogram k-anon — is the resolved scope a single administrative unit?", () => {
  it("an admin drill to one locality is a single unit", () => {
    expect(
      scopeResolvesToSingleUnit({
        actor: { role: "admin" },
        jurisdictions: [],
        adminProvince: CABA,
        adminLocality: "Retiro",
      }),
    ).toBe(true);
  });

  it("an admin drill to one province is a single unit (#40b — province is not exempt)", () => {
    expect(
      scopeResolvesToSingleUnit({
        actor: { role: "admin" },
        jurisdictions: [],
        adminProvince: "Santa Cruz",
      }),
    ).toBe(true);
  });

  it("an admin with no drill is national — NOT a single unit", () => {
    expect(scopeResolvesToSingleUnit({ actor: { role: "admin" }, jurisdictions: [] })).toBe(false);
  });

  it("a govt assigned to exactly one locality is a single unit even with no drill", () => {
    expect(
      scopeResolvesToSingleUnit({
        actor: { role: "govt" },
        jurisdictions: [{ province: CABA, locality: "Retiro" }],
      }),
    ).toBe(true);
  });

  it("a govt covering several localities is not a single unit — the total spans them", () => {
    expect(
      scopeResolvesToSingleUnit({
        actor: { role: "govt" },
        jurisdictions: [
          { province: CABA, locality: "Retiro" },
          { province: CABA, locality: "Palermo" },
        ],
      }),
    ).toBe(false);
  });

  it("a govt covering several localities, drilled into ONE of them, is a single unit", () => {
    expect(
      scopeResolvesToSingleUnit({
        actor: { role: "govt" },
        jurisdictions: [
          { province: CABA, locality: "Retiro" },
          { province: CABA, locality: "Palermo" },
        ],
        adminProvince: CABA,
        adminLocality: "Retiro",
      }),
    ).toBe(true);
  });

  it("a whole-province govt assignment is one unit; the empty-locality sentinel counts", () => {
    expect(
      scopeResolvesToSingleUnit({
        actor: { role: "govt" },
        jurisdictions: [{ province: "Santa Cruz", locality: "" }],
      }),
    ).toBe(true);
  });

  it("a govt with NO assignments resolves to nothing, not to one unit", () => {
    expect(scopeResolvesToSingleUnit({ actor: { role: "govt" }, jurisdictions: [] })).toBe(false);
  });
});

describe("histogram k-anon — the suppression itself", () => {
  it("THE LEAK: the CABA/Retiro drill no longer publishes 4 dated symptom observations", () => {
    // Non-vacuity: the input really does carry the dates the map was hiding.
    expect(RETIRO_SINTOMAS.reduce((s, r) => s + r.count, 0)).toBe(4);
    expect(RETIRO_SINTOMAS.length).toBeGreaterThan(0);

    const out = applyHistogramKAnon(RETIRO_SINTOMAS, true);

    expect(out.suppressed).toBe(true);
    expect(out.counts).toEqual([]);
  });

  it("boundary: k-1 hides, k publishes — for the same single-unit scope", () => {
    const under = [{ date: "2026-01-01", count: ANONYMITY_K - 1 }];
    const at = [{ date: "2026-01-01", count: ANONYMITY_K }];

    expect(applyHistogramKAnon(under, true).suppressed).toBe(true);
    expect(applyHistogramKAnon(under, true).counts).toEqual([]);

    expect(applyHistogramKAnon(at, true).suppressed).toBe(false);
    expect(applyHistogramKAnon(at, true).counts).toEqual(at);
  });

  it("the total is the WINDOW total, not any single day's", () => {
    // Five days of one event each: no single bucket reaches k, the window does.
    const spread = ["01", "02", "03", "04", "05"].map((d) => ({
      date: `2026-01-${d}`,
      count: 1,
    }));
    expect(spread.length).toBe(ANONYMITY_K);

    const out = applyHistogramKAnon(spread, true);
    expect(out.suppressed).toBe(false);
    expect(out.counts).toEqual(spread);
  });

  it("a multi-unit scope publishes a sub-k total — the total is genuinely coarser there", () => {
    const out = applyHistogramKAnon(RETIRO_SINTOMAS, false);
    expect(out.suppressed).toBe(false);
    expect(out.counts).toEqual(RETIRO_SINTOMAS);
  });

  it("an empty window is DECLARED empty, never 'suppressed' — silence must not imply a secret", () => {
    // A single-unit scope with genuinely zero events: 0 < k, but publishing
    // "nothing happened" discloses nobody. Reporting it as suppressed would tell
    // the operator there IS something being hidden, which is its own leak.
    const out = applyHistogramKAnon([], true);
    expect(out.suppressed).toBe(false);
    expect(out.counts).toEqual([]);
  });
});

// Unit tests for the Panorama auto-reading sentence (panorama-redesign Fase 1).
//
// buildPanoramaReading is a PURE function: given the existing KpiDelta[]
// carried by the headline KPIs (deltaOf/priorWindowOf output — NEVER a new
// query, NEVER a k-anon-suppressed value), it produces the one-line reading
// shown above the map:
//
//   "{KPI} {empeora|mejora} {N}% vs período anterior; {X} de {Y} indicadores mejoran."
//
// Spec scenarios covered:
//   - headline = the KPI with the largest |pct| among non-flat deltas
//   - tie-break: input array order (deterministic)
//   - verb from direction × valence (cobertura good-up; mordeduras/zoonosis bad-up)
//   - count suffix over KPIs carrying a delta, singular agreement when X = 1
//   - fallback sentence when no deltas qualify (none present, or all flat)

import { describe, expect, it } from "vitest";

import { type ReadingKpi, buildPanoramaReading } from "@/src/modules/panorama/domain/reading";

const FALLBACK = "Sin variación destacable frente al período anterior.";

function kpi(
  id: string,
  pct?: number,
  direction?: "up" | "down" | "flat",
  unit?: "pct" | "pts",
): ReadingKpi {
  if (pct === undefined || direction === undefined) return { id };
  return { id, delta: { pct, direction, unit } };
}

describe("buildPanoramaReading — headline (worst delta)", () => {
  it("picks the KPI with the largest |pct| and builds the design's example sentence", () => {
    // cobertura +5 (good-up → mejora), mordeduras +12 (bad-up → empeora, worst),
    // zoonosis -3 (bad-up, down → mejora). 2 of 3 improve.
    const out = buildPanoramaReading([
      kpi("cobertura", 5, "up"),
      kpi("mordeduras", 12, "up"),
      kpi("zoonosis", -3, "down"),
    ]);
    expect(out).toBe("Mordeduras empeora 12% vs período anterior; 2 de 3 indicadores mejoran.");
  });

  it("compares deltas by MAGNITUDE — a large negative pct beats a smaller positive one", () => {
    // cobertura -20 (good-up, down → empeora) has |20| > |8|.
    const out = buildPanoramaReading([kpi("mordeduras", 8, "up"), kpi("cobertura", -20, "down")]);
    expect(out).toBe(
      "Cobertura antirrábica empeora 20% vs período anterior; 0 de 2 indicadores mejoran.",
    );
  });

  it("tie-breaks equal magnitudes by input array order", () => {
    // |10| === |10| → the FIRST in array order (zoonosis) wins the headline.
    const out = buildPanoramaReading([kpi("zoonosis", -10, "down"), kpi("mordeduras", 10, "up")]);
    expect(out.startsWith("Zoonosis activas mejora 10%")).toBe(true);
  });

  it("renders a percentage-POINTS delta with a 'pts' suffix, never '%' (H9)", () => {
    // cobertura is a percentage KPI → its delta is percentage points. The
    // sentence must read "28 pts", not "28%" (the misleading relative-% form).
    const out = buildPanoramaReading([kpi("cobertura", 28, "up", "pts")]);
    expect(out).toBe(
      "Cobertura antirrábica mejora 28 pts vs período anterior; 1 de 1 indicadores mejora.",
    );
  });
});

describe("buildPanoramaReading — valence × direction verbs", () => {
  it("cobertura up → mejora (good-up KPI)", () => {
    const out = buildPanoramaReading([kpi("cobertura", 7, "up")]);
    expect(out).toBe(
      "Cobertura antirrábica mejora 7% vs período anterior; 1 de 1 indicadores mejora.",
    );
  });

  it("cobertura down → empeora (good-up KPI falling)", () => {
    const out = buildPanoramaReading([kpi("cobertura", -7, "down")]);
    expect(out.startsWith("Cobertura antirrábica empeora 7%")).toBe(true);
  });

  it("mordeduras up → empeora (bad-up KPI rising)", () => {
    const out = buildPanoramaReading([kpi("mordeduras", 15, "up")]);
    expect(out.startsWith("Mordeduras empeora 15%")).toBe(true);
  });

  it("zoonosis down → mejora (bad-up KPI falling)", () => {
    const out = buildPanoramaReading([kpi("zoonosis", -4, "down")]);
    expect(out.startsWith("Zoonosis activas mejora 4%")).toBe(true);
  });
});

describe("buildPanoramaReading — count suffix agreement", () => {
  it("uses singular 'mejora' when exactly one indicator improves", () => {
    // mordeduras +12 empeora; cobertura +3 mejora → "1 de 2 indicadores mejora."
    const out = buildPanoramaReading([kpi("mordeduras", 12, "up"), kpi("cobertura", 3, "up")]);
    expect(out.endsWith("1 de 2 indicadores mejora.")).toBe(true);
  });

  it("counts flat deltas in the denominator but never as improving", () => {
    // cobertura +5 mejora (headline); mordeduras flat → Y=2, X=1.
    const out = buildPanoramaReading([kpi("cobertura", 5, "up"), kpi("mordeduras", 0, "flat")]);
    expect(out).toBe(
      "Cobertura antirrábica mejora 5% vs período anterior; 1 de 2 indicadores mejora.",
    );
  });

  it("KPIs without a delta are excluded from the denominator", () => {
    // mascotas/perdidas carry NO delta (state metrics) — Y counts only delta carriers.
    const out = buildPanoramaReading([kpi("mascotas"), kpi("cobertura", 5, "up"), kpi("perdidas")]);
    expect(out.endsWith("1 de 1 indicadores mejora.")).toBe(true);
  });
});

describe("buildPanoramaReading — fallback", () => {
  it("returns the fixed fallback when no KPI carries a delta", () => {
    expect(buildPanoramaReading([kpi("mascotas"), kpi("perdidas")])).toBe(FALLBACK);
  });

  it("returns the fixed fallback for an empty KPI list", () => {
    expect(buildPanoramaReading([])).toBe(FALLBACK);
  });

  it("returns the fixed fallback when every delta is flat (no material variation)", () => {
    const out = buildPanoramaReading([kpi("cobertura", 0, "flat"), kpi("mordeduras", 0, "flat")]);
    expect(out).toBe(FALLBACK);
  });
});

describe("buildPanoramaReading — absolute anchor (design-QA 2026-07-04 fast-follow)", () => {
  it("appends the cobertura anchor when cobertura headlines and carries a % display value", () => {
    const out = buildPanoramaReading([
      { id: "cobertura", delta: { pct: -20, direction: "down" }, value: "42%" },
      kpi("mordeduras", 8, "up"),
    ]);
    expect(out).toBe(
      "Cobertura antirrábica empeora 20% vs período anterior; 0 de 2 indicadores mejoran; cobertura actual 42%.",
    );
  });

  it("appends the esterilización anchor when it headlines (forward-looking: delta pending backend)", () => {
    const out = buildPanoramaReading([
      { id: "esterilizacion", delta: { pct: 6, direction: "up" }, value: "38%" },
    ]);
    expect(out).toBe(
      "Cobertura de esterilización mejora 6% vs período anterior; 1 de 1 indicadores mejora; esterilización actual 38%.",
    );
  });

  it("does NOT anchor when a non-compliance KPI headlines, even if values are present", () => {
    const out = buildPanoramaReading([
      { id: "mordeduras", delta: { pct: 12, direction: "up" }, value: "3,4" },
      { id: "cobertura", delta: { pct: 5, direction: "up" }, value: "42%" },
    ]);
    // cobertura's value must not leak into a mordeduras headline.
    expect(out).toBe("Mordeduras empeora 12% vs período anterior; 1 de 2 indicadores mejora.");
  });

  it("ignores a display value that is not a percentage (privacy: echo-only, never compute)", () => {
    const out = buildPanoramaReading([
      { id: "cobertura", delta: { pct: 5, direction: "up" }, value: "3" },
    ]);
    expect(out).toBe(
      "Cobertura antirrábica mejora 5% vs período anterior; 1 de 1 indicadores mejora.",
    );
  });

  it("omits the anchor when the headline KPI carries no display value", () => {
    const out = buildPanoramaReading([kpi("cobertura", 7, "up")]);
    expect(out).toBe(
      "Cobertura antirrábica mejora 7% vs período anterior; 1 de 1 indicadores mejora.",
    );
  });
});

describe("buildPanoramaReading — unknown KPI ids (safety)", () => {
  it("ignores ids outside the known valence map for headline and counts", () => {
    // A future/unknown KPI with a huge delta must not fabricate a headline —
    // valence (mejora/empeora) is undefined for it.
    const out = buildPanoramaReading([kpi("nueva-metrica", 99, "up"), kpi("cobertura", 5, "up")]);
    expect(out).toBe(
      "Cobertura antirrábica mejora 5% vs período anterior; 1 de 1 indicadores mejora.",
    );
  });

  it("falls back when only unknown ids carry deltas", () => {
    expect(buildPanoramaReading([kpi("nueva-metrica", 99, "up")])).toBe(FALLBACK);
  });
});

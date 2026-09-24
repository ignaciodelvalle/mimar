// buildAllSuppressedNotice — the "everything on this map is hidden" disclosure.
//
// PRE-PUSH REVIEW 2026-07-30. The card's gate is `suppressedCount === 0 → null`.
// The province-grain loaders did not COUNT their suppressed cells (the envelope
// field was optional and the cube path hardcoded 0), so a province map whose
// every polygon was k-anon hatched reported 0 and rendered NO notice at all.
// The values were protected and the operator was told nothing — half-done
// privacy work. These cases pin both halves of the gate at PROVINCE grain, the
// one the defect lived in.

import { describe, expect, it } from "vitest";

import { buildAllSuppressedNotice } from "./all-suppressed-notice";

const CAPTION = { id: "cobertura" as const };

/** A province feature as buildProvinceChoroplethFeatures emits it (geometry null,
 * the k-anon decision carried on `properties.suppressed`). */
const feature = (suppressed: boolean) => ({ properties: { suppressed } });

const activeLayers = (...flags: boolean[]) => [
  { id: "cobertura", level: "locality", features: { features: flags.map(feature) } },
];

/** The same layer plotting PROVINCE polygons — the grain the copy used to
 *  misname as "localidad" no matter what the frame was showing (RA-7 F2). */
const provinceLayers = (...flags: boolean[]) => [
  { id: "cobertura", level: "province", features: { features: flags.map(feature) } },
];

const KPIS = [{ id: "cobertura" as const, label: "Cobertura antirrábica", value: "61%" }];

describe("buildAllSuppressedNotice — province grain", () => {
  it("renders the notice when EVERY province cell is hatched and the count is disclosed", () => {
    const notice = buildAllSuppressedNotice({
      captionLayer: CAPTION,
      states: { cobertura: { active: true, loading: false, suppressedCount: 2 } },
      activeLayers: activeLayers(true, true),
      kpis: KPIS,
    });
    expect(notice).not.toBeNull();
    expect(notice).toContain("privacidad");
  });

  it("stays silent when at least one province paints a real value", () => {
    expect(
      buildAllSuppressedNotice({
        captionLayer: CAPTION,
        states: { cobertura: { active: true, loading: false, suppressedCount: 1 } },
        activeLayers: activeLayers(true, false),
        kpis: KPIS,
      }),
    ).toBeNull();
  });

  // THE REGRESSION, stated as a test: a fully-hatched map whose envelope reports
  // 0 suppressed cells produces NO notice. That is exactly what the province
  // loaders (and the cube province path) shipped before this fix — the map was
  // 100% grey and nothing on screen said why. If a future loader stops counting,
  // this case documents the consequence rather than letting it pass unnoticed.
  it("a fully-hatched map reporting suppressedCount 0 renders nothing — the defect this fix closes", () => {
    expect(
      buildAllSuppressedNotice({
        captionLayer: CAPTION,
        states: { cobertura: { active: true, loading: false, suppressedCount: 0 } },
        activeLayers: activeLayers(true, true),
        kpis: KPIS,
      }),
    ).toBeNull();
  });

  it("appends the scope aggregate from the layer's own headline KPI", () => {
    const notice = buildAllSuppressedNotice({
      captionLayer: CAPTION,
      states: { cobertura: { active: true, loading: false, suppressedCount: 3 } },
      activeLayers: activeLayers(true, true, true),
      kpis: KPIS,
    });
    expect(notice).toContain("Cobertura antirrábica: 61%");
  });
});

// ---------------------------------------------------------------------------
// RA-7 F2 — the card asserted a zero and admitted a gap in the same breath.
//
// The mortality headline is Σ of the province choropleth cells and SKIPS the
// k-anon-suppressed ones. That skip is deliberate and well argued: including
// them would let a reader recover each hidden cell by subtracting the visible
// provinces (the differencing attack). But this card is composed in EXACTLY the
// frame where every plotted unit is suppressed — so that sum is a sum over
// nothing, and the card published it as "el total del alcance".
//
// Concrete: an operator scoped to one province with 1-4 deceased read
// "Mortalidad registrada: 0 en el total del alcance" on a card whose first
// clause says the detail is hidden. On a public-health console a confident zero
// does not read as "protegido" — it reads as "nadie se murió".
// ---------------------------------------------------------------------------
describe("buildAllSuppressedNotice — RA-7 F2, the zero it must not republish", () => {
  const mortalityFrame = (kpiValue: string) =>
    buildAllSuppressedNotice({
      captionLayer: { id: "mortalidad" as const },
      states: { mortalidad: { active: true, loading: false, suppressedCount: 1 } },
      activeLayers: [
        { id: "mortalidad", level: "province", features: { features: [feature(true)] } },
      ],
      kpis: [{ id: "mortalidad" as const, label: "Mortalidad registrada", value: kpiValue }],
    });

  it("drops the aggregate entirely when the headline reads zero", () => {
    const notice = mortalityFrame("0");
    expect(notice).not.toBeNull();
    // The exact string the review measured on screen.
    expect(notice).not.toContain("Mortalidad registrada: 0");
    expect(notice).not.toContain("0");
    // ...but the privacy explanation stays: the map is still fully hatched and
    // the operator still needs to know why.
    expect(notice).toContain("protegido por privacidad");
  });

  it("drops a formatted zero too — «0%», «0,0%» are the same false floor", () => {
    expect(mortalityFrame("0%")).not.toContain("0%");
    expect(mortalityFrame("0,0%")).not.toContain("0,0%");
  });

  it("still publishes a NON-zero headline — the card is not silenced wholesale", () => {
    const notice = mortalityFrame("1.204");
    expect(notice).toContain("Mortalidad registrada: 1.204");
  });

  it("never calls the headline «el total del alcance»", () => {
    // The dishonest half was the FRAMING, not just the zero: this card cannot
    // know how a headline was derived, only that it is the number already on
    // screen in the metrics column.
    const notice = mortalityFrame("1.204");
    expect(notice).not.toContain("en el total del alcance");
    expect(notice).toContain("valor publicado para el alcance");
  });
});

describe("buildAllSuppressedNotice — the card names the grain it is describing", () => {
  it("says «por provincia» when the frame plots provinces", () => {
    const notice = buildAllSuppressedNotice({
      captionLayer: CAPTION,
      states: { cobertura: { active: true, loading: false, suppressedCount: 2 } },
      activeLayers: provinceLayers(true, true),
      kpis: KPIS,
    });
    expect(notice).toContain("Detalle por provincia");
    expect(notice).not.toContain("Detalle por localidad");
  });

  it("says «por localidad» when the frame plots localities", () => {
    const notice = buildAllSuppressedNotice({
      captionLayer: CAPTION,
      states: { cobertura: { active: true, loading: false, suppressedCount: 2 } },
      activeLayers: activeLayers(true, true),
      kpis: KPIS,
    });
    expect(notice).toContain("Detalle por localidad");
  });
});

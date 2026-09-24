// The ON-SCREEN view explanation — de-duplication against its own container.
//
// PO observation (marked-up screenshot, /admin/panorama?preset=sintomas): within
// four lines the screen named the vista 3× and the scope 3× — the scope pill
// ("Nacional · todas las provincias"), the "Vista · Síntomas / vigilancia
// sindrómica" title, and the caption below it repeating BOTH before saying
// anything new. Meanwhile the real numbers in the same column were truncated
// ("Señales de zoonosis (períod…").
//
// `explainViewState` itself is CORRECT for its other three consumers (Copiar
// vista, the informe, the embed): a sentence that travels alone needs its
// subject. This is the presentation-site trim, and it is judged by ONE rule:
// does the string state something its container has not already stated?

import { describe, expect, it } from "vitest";

import { DEFAULT_VIEW_STATE, makeViewState } from "@/src/modules/panorama/domain/view-state";
import { explainViewState } from "@/src/modules/panorama/domain/view-state-caption";

import { screenViewExplanation } from "../view-explanation-screen";

describe("screenViewExplanation — the caption drops what its container already says", () => {
  // Axis B (universal to all 14 vistas): the sentence opens with
  // "{vista} — {alcance}" while the screen prints "Vista · {vista}" directly
  // above it and the scope inside its own selector.
  it("drops the vista head and the scope phrase — the header states both", () => {
    const v = makeViewState({
      preset: "brotes-activos",
      layers: ["cobertura", "zoonosis"],
      period: { kind: "preset", preset: "90d" },
    });

    expect(screenViewExplanation(v)).toBe(
      "Últimos 90 días. Capas: Cobertura antirrábica (perros, 12m), Zoonosis / señales.",
    );
  });

  // Axis A: exactly one vista today carries a layer whose label IS the vista's
  // own label (preset `sintomas`). Listing it under "Capas" spends a whole line
  // repeating the title.
  it("drops the layer whose label is the vista's own label, and says the list is partial", () => {
    const v = makeViewState({
      preset: "sintomas",
      layers: ["zoonosis", "sintomas"],
      period: { kind: "preset", preset: "30d" },
    });

    expect(screenViewExplanation(v)).toBe("Últimos 30 días. Otra capa: Zoonosis / señales.");
  });

  it("keeps the plain 'Capas:' wording when no layer was dropped", () => {
    const v = makeViewState({
      preset: "sintomas",
      layers: ["zoonosis", "mordeduras"],
      period: { kind: "preset", preset: "30d" },
    });

    expect(screenViewExplanation(v)).toBe(
      "Últimos 30 días. Capas: Zoonosis / señales, Mordeduras / antirrábica.",
    );
  });

  it("omits the layers clause entirely when the vista names the only active layer", () => {
    const v = makeViewState({
      preset: "sintomas",
      layers: ["sintomas"],
      period: { kind: "preset", preset: "30d" },
    });

    expect(screenViewExplanation(v)).toBe("Últimos 30 días.");
  });

  // The scope phrase is whatever the shared builder resolved — a province name,
  // a "locality, province" pair, or a bounded operator's jurisdiction list. All
  // of them are already on screen in the scope selector, so all of them go.
  it("drops a province scope", () => {
    const v = makeViewState({
      scope: { kind: "province", province: "AR-B" },
      period: { kind: "preset", preset: "7d" },
    });

    expect(screenViewExplanation(v, { provinceLabel: () => "Buenos Aires" })).toBe(
      "Últimos 7 días.",
    );
  });

  it("drops a locality scope even though its phrase carries a comma", () => {
    const v = makeViewState({
      scope: { kind: "locality", province: "AR-B", locality: "la-plata" },
      period: { kind: "preset", preset: "7d" },
    });

    expect(
      screenViewExplanation(v, {
        provinceLabel: () => "Buenos Aires",
        localityLabel: () => "La Plata",
      }),
    ).toBe("Últimos 7 días.");
  });

  it("drops a bounded operator's multi-jurisdiction scope label (commas and all)", () => {
    const v = makeViewState({ period: { kind: "preset", preset: "7d" } });

    expect(
      screenViewExplanation(v, { boundedScopeLabel: "Tierra del Fuego, Santa Cruz, CABA" }),
    ).toBe("Últimos 7 días.");
  });

  // Everything the container does NOT state survives verbatim.
  //
  // ADJUSTED (review 2026-08-22, M7): this used to pair `verifiedOnly: true`
  // with layers: ["zoonosis"] — a layer that ignores the toggle — and assert the
  // phrase survives, pinning the very defect. The verified filter is now
  // declared only when an active layer honours it, so cobertura rides along to
  // keep the assertion about "what survives the container", not about a filter
  // nothing applied.
  it("keeps the as-of cut, the basis, the verified filter and the encoding", () => {
    const v = makeViewState({
      preset: "brotes-activos",
      layers: ["cobertura", "zoonosis"],
      period: { kind: "preset", preset: "30d" },
      asOf: "2026-05-01T00:00:00.000Z",
      basis: "transaction",
      verifiedOnly: true,
      encoding: "bivariate",
    });

    expect(screenViewExplanation(v)).toBe(
      "Últimos 30 días, al 1 de mayo de 2026 (tiempo de transacción), solo con firma veterinaria, riesgo combinado (bivariado). Capas: Cobertura antirrábica (perros, 12m), Zoonosis / señales.",
    );
  });

  // The other half of the same rule: with only a layer that ignores the toggle,
  // the phrase must be gone — a shared/printed artefact may not declare a filter
  // that changed none of its numbers.
  it("drops the verified filter when no active layer honours it", () => {
    const v = makeViewState({
      preset: "brotes-activos",
      layers: ["zoonosis"],
      period: { kind: "preset", preset: "30d" },
      verifiedOnly: true,
    });

    expect(screenViewExplanation(v)).not.toContain("solo con firma veterinaria");
  });

  it("keeps a current-state view's 'estado actual' rather than inventing a window", () => {
    const v = makeViewState({ preset: "cumplimiento", layers: ["cobertura"] });

    expect(screenViewExplanation(v)).toBe(
      "Estado actual. Capas: Cobertura antirrábica (perros, 12m).",
    );
  });

  it("keeps a custom period's date range", () => {
    const v = makeViewState({
      period: { kind: "custom", from: "2026-01-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" },
    });

    expect(screenViewExplanation(v)).toBe("Del 1 de enero de 2026 al 31 de marzo de 2026.");
  });

  // The shared builder is the single source of truth; this trim is a projection
  // of it, never a second copy of the phrasing.
  it("never states more than the shared builder does", () => {
    const v = makeViewState({
      preset: "sintomas",
      layers: ["zoonosis", "sintomas"],
      period: { kind: "preset", preset: "30d" },
    });
    const full = explainViewState(v);

    expect(full.length).toBeGreaterThan(screenViewExplanation(v).length);
    expect(full).toContain("últimos 30 días");
  });

  it("survives a view with no preset (the 'personalizada' head is dropped too)", () => {
    expect(screenViewExplanation(DEFAULT_VIEW_STATE)).toBe("Últimos 3 años.");
  });
});

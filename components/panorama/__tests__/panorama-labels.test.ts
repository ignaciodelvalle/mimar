import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  activeVistaName,
  countFiltroModifiers,
  describeCapasMeta,
  filtroBadgeAriaLabel,
  legendRampEndpointLabels,
  legendRampTitle,
  shortKpiLabel,
  shortLayerLabel,
} from "@/components/panorama/panorama-labels";
import { PANORAMA_DEFAULT_PRESET } from "@/lib/analytics/analytics-period";
import { PANORAMA_LAYERS, getLayer } from "@/src/modules/panorama/domain/layers";
import { PANORAMA_PRESETS, presetLayerIds } from "@/src/modules/panorama/domain/presets";
import type { PanoramaKpiId } from "@/src/modules/panorama/domain/types";

// Canonical KPI labels (mirror get-panorama-kpis.ts — kept here so the de-dup
// snapshot documents the BEFORE→AFTER without importing the server module).
const CANONICAL_KPI: Record<PanoramaKpiId, string> = {
  cobertura: "Cobertura antirrábica (perros, 12m)",
  esterilizacion: "Cobertura de esterilización",
  microchip: "Microchip",
  ppp: "Registro PPP",
  perdidas: "Pérdidas activas",
  reunificacion: "Tasa de reunificación",
  mordeduras: "Mordeduras / 10k hab.",
  zoonosis: "Zoonosis activas",
  denuncias: "Denuncias activas",
  mortalidad: "Mortalidad registrada",
};

describe("activeVistaName", () => {
  it("returns the preset label, or null in manual mode", () => {
    expect(activeVistaName("perdidas-reunificacion")).toBe("Pérdidas y reunificación");
    expect(activeVistaName(null)).toBeNull();
  });
});

describe("de-dup — shortKpiLabel / shortLayerLabel", () => {
  it('drops the vista stem: "Pérdidas activas" → "Activas" under Pérdidas y reunificación', () => {
    expect(shortKpiLabel("perdidas-reunificacion", "perdidas", CANONICAL_KPI.perdidas)).toBe(
      "Activas",
    );
  });

  it("keeps semantically-risky labels canonical (Tasa de reunificación)", () => {
    expect(
      shortKpiLabel("perdidas-reunificacion", "reunificacion", CANONICAL_KPI.reunificacion),
    ).toBe("Tasa de reunificación");
  });

  it("shortens layer rows under the vista heading", () => {
    expect(shortLayerLabel("sintomas", "sintomas", getLayer("sintomas")!.label)).toBe("Síntomas");
    expect(shortLayerLabel("bienestar", "denuncias", getLayer("denuncias")!.label)).toBe(
      "Denuncias",
    );
    expect(shortLayerLabel("perdidas-reunificacion", "perdidas", getLayer("perdidas")!.label)).toBe(
      "Avistajes",
    );
    expect(
      shortLayerLabel("perdidas-reunificacion", "reunificacion", getLayer("reunificacion")!.label),
    ).toBe("Tasa por unidad");
  });

  it("falls back to canonical when no override exists / manual mode", () => {
    expect(shortKpiLabel(null, "perdidas", CANONICAL_KPI.perdidas)).toBe("Pérdidas activas");
    expect(shortKpiLabel("brotes-activos", "cobertura", CANONICAL_KPI.cobertura)).toBe(
      "Cobertura antirrábica (perros, 12m)",
    );
  });

  // The QA-requested snapshot: every vista's displayed KPI + layer label sets
  // (the catalogue has grown past the 8 this was written for — it walks
  // PANORAMA_PRESETS, so the count is never hardcoded).
  it("snapshots the de-dup output across every vista", () => {
    const snapshot = PANORAMA_PRESETS.map((p) => ({
      vista: p.label,
      kpis: p.metrics.map((id) => shortKpiLabel(p.id, id, CANONICAL_KPI[id])),
      layers: presetLayerIds(p).map((id) => shortLayerLabel(p.id, id, getLayer(id)!.label)),
    }));
    expect(snapshot).toMatchInlineSnapshot(`
      [
        {
          "kpis": [
            "Cobertura antirrábica (perros, 12m)",
            "Zoonosis activas",
            "Mordeduras / 10k hab.",
          ],
          "layers": [
            "Cobertura antirrábica (perros, 12m)",
            "Zoonosis / señales",
          ],
          "vista": "Señales de brote",
        },
        {
          "kpis": [
            "Zoonosis activas",
            "Mordeduras / 10k hab.",
            "Denuncias activas",
          ],
          "layers": [
            "Síntomas",
            "Zoonosis / señales",
          ],
          "vista": "Síntomas / vigilancia sindrómica",
        },
        {
          "kpis": [
            "Cobertura antirrábica (perros, 12m)",
            "Cobertura de esterilización",
            "Microchip",
          ],
          "layers": [
            "Cobertura antirrábica (perros, 12m)",
          ],
          "vista": "Cumplimiento",
        },
        {
          "kpis": [
            "Denuncias activas",
            "Mordeduras / 10k hab.",
          ],
          "layers": [
            "Denuncias",
            "Decomisos",
          ],
          "vista": "Bienestar y fiscalización",
        },
        {
          "kpis": [
            "Mortalidad registrada",
            "Cobertura de esterilización",
          ],
          "layers": [
            "Mortalidad / disposición",
          ],
          "vista": "Mortalidad",
        },
        {
          "kpis": [
            "Activas",
            "Tasa de reunificación",
          ],
          "layers": [
            "Avistajes",
            "Tasa por unidad",
          ],
          "vista": "Pérdidas y reunificación",
        },
        {
          "kpis": [
            "Cobertura antirrábica (perros, 12m)",
            "Cobertura de esterilización",
          ],
          "layers": [
            "Desierto veterinario (% sin atención registrada)",
            "Clínicas veterinarias",
            "Refugios",
          ],
          "vista": "Desierto veterinario",
        },
        {
          "kpis": [
            "Cobertura antirrábica (perros, 12m)",
            "Cobertura de esterilización",
          ],
          "layers": [
            "Acceso veterinario (actos/1.000)",
            "Clínicas veterinarias",
            "Refugios",
          ],
          "vista": "Acceso veterinario",
        },
        {
          "kpis": [
            "Mordeduras / 10k hab.",
            "Pérdidas activas",
            "Denuncias activas",
          ],
          "layers": [
            "Tendencia de eventos (Δ vs período anterior)",
          ],
          "vista": "Tendencia",
        },
        {
          "kpis": [
            "Mordeduras / 10k hab.",
            "Registro PPP",
            "Microchip",
          ],
          "layers": [
            "Registro PPP (C7)",
            "Mordeduras / antirrábica",
          ],
          "vista": "Mordeduras sobre bajo registro PPP",
        },
        {
          "kpis": [
            "Cobertura antirrábica (perros, 12m)",
            "Cobertura de esterilización",
            "Microchip",
          ],
          "layers": [
            "Índice territorial (0-100)",
          ],
          "vista": "Índice territorial",
        },
      ]
    `);
  });
});

describe("countFiltroModifiers", () => {
  it("counts 0 for a vista at its defaults (base only, default period, no toggles)", () => {
    expect(
      countFiltroModifiers({
        activeLayerIds: ["cobertura"],
        presetId: "cumplimiento",
        baseLayerId: "cobertura",
        activePeriod: "90d",
        verifiedOnly: false,
      }),
    ).toBe(0);
  });

  it("counts active overlay layers (signal + reference), never the base", () => {
    // cumplimiento default base (cobertura) + a zoonosis signal overlay.
    expect(
      countFiltroModifiers({
        activeLayerIds: ["cobertura", "zoonosis"],
        presetId: "cumplimiento",
        baseLayerId: "cobertura",
        activePeriod: "90d",
        verifiedOnly: false,
      }),
    ).toBe(1);
  });

  it("counts a non-default period as one deviation", () => {
    expect(
      countFiltroModifiers({
        activeLayerIds: ["cobertura"],
        presetId: "cumplimiento",
        baseLayerId: "cobertura",
        activePeriod: "30d", // cumplimiento default is 90d
        verifiedOnly: false,
      }),
    ).toBe(1);
  });

  it("counts a re-based base layer as one deviation", () => {
    expect(
      countFiltroModifiers({
        activeLayerIds: ["mortalidad"],
        presetId: "cumplimiento", // default base is cobertura
        baseLayerId: "mortalidad", // NOT one of the vista's metric options
        activePeriod: "90d",
        verifiedOnly: false,
      }),
    ).toBe(1);
  });

  it("D1: a metric-option base is a vista DEFAULT, not a deviation (badge stays 0)", () => {
    // Switching cumplimiento's selector to Esterilización re-bases the map, but
    // that base is one of the vista's declared metrics — counting it would make
    // every metric switch read as a hand-modified board.
    for (const base of ["esterilizacion", "ppp", "microchip", "antiparasitario"] as const) {
      expect(
        countFiltroModifiers({
          activeLayerIds: [base],
          presetId: "cumplimiento",
          baseLayerId: base,
          activePeriod: "90d",
          verifiedOnly: false,
        }),
        base,
      ).toBe(0);
    }
  });

  it("counts verifiedOnly as one deviation", () => {
    expect(
      countFiltroModifiers({
        activeLayerIds: ["cobertura"],
        presetId: "cumplimiento",
        baseLayerId: "cobertura",
        activePeriod: "90d",
        verifiedOnly: true,
      }),
    ).toBe(1);
  });

  // Review 2026-08-22 (M7). The toggle is sticky — it survives a base-layer
  // change and rides in the URL — but it narrows ONLY the cobertura numerator.
  // Counting it while no layer on screen applies it makes the badge claim a
  // modifier that changed none of the numbers.
  it("does NOT count verifiedOnly when no active layer honours it", () => {
    expect(
      countFiltroModifiers({
        activeLayerIds: ["indice-territorial"],
        presetId: null,
        baseLayerId: "indice-territorial",
        activePeriod: PANORAMA_DEFAULT_PRESET,
        verifiedOnly: true,
      }),
    ).toBe(0);
  });

  it("still counts verifiedOnly when cobertura is active under another base", () => {
    // cobertura as a non-base active layer still applies the narrowing, so the
    // badge is honest about it.
    expect(
      countFiltroModifiers({
        activeLayerIds: ["cobertura", "indice-territorial"],
        presetId: null,
        baseLayerId: "indice-territorial",
        activePeriod: PANORAMA_DEFAULT_PRESET,
        verifiedOnly: true,
      }),
    ).toBe(1);
  });

  it("sums overlays + all deviations", () => {
    expect(
      countFiltroModifiers({
        activeLayerIds: ["cobertura", "zoonosis"], // +1 overlay
        presetId: "cumplimiento",
        baseLayerId: "cobertura",
        activePeriod: "30d", // +1 period
        verifiedOnly: true, // +1 verified
      }),
    ).toBe(3);
  });

  it("in manual mode uses the app default period as the baseline", () => {
    expect(
      countFiltroModifiers({
        activeLayerIds: ["cobertura"],
        presetId: null,
        baseLayerId: "cobertura",
        activePeriod: PANORAMA_DEFAULT_PRESET,
        verifiedOnly: false,
      }),
    ).toBe(0);
    expect(
      countFiltroModifiers({
        activeLayerIds: ["cobertura"],
        presetId: null,
        baseLayerId: "cobertura",
        activePeriod: PANORAMA_DEFAULT_PRESET === "3y" ? "30d" : "3y",
        verifiedOnly: false,
      }),
    ).toBe(1);
  });
});

describe("describeCapasMeta / filtroBadgeAriaLabel — the badge stops masquerading as a layer count (Item 3)", () => {
  it("names BOTH facts: real active layers AND modifiers over the vista", () => {
    expect(describeCapasMeta({ activeLayerCount: 2, modifierCount: 1 })).toBe(
      "2 capas activas · 1 ajuste sobre la vista",
    );
  });

  it("pluralizes each fact independently", () => {
    expect(describeCapasMeta({ activeLayerCount: 1, modifierCount: 3 })).toBe(
      "1 capa activa · 3 ajustes sobre la vista",
    );
    expect(describeCapasMeta({ activeLayerCount: 0, modifierCount: 0 })).toBe(
      "0 capas activas · 0 ajustes sobre la vista",
    );
  });

  it("badge aria-label names what the number counts (not a bare integer)", () => {
    expect(filtroBadgeAriaLabel(1)).toBe("1 ajuste sobre la vista");
    expect(filtroBadgeAriaLabel(3)).toBe("3 ajustes sobre la vista");
  });
});

describe("legendRampTitle — the collapsed legend pill names the layer that PAINTED the ramp", () => {
  it("A2 regression: a DRILLED division count ramp is titled by the base choropleth, not the signal overlay", () => {
    // Custom vista, zoonosis + cobertura active, drilled to departments.
    // captionLayer = the first active non-reference layer = "Zoonosis / señales"
    // (it precedes cobertura in the catalogue), but the ramp is cobertura's
    // department COUNT fill. The title must follow the ramp, demoted to counts.
    expect(
      legendRampTitle({
        bivariateActive: false,
        captionLabel: "Zoonosis / señales",
        captionPaintsProvinceRamp: false,
        divisionRampLabel: "Cobertura antirrábica (perros, 12m)",
      }),
    ).toBe("Cobertura antirrábica (perros, 12m) (conteo)");
  });

  it("titles by the caption layer when IT paints its own province-grain ramp", () => {
    // At province grain cobertura paints its own classed % ramp — the caption
    // layer IS the paint, so it keeps its (rate) label with no count demotion.
    expect(
      legendRampTitle({
        bivariateActive: false,
        captionLabel: "Cobertura antirrábica (perros, 12m)",
        captionPaintsProvinceRamp: true,
        divisionRampLabel: null,
      }),
    ).toBe("Cobertura antirrábica (perros, 12m)");
  });

  it("bivariate matrix overrides both", () => {
    expect(
      legendRampTitle({
        bivariateActive: true,
        captionLabel: "Cobertura antirrábica (perros, 12m)",
        captionPaintsProvinceRamp: true,
        divisionRampLabel: "Cobertura antirrábica (perros, 12m)",
      }),
    ).toBe("Intensidad combinada");
  });

  it("no ramp at all → falls back to the caption label (names the point overlay's dots)", () => {
    expect(
      legendRampTitle({
        bivariateActive: false,
        captionLabel: "Zoonosis / señales",
        captionPaintsProvinceRamp: false,
        divisionRampLabel: null,
      }),
    ).toBe("Zoonosis / señales");
  });

  it("no ramp and no caption → the generic graduated fallback", () => {
    expect(
      legendRampTitle({
        bivariateActive: false,
        captionLabel: null,
        captionPaintsProvinceRamp: false,
        divisionRampLabel: null,
      }),
    ).toBe("Eventos por unidad");
  });
});

// Live on /admin/panorama?preset=mortalidad, 2026-07-25: values ran 1–63 and
// the ramp read "2 … 6". liftedBreaks are the INTERIOR class boundaries, so
// treating the first/last as the data extremes understates the range — on a
// surface the operator can export as a PNG with a state seal on it.
describe("legendRampEndpointLabels — the ramp describes the DATA, not the classifier", () => {
  const layer = { dataType: "density" as const };

  it("prints the true extremes, not the interior class breaks", () => {
    const out = legendRampEndpointLabels({
      bivariateActive: false,
      captionLayer: layer,
      liftedBreaks: [2, 3, 4, 6],
      divisionLegend: { hasRamp: true, min: 1, max: 63 },
    });
    expect(out).toEqual({ min: "1", max: "63" });
  });

  // P1-F3 (external design review, 2026-07-27): the fix above only ever covered
  // the DIVISION branch. A province choropleth has no divisionLegend, so it kept
  // reading the interior breaks — Mortalidad published "4 … 15" and the vet
  // desert "67 … 79" against a real national range of 24,6 → 80,7. Same defect,
  // same exportable PNG, one branch over.
  it("prints the true PROVINCE extremes when there is no division ramp", () => {
    const out = legendRampEndpointLabels({
      bivariateActive: false,
      captionLayer: layer,
      liftedBreaks: [30, 45, 60, 75],
      divisionLegend: null,
      provinceExtent: { min: 24.6, max: 80.7 },
    });
    expect(out).toEqual({ min: "25", max: "81" });
  });

  it("prefers the division ramp over the province extent when both are present", () => {
    const out = legendRampEndpointLabels({
      bivariateActive: false,
      captionLayer: layer,
      liftedBreaks: [2, 3, 4, 6],
      divisionLegend: { hasRamp: true, min: 1, max: 63 },
      provinceExtent: { min: 24.6, max: 80.7 },
    });
    expect(out).toEqual({ min: "1", max: "63" });
  });

  // The breaks stay as the LAST resort — when neither extent is known there is
  // nothing better to print. This is no longer the province path's normal case.
  it("falls back to the breaks only when NEITHER extent is available", () => {
    const out = legendRampEndpointLabels({
      bivariateActive: false,
      captionLayer: layer,
      liftedBreaks: [2, 3, 4, 6],
      divisionLegend: null,
    });
    expect(out).toEqual({ min: "2", max: "6" });
  });

  it("a censored bound still wins over the data max — it is where measuring stopped", () => {
    const out = legendRampEndpointLabels({
      bivariateActive: false,
      captionLayer: { dataType: "density", censoredAtMax: 90 },
      liftedBreaks: [30, 60, 90],
      divisionLegend: { hasRamp: true, min: 4, max: 90 },
    });
    expect(out?.max).toBe("≥90");
    expect(out?.min).toBe("4");
  });

  it("a compliance target still names the meta, not the data max", () => {
    const out = legendRampEndpointLabels({
      bivariateActive: false,
      captionLayer: { dataType: "rate", complianceTarget: 80 },
      liftedBreaks: [20, 40, 60],
      divisionLegend: { hasRamp: true, min: 12, max: 71 },
    });
    expect(out).toEqual({ min: "12%", max: "80% meta" });
  });
});

// P1-F1 + PO decision D4: the ramp encodes polarity in colour (dark = alarm),
// and colour cannot be the only carrier of meaning — the same WCAG 1.4.1 rule
// the tone glyphs already honour. The captured legend read
// "Acceso veterinario (actos/1.000) (conteo) · 5 → 2.184" with no way to know
// which end was the bad news, and for that layer the bad news is the LOW one.
describe("legendRampEndpointLabels — the endpoints say which end is the alarm", () => {
  const layer = { dataType: "density" as const };

  it("marks the LOW end worse by default (higher = more of a bad thing)", () => {
    const out = legendRampEndpointLabels({
      bivariateActive: false,
      captionLayer: layer,
      liftedBreaks: [2, 4, 6],
      divisionLegend: null,
      provinceExtent: { min: 1, max: 9 },
      higherIsBetter: false,
    });
    expect(out).toEqual({ min: "1 · mejor", max: "9 · peor" });
  });

  it("flips the marks when the layer declares higher-is-better", () => {
    const out = legendRampEndpointLabels({
      bivariateActive: false,
      captionLayer: layer,
      liftedBreaks: [2, 4, 6],
      divisionLegend: null,
      provinceExtent: { min: 1, max: 9 },
      higherIsBetter: true,
    });
    expect(out).toEqual({ min: "1 · peor", max: "9 · mejor" });
  });

  it("says nothing about polarity when the caller does not declare one", () => {
    const out = legendRampEndpointLabels({
      bivariateActive: false,
      captionLayer: layer,
      liftedBreaks: [2, 4, 6],
      divisionLegend: null,
      provinceExtent: { min: 1, max: 9 },
    });
    expect(out).toEqual({ min: "1", max: "9" });
  });

  // The three cases above are exercised with a SYNTHETIC layer (`{ dataType:
  // "density" }`), so they proved the function's behaviour and nothing about
  // what the real registry declares — or about what the console passes it.
  //
  // Live review 2026-07-28 (P1-1) found the gap between them: every
  // compliance layer leaves `higherIsBetter` undefined (it declares a
  // `complianceTarget` instead, and on the meta path "dark = meta cumplida" is
  // the reading — class-scale.ts:70), but PanoramaConsole passed
  // `captionLayer?.higherIsBetter === true`, collapsing undefined into false.
  // Six vistas printed "40% · mejor" with the PALEST swatch on the "mejor" side.
  //
  // Driving the REAL layers through the real function is what neither the unit
  // tests nor the console tests were doing.
  // Writing this pinned a distinction the review had not drawn: having a meta
  // and having a polarity are INDEPENDENT. The five legal-coverage layers carry
  // a meta and no polarity; `indice-territorial` — the composite scorecard —
  // carries BOTH, and for it "more is better" is genuinely true. Passing the
  // tri-state through is what lets one function serve both; the `=== true`
  // coercion served neither.
  const complianceLayers = () => PANORAMA_LAYERS.filter((l) => l.complianceTarget !== undefined);
  const rampFor = (l: (typeof PANORAMA_LAYERS)[number]) =>
    legendRampEndpointLabels({
      bivariateActive: false,
      captionLayer: l,
      liftedBreaks: [50, 60, 70],
      divisionLegend: null,
      provinceExtent: { min: 40, max: 80 },
      // Exactly what the console forwards now: the field itself, never a
      // boolean coercion of it.
      higherIsBetter: l.higherIsBetter,
    });

  it("the legal-coverage layers declare NO polarity — their meta is the reference", () => {
    const withoutPolarity = complianceLayers().filter((l) => l.higherIsBetter === undefined);
    expect(withoutPolarity.map((l) => l.id).sort()).toEqual([
      "antiparasitario",
      "cobertura",
      "esterilizacion",
      "microchip",
      "ppp",
    ]);
    for (const l of withoutPolarity) {
      const out = rampFor(l);
      // Asserted, not `!`-asserted: a layer that produced NO ramp would satisfy
      // "carries no polarity word" for the wrong reason.
      expect(out, `${l.id} produced no ramp at all`).not.toBeNull();
      expect(`${out?.min} ${out?.max}`, `${l.id} leaked a polarity word`).not.toMatch(/mejor|peor/);
    }
  });

  // Everything above tests the FUNCTION. The bug was never in the function —
  // it was in the one call site, and every test in this file would have stayed
  // green through it. Re-adding `=== true` in PanoramaConsole.tsx today still
  // passes all 32 assertions above. So the call site gets its own guard, in the
  // repo's established source-fence idiom (scripts/check-action-redirect.ts,
  // check-scope-discipline.ts). A boolean coercion here is not a style
  // preference: it is the deletion of a third state the ramp depends on.
  it("PanoramaConsole forwards the tri-state and never coerces it", () => {
    const source = readFileSync("components/panorama/PanoramaConsole.tsx", "utf8");
    const forwards = /higherIsBetter:\s*captionLayer\?\.higherIsBetter\s*,/.test(source);
    const coerces = /higherIsBetter:\s*captionLayer\?\.higherIsBetter\s*===\s*true/.test(source);
    expect(forwards, "the console must pass higherIsBetter through untouched").toBe(true);
    expect(coerces, "`=== true` collapses undefined into false — the P1-1 regression").toBe(false);
  });

  it("a meta layer that DOES declare higher-is-better keeps its marks", () => {
    const withPolarity = complianceLayers().filter((l) => l.higherIsBetter !== undefined);
    // Exactly one today: the composite territorial index.
    expect(withPolarity.map((l) => l.id)).toEqual(["indice-territorial"]);
    const out = rampFor(withPolarity[0]);
    expect(out).not.toBeNull();
    // On the HIGH end, which is the whole point of declaring it.
    expect(out?.max).toContain("mejor");
    expect(out?.min).toContain("peor");
  });

  // On a meta layer the MAX endpoint is the target, not the best observed value
  // — "95% meta" is a goal, so calling it "mejor" would assert something about
  // the data that is not there. The MIN is still the worst observed value and
  // gets marked like everywhere else. (First written the other way round, on the
  // reasoning that "meta" alone conveys direction; that saves four characters
  // and loses the reader on the end that actually matters.)
  it("marks the low end but never the target: 'meta' is a goal, not a best value", () => {
    const out = legendRampEndpointLabels({
      bivariateActive: false,
      captionLayer: { dataType: "rate" as const, complianceTarget: 95 },
      liftedBreaks: [10, 40, 70],
      divisionLegend: null,
      provinceExtent: { min: 5, max: 90 },
      higherIsBetter: true,
    });
    expect(out).toEqual({ min: "5% · peor", max: "95% meta" });
  });
});

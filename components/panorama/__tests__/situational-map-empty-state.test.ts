// Unit tests for the SituationalMap empty-state logic.
//
// The empty-state overlay "Sin datos para esta capa {scope}." (scope is
// audience-aware — task #70) must NOT appear when the only active layer is a
// province-choropleth (geometry: null
// features that color the shared basemap polygons) — those layers ARE visible
// on the map even though their features carry no GeoJSON Point geometry.
//
// PR-6: countRenderableFeatures extracts this check as a pure function so it
// can be tested without a DOM or MapLibre runtime.

import { describe, expect, it } from "vitest";

import {
  type ActiveLayerLike,
  countRenderableFeatures,
  emptyOverlayMessage,
  hasProvinceChoroplethLayer,
  resetViewLabel,
} from "@/components/panorama/situational-map-utils";

// Build an ActiveLayerLike stub with a given set of feature geometries.
function makeLayer(
  overrides: Partial<ActiveLayerLike> & {
    featureGeometries?: Array<{ type: "Point"; coordinates: [number, number] } | null>;
  },
): ActiveLayerLike {
  const { featureGeometries = [], ...rest } = overrides;
  return {
    geomType: "point",
    features: {
      type: "FeatureCollection",
      features: featureGeometries.map((g) => ({
        type: "Feature",
        geometry: g as { type: "Point"; coordinates: [number, number] } | null,
        properties: {},
      })),
    },
    ...rest,
  };
}

describe("countRenderableFeatures", () => {
  it("returns 0 when there are no active layers", () => {
    expect(countRenderableFeatures([])).toBe(0);
  });

  it("counts Point features (non-null geometry) as renderable", () => {
    const layer = makeLayer({
      featureGeometries: [
        { type: "Point", coordinates: [-63.6, -40.0] },
        { type: "Point", coordinates: [-64.0, -39.0] },
      ],
    });
    expect(countRenderableFeatures([layer])).toBe(2);
  });

  it("does NOT count null-geometry features (province choropleth carriers)", () => {
    // Province choropleth features carry geometry: null — they color the basemap
    // polygon by data-join, NOT by plotting a GeoJSON Point. They ARE visible on
    // the map (the province fill renders), so the empty-state overlay must not fire.
    const layer = makeLayer({
      geomType: "choropleth",
      level: "province",
      featureGeometries: [null, null, null], // 3 province cells — all null geometry
    });
    expect(countRenderableFeatures([layer])).toBe(0);
    // NOTE: the empty-state should NOT show for a province-choropleth layer
    // even though countRenderableFeatures returns 0 — callers must also check
    // whether any active layer is a province choropleth (hasProvinceChoropleth).
  });

  it("counts mixed layers correctly — only Point geometries are renderable", () => {
    // Province choropleth (null geometry) + point layer with 2 features.
    const choropleth = makeLayer({
      geomType: "choropleth",
      level: "province",
      featureGeometries: [null, null],
    });
    const points = makeLayer({
      geomType: "point",
      featureGeometries: [
        { type: "Point", coordinates: [-63.6, -40.0] },
        { type: "Point", coordinates: [-64.0, -39.0] },
      ],
    });
    expect(countRenderableFeatures([choropleth, points])).toBe(2);
  });

  it("returns 0 for a point layer with all null-geometry features (missing coordinates)", () => {
    // If the seed has no perdidas events in the window, the layer returns
    // an empty FeatureCollection — countRenderableFeatures correctly returns 0
    // and the empty-state overlay fires (correctly, since nothing is visible).
    const layer = makeLayer({ featureGeometries: [] });
    expect(countRenderableFeatures([layer])).toBe(0);
  });
});

describe("hasProvinceChoroplethLayer", () => {
  it("identifies a province-choropleth layer", () => {
    const choropleth = makeLayer({
      geomType: "choropleth",
      level: "province",
      featureGeometries: [null],
    });
    expect(hasProvinceChoroplethLayer([choropleth])).toBe(true);
  });

  it("returns false when no province choropleth is active", () => {
    const point = makeLayer({
      featureGeometries: [{ type: "Point", coordinates: [-63.6, -40.0] }],
    });
    expect(hasProvinceChoroplethLayer([point])).toBe(false);
  });

  it("returns false for locality-level choropleth (those use Point geometry)", () => {
    // Locality choropleths render as graduated centroid circles — they have
    // Point geometry so they ARE counted by countRenderableFeatures.
    const localityChoro = makeLayer({
      geomType: "choropleth",
      level: "locality",
      featureGeometries: [{ type: "Point", coordinates: [-63.6, -40.0] }],
    });
    expect(hasProvinceChoroplethLayer([localityChoro])).toBe(false);
  });
});

describe("emptyOverlayMessage (cowork QA ronda 3 §5 — honest empty copy)", () => {
  it("distinguishes k-anon-protected detail from genuinely no data (privacy §5 / C3)", () => {
    // The aggregate EXISTS (the card shows 64,4%) but every per-unit cell is
    // k-suppressed — this must NOT read as "sin datos" (a contradiction).
    const msg = emptyOverlayMessage({
      rateProvinceOnlyEmpty: false,
      detailKAnonSuppressed: true,
      emptyStateScope: "en este alcance",
    });
    expect(msg).toContain("protegido por privacidad");
    expect(msg).toContain("agregado del alcance sí está disponible");
    expect(msg).not.toContain("Sin datos");
  });

  it("keeps the generic 'Sin datos' copy when there is genuinely no data", () => {
    expect(
      emptyOverlayMessage({
        rateProvinceOnlyEmpty: false,
        detailKAnonSuppressed: false,
        emptyStateScope: "en este alcance",
      }),
    ).toBe("Sin datos para esta capa en este alcance.");
  });

  it("rate-below-province takes precedence over the k-anon copy", () => {
    const msg = emptyOverlayMessage({
      rateProvinceOnlyEmpty: true,
      detailKAnonSuppressed: true,
      emptyStateScope: "en este alcance",
    });
    expect(msg).toContain("solo a nivel provincia");
  });
});

describe("emptyOverlayMessage — surveillance empty (demo review 2026-08-01 #3)", () => {
  it("a surveillance zero is the absence of a claim, NEVER 'buena noticia'", () => {
    // THE FINDING: this branch used to close with "— buena noticia." while the
    // same panel's KPI rail read "activas hoy: 1 (rabia + mordeduras + 30d)".
    // A surveillance layer only sees what somebody reported, so its zero cannot
    // rule anything out — and the copy must say so instead of celebrating.
    const msg = emptyOverlayMessage({
      rateProvinceOnlyEmpty: false,
      detailKAnonSuppressed: false,
      emptyStateScope: "en tu cobertura",
      activeLayerIds: ["zoonosis"],
    });
    expect(msg).toBe(
      "Sin registros de zoonosis en el período. La ausencia de reportes no implica ausencia de casos.",
    );
    expect(msg).not.toContain("buena noticia");
  });

  it("names every active surveillance layer and still refuses the all-clear", () => {
    const msg = emptyOverlayMessage({
      rateProvinceOnlyEmpty: false,
      detailKAnonSuppressed: false,
      emptyStateScope: "en tu cobertura",
      activeLayerIds: ["zoonosis", "mordeduras"],
    });
    expect(msg).toBe(
      "Sin registros de zoonosis ni mordeduras en el período. La ausencia de reportes no implica ausencia de casos.",
    );
    expect(msg).not.toContain("buena noticia");
  });

  it("NO branch of this function is allowed to editorialize an empty as good news", () => {
    // The three empties (degraded / protected / unreported) are three different
    // statements and none of them is an all-clear. Sweep every reachable branch
    // rather than trusting the three spot-checks below to stay exhaustive.
    const branches = [
      { layerDegraded: true, rateProvinceOnlyEmpty: false, detailKAnonSuppressed: false },
      { rateProvinceOnlyEmpty: true, detailKAnonSuppressed: false },
      { rateProvinceOnlyEmpty: false, detailKAnonSuppressed: true },
      { rateProvinceOnlyEmpty: false, detailKAnonSuppressed: false },
    ];
    for (const branch of branches) {
      for (const activeLayerIds of [undefined, ["zoonosis"], ["zoonosis", "refugios"]]) {
        const msg = emptyOverlayMessage({
          ...branch,
          emptyStateScope: "en tu cobertura",
          activeLayerIds,
        });
        expect(msg).not.toContain("buena noticia");
        expect(msg).not.toMatch(/buena|tranquil|todo en orden|sin novedad/i);
      }
    }
  });

  it("keeps the neutral copy when a non-surveillance layer is also active", () => {
    // Refugios being empty is NOT good news — the positive framing only applies
    // when the WHOLE empty view is surveillance layers.
    expect(
      emptyOverlayMessage({
        rateProvinceOnlyEmpty: false,
        detailKAnonSuppressed: false,
        emptyStateScope: "en tu cobertura",
        activeLayerIds: ["zoonosis", "refugios"],
      }),
    ).toBe("Sin datos para esta capa en tu cobertura.");
  });

  it("keeps the neutral copy for a non-surveillance layer alone", () => {
    expect(
      emptyOverlayMessage({
        rateProvinceOnlyEmpty: false,
        detailKAnonSuppressed: false,
        emptyStateScope: "en este alcance",
        activeLayerIds: ["perdidas"],
      }),
    ).toBe("Sin datos para esta capa en este alcance.");
  });

  it("a k-anon-suppressed zero says PROTECTED, never 'sin registros'", () => {
    // Suppressed data is protected, not absent — the k-anon branch must win,
    // and it must not borrow the unreported branch's wording either.
    const msg = emptyOverlayMessage({
      rateProvinceOnlyEmpty: false,
      detailKAnonSuppressed: true,
      emptyStateScope: "en tu cobertura",
      activeLayerIds: ["zoonosis"],
    });
    expect(msg).toContain("protegido por privacidad");
    expect(msg).not.toContain("Sin registros");
  });

  it("a degraded (timed-out) layer says NOT CALCULATED, never 'sin registros'", () => {
    const msg = emptyOverlayMessage({
      layerDegraded: true,
      rateProvinceOnlyEmpty: false,
      detailKAnonSuppressed: false,
      emptyStateScope: "en tu cobertura",
      activeLayerIds: ["mordeduras"],
    });
    expect(msg).toContain("No pudimos calcular");
    expect(msg).not.toContain("Sin registros");
  });

  it("the three empties are three DIFFERENT sentences (no two branches collide)", () => {
    // "no pudimos calcular", "está protegido" and "no hay registros" are the
    // three claims this screen is allowed to make about an empty map. If any
    // two ever render the same string, the operator loses the distinction the
    // Referencias tab promises them.
    const base = { emptyStateScope: "en tu cobertura", activeLayerIds: ["zoonosis"] };
    const degraded = emptyOverlayMessage({
      ...base,
      layerDegraded: true,
      rateProvinceOnlyEmpty: false,
      detailKAnonSuppressed: false,
    });
    const protectedMsg = emptyOverlayMessage({
      ...base,
      rateProvinceOnlyEmpty: false,
      detailKAnonSuppressed: true,
    });
    const unreported = emptyOverlayMessage({
      ...base,
      rateProvinceOnlyEmpty: false,
      detailKAnonSuppressed: false,
    });
    expect(new Set([degraded, protectedMsg, unreported]).size).toBe(3);
  });
});

describe("emptyOverlayMessage — degraded layer (panorama QA 2026-07-14)", () => {
  it("a budget-degraded layer NEVER reads as 'sin datos' — highest-priority branch", () => {
    // The PBA cobertura drill: the live rollup blew the 8s budget, the server
    // returned its empty fallback, and the map painted a silent blank. A
    // timeout is not an empty dataset — say so, with the retry path.
    expect(
      emptyOverlayMessage({
        layerDegraded: true,
        rateProvinceOnlyEmpty: true, // even when other branches also apply
        detailKAnonSuppressed: true,
        emptyStateScope: "en Buenos Aires",
      }),
    ).toBe("No pudimos calcular esta capa a tiempo. Tocá Actualizar para reintentar.");
  });

  it("absent/false degraded keeps every prior branch byte-identical", () => {
    expect(
      emptyOverlayMessage({
        rateProvinceOnlyEmpty: false,
        detailKAnonSuppressed: false,
        emptyStateScope: "en Buenos Aires",
      }),
    ).toBe("Sin datos para esta capa en Buenos Aires.");
  });
});

describe("resetViewLabel (Q12)", () => {
  it("a bounded-jurisdiction govt operator returns to 'mi jurisdicción'", () => {
    expect(resetViewLabel(true)).toBe("Volver a mi jurisdicción");
  });

  it("admin/universal (no personal jurisdiction) returns to 'Vista nacional'", () => {
    // A drilled admin has initialBounds but boundedJurisdiction=false — the copy
    // must NOT claim a jurisdiction the admin does not have.
    expect(resetViewLabel(false)).toBe("Vista nacional");
  });
});

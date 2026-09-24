// panorama-event-points / P4b — unit tests for the near-zoom LOD band.
//
// Pure (no map, no DOM). P4b (ViewState WS-4) replaced the imperative
// `pointsEligible` UX predicate with the declaration-driven `markForZoom`
// resolver: each layer's `renderPolicy` projects to a `ZoomRepresentation`
// (ZOOM_REPRESENTATIONS) and the console resolves the live band from
// (declaration, zoom, provinceInScope). These tests pin the SAME contract the
// old predicate guaranteed — the console only REQUESTS dots at street zoom
// inside a jurisdiction (never nationally, which would be a dot-dump request) —
// now expressed through the near band. The SERVER still re-derives points mode
// independently (get-layer-features).

import { describe, expect, it } from "vitest";

import {
  ZOOM_REPRESENTATIONS,
  Z_POINTS,
  markForZoom,
} from "@/src/modules/panorama/domain/capabilities";

const perdidas = ZOOM_REPRESENTATIONS.perdidas;
const refugios = ZOOM_REPRESENTATIONS.refugios;

describe("Z_POINTS", () => {
  it("is deeper than the divisions threshold (street scale)", () => {
    // Z_DIVISIONS is 6.5; real dots must only appear well past it.
    expect(Z_POINTS).toBeGreaterThan(6.5);
    expect(Z_POINTS).toBe(10);
  });

  it("is the declared nearAtZoom of every representation", () => {
    for (const rep of Object.values(ZOOM_REPRESENTATIONS)) {
      expect(rep.nearAtZoom).toBe(Z_POINTS);
    }
  });
});

describe("markForZoom — near band (the former pointsEligible contract)", () => {
  it("never resolves NEAR at national scope regardless of zoom (no dot-dump request)", () => {
    expect(markForZoom(perdidas, 20, false).band).not.toBe("near");
    expect(markForZoom(perdidas, Z_POINTS, false).band).not.toBe("near");
  });

  it("stays DRILLED when a province is in scope but the camera is above the threshold", () => {
    expect(markForZoom(perdidas, Z_POINTS - 0.01, true).band).toBe("drilled");
  });

  it("resolves NEAR only when BOTH a province is in scope AND zoom ≥ Z_POINTS", () => {
    expect(markForZoom(perdidas, Z_POINTS, true).band).toBe("near");
    expect(markForZoom(perdidas, 12, true).band).toBe("near");
  });

  it("a points-capable layer's NEAR mark is the real-dots mark", () => {
    expect(perdidas.pointsCapable).toBe(true);
    expect(markForZoom(perdidas, 12, true).mark).toBe("clustered-points");
  });

  it("a reference layer's NEAR band falls back to its drilled mark (no points fetch)", () => {
    expect(refugios.pointsCapable).toBe(false);
    const near = markForZoom(refugios, 12, true);
    expect(near.band).toBe("near");
    expect(near.mark).toBe(refugios.drilled);
  });
});

describe("markForZoom — national band (the P4b ghost fix)", () => {
  it("resolves NATIONAL below the declared autoLevel.belowZoom even with a province in scope", () => {
    // Scope-wins keeps level="locality" at any zoom; the DECLARATION now wins
    // at national zoom so the province rollup paints instead of stale locality
    // marks over the national frame.
    expect(perdidas.nationalBelowZoom).toBe(5);
    const out = markForZoom(perdidas, 4, true);
    expect(out.band).toBe("national");
    expect(out.mark).toBe(perdidas.national);
  });

  it("reference layers never force the national mark (pins render at any zoom)", () => {
    expect(refugios.nationalBelowZoom).toBeNull();
    expect(markForZoom(refugios, 3, false).band).toBe("drilled");
    expect(markForZoom(refugios, 3, true).band).toBe("drilled");
  });

  it("between the bands the drilled mark applies", () => {
    expect(markForZoom(perdidas, 7, true).band).toBe("drilled");
    expect(markForZoom(perdidas, 7, false).band).toBe("drilled");
  });
});

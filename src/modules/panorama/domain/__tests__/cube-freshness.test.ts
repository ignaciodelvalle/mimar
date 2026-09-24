// Panorama freshness/liveness caption — pure domain formatter (Cursor I2,
// reshaped by the cube-ON decision K4/S3 2026-07-24). The cube refreshes once
// daily, so an operator must always see WHICH world the view comes from: a
// declared-age precomputed snapshot, or a live computation (with its capped
// layers named — a truncated live view must never read as complete).

import { describe, expect, it } from "vitest";

import { panoramaFreshnessCaption } from "../cube-freshness";

describe("panoramaFreshnessCaption", () => {
  it("formats a cube built-at instant as the AR-pinned es-AR precomputed line", () => {
    // 07:30 UTC → 04:30 in America/Argentina/Buenos_Aires (UTC-3).
    const builtAt = new Date("2026-07-17T07:30:00Z");
    expect(panoramaFreshnessCaption(builtAt)).toBe("Datos precalculados al 17/07/2026 04:30");
  });

  it("pins the AR calendar day for an instant near AR midnight (never the UTC day)", () => {
    // 01:15 UTC on the 18th is still 22:15 on the 17th in Argentina (UTC-3).
    const builtAt = new Date("2026-07-18T01:15:00Z");
    expect(panoramaFreshnessCaption(builtAt)).toBe("Datos precalculados al 17/07/2026 22:15");
  });

  it("accepts an ISO string as well as a Date", () => {
    expect(panoramaFreshnessCaption("2026-07-17T07:30:00Z")).toBe(
      "Datos precalculados al 17/07/2026 04:30",
    );
  });

  // Live branch: no build to declare → the caption says live instead of
  // fabricating a freshness the cube can't back.
  it("says 'Datos en vivo' when builtAt is null (live-served / never refreshed)", () => {
    expect(panoramaFreshnessCaption(null)).toBe("Datos en vivo");
  });

  it("says 'Datos en vivo' when builtAt is undefined", () => {
    expect(panoramaFreshnessCaption(undefined)).toBe("Datos en vivo");
  });

  it("treats an invalid date as live rather than emitting an 'Invalid Date' stamp", () => {
    expect(panoramaFreshnessCaption(new Date("not-a-date"))).toBe("Datos en vivo");
    expect(panoramaFreshnessCaption("nonsense")).toBe("Datos en vivo");
  });

  // K4 — a truncated LIVE view is never presented as complete: the caption
  // names the capped layers (same list the map-table CSV comment discloses).
  it("appends the capped-layer disclosure to the live caption", () => {
    expect(panoramaFreshnessCaption(null, ["Perdidas", "Denuncias"])).toBe(
      "Datos en vivo · capas al tope (2.000): Perdidas, Denuncias",
    );
  });

  // ⚠️ REWRITTEN — RA-7 F7 (2026-07-31). This test used to be:
  //
  //     it("does NOT decorate the precomputed caption with live-cap labels")
  //       expect(caption(builtAt, ["Perdidas"])).toBe("Datos precalculados al …")
  //
  // with the rationale "a cube-served view is not subject to the live per-layer
  // cap; its own residual truncation is disclosed per layer by the LayerPanel
  // badge". It was certifying a data-loss bug as a contract, on two false
  // premises:
  //
  //   1. `builtAt` is not a per-layer fact. The shared board builder
  //      (lib/panorama/build-panorama-board.ts) takes the FIRST seeded layer
  //      actually served from the cube, so ONE cubeable layer stamps the
  //      whole board.
  //   2. `truncatedLayers` is not "the cube layer's residual truncation". It is
  //      PanoramaConsole's `mapTableTruncatedLayers` — every ACTIVE layer whose
  //      own response came back `truncated`, which on a mixed board is a set of
  //      LIVE layers that really did hit the 2.000-row cap.
  //
  // So the assertion said: one cubeable layer may delete the incompleteness
  // disclosure of every other layer on screen. The operator loses a notice
  // because of a layer they are not looking at, and the caption — the line that
  // ends up in the screenshot handed to a funcionario — presents a truncated
  // board as complete. The LayerPanel badge is a different surface, one panel
  // away, and was never a substitute for the board-level line.
  //
  // The two facts are independent. Both are now stated.
  it("states the capped layers ALONGSIDE the precomputed stamp (a cube stamp never swallows the cap notice)", () => {
    expect(panoramaFreshnessCaption(new Date("2026-07-17T07:30:00Z"), ["Perdidas"])).toBe(
      "Datos precalculados al 17/07/2026 04:30 · capas al tope (2.000): Perdidas",
    );
  });

  it("names every capped layer under a cube stamp, not just the first", () => {
    // The whole point of F7: the swallowed notice belonged to layers OTHER than
    // the one that produced the stamp.
    expect(
      panoramaFreshnessCaption("2026-07-17T07:30:00Z", ["Perdidas", "Denuncias", "Mordeduras"]),
    ).toBe(
      "Datos precalculados al 17/07/2026 04:30 · capas al tope (2.000): Perdidas, Denuncias, Mordeduras",
    );
  });

  it("leaves the precomputed caption bare when nothing is capped", () => {
    // The fix must not invent a cap notice — an uncapped cube view reads exactly
    // as it did before.
    expect(panoramaFreshnessCaption(new Date("2026-07-17T07:30:00Z"), [])).toBe(
      "Datos precalculados al 17/07/2026 04:30",
    );
  });

  it("falls back to the LIVE caption + cap notice when the stamp is unparseable", () => {
    // An invalid stamp must not take the cap notice down with it.
    expect(panoramaFreshnessCaption(new Date("not-a-date"), ["Perdidas"])).toBe(
      "Datos en vivo · capas al tope (2.000): Perdidas",
    );
  });
});

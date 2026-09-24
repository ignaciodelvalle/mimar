import { describe, expect, it } from "vitest";

import { DIVISION_FADE_MS } from "./situational-map-config";

/**
 * B1's choropleth fade was ABANDONED (PO, 2026-07-25) once it was measured to
 * be inert — maplibre snaps data-driven paint. The transition helper and its
 * tests went with it rather than standing as a green suite for an animation
 * that never ran.
 *
 * What remains testable here is the shared fade cadence the CHROME still uses
 * (the division-outline fade in use-choropleth-motion.ts).
 */
describe("DIVISION_FADE_MS", () => {
  it("is a perceptible, sub-second window", () => {
    expect(DIVISION_FADE_MS).toBeGreaterThanOrEqual(150);
    expect(DIVISION_FADE_MS).toBeLessThanOrEqual(600);
  });
});

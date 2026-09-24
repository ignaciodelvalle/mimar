// Unit tests for the time-scrub color/size-scale domain lock (pure, no maplibre).

import { describe, expect, it } from "vitest";

import { resolveScrubDomain } from "../scale-lock";

describe("resolveScrubDomain", () => {
  it("uses the live domain AND refreshes the lock at the live edge (not scrubbing)", () => {
    const r = resolveScrubDomain({ live: 42, scrubbing: false, locked: 7 });
    expect(r.domain).toBe(42);
    expect(r.locked).toBe(42); // lock refreshed to the freshest live value
  });

  it("reuses the locked live-edge domain while scrubbing (ignores the frame's live value)", () => {
    const r = resolveScrubDomain({ live: 999, scrubbing: true, locked: 100 });
    expect(r.domain).toBe(100);
    expect(r.locked).toBe(100);
  });

  it("adopts and keeps the current frame when a scrub begins with no lock", () => {
    const r = resolveScrubDomain({ live: 55, scrubbing: true, locked: null });
    expect(r.domain).toBe(55);
    expect(r.locked).toBe(55);
  });

  it("keeps two as-of frames of one session on the SAME domain", () => {
    // Live edge captures the lock…
    const live = resolveScrubDomain({ live: 100, scrubbing: false, locked: null });
    expect(live.locked).toBe(100);
    // …then two scrub frames with DIFFERENT live maxima both resolve to it.
    const frame1 = resolveScrubDomain({ live: 20, scrubbing: true, locked: live.locked });
    const frame2 = resolveScrubDomain({ live: 300, scrubbing: true, locked: frame1.locked });
    expect(frame1.domain).toBe(100);
    expect(frame2.domain).toBe(100);
    expect(frame1.domain).toBe(frame2.domain);
  });

  it("works for a bounds-shaped domain (choropleth min/max), by reference", () => {
    const lockedBounds = { min: 0, max: 80 };
    const frameA = resolveScrubDomain({
      live: { min: 5, max: 12 },
      scrubbing: true,
      locked: lockedBounds,
    });
    const frameB = resolveScrubDomain({
      live: { min: 40, max: 200 },
      scrubbing: true,
      locked: frameA.locked,
    });
    expect(frameA.domain).toBe(lockedBounds);
    expect(frameB.domain).toBe(lockedBounds); // same object across frames
  });
});

// Purity / determinism test for the lost-credential "lost since" renderer.
//
// Part of the F1 `now`-subclass hardening: relative-time labels must be a pure
// function of (date, now) so they cannot drift with the ambient clock between
// evaluations. `formatLostSince` renders inside a Server Component today (one
// server evaluation, no hydration re-run), but keeping it pure and tested
// guards the whole relative-`now` class against a future SSR-eager refactor.

import { formatLostSince } from "@/components/pet-profile/PublicLostSections";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-07-04T12:00:00Z").getTime();

describe("formatLostSince — pure given a fixed now", () => {
  it("is deterministic: same (date, now) yields the same label across calls", () => {
    const d = new Date("2026-07-04T09:00:00Z");
    expect(formatLostSince(d, NOW)).toBe(formatLostSince(d, NOW));
  });

  it("buckets elapsed time correctly against a frozen now (shared lostTimeLabel vocabulary)", () => {
    expect(formatLostSince(new Date("2026-07-04T11:40:00Z"), NOW)).toBe("hace 20 min");
    expect(formatLostSince(new Date("2026-07-04T09:00:00Z"), NOW)).toBe("hace 3 h");
    expect(formatLostSince(new Date("2026-07-01T12:00:00Z"), NOW)).toBe("hace 3 días");
  });
});

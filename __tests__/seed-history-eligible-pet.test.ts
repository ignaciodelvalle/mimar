// Guards the "no event before its own pet exists" invariant in the multi-year
// history seed (scripts/seed-panorama.ts → seedModelProvinceHistory).
//
// WHY THIS TEST EXISTS
// The history seed dated its pooled events (deaths, bites, lost, shelter
// intakes, zoonosis) from a per-province trend curve while choosing the pet
// with a completely independent random draw. Measured on the seeded database
// on 2026-07-26, 45% of all history events preceded their own pet's
// pet_registered event — including 1623 of 3579 death_recorded: pets dying
// before they existed.
//
// The fix narrows the candidate POOL to pets already registered at the event
// instant (makeRegisteredByPicker) and clamps per-pet coverage events to
// [registeredAt, ...] (dateInYear's notBefore). Both are pure functions
// precisely so this invariant is provable here, instead of only being
// observable by re-seeding 32k pets into a shared database.

import { describe, expect, it } from "vitest";

import { dateInYear, makeRegisteredByPicker } from "@/scripts/seed-history-utils";

const at = (iso: string): Date => new Date(iso);

// Three pets registered a year apart, deliberately supplied OUT of order so the
// picker's internal sort is exercised.
const REGISTERED = new Map<string, number>([
  ["pet-2026", at("2026-03-01T00:00:00Z").getTime()],
  ["pet-2024", at("2024-03-01T00:00:00Z").getTime()],
  ["pet-2025", at("2025-03-01T00:00:00Z").getTime()],
]);
const POOL = ["pet-2026", "pet-2024", "pet-2025"];

describe("makeRegisteredByPicker", () => {
  it("never returns a pet registered after the event instant", () => {
    const pick = makeRegisteredByPicker(POOL, REGISTERED);

    // Sweep the whole history window at a fine granularity with many draws:
    // any leak of a not-yet-registered pet would surface here.
    for (let year = 2024; year <= 2026; year++) {
      for (let month = 0; month < 12; month++) {
        const when = new Date(Date.UTC(year, month, 15));
        for (let d = 0; d < 50; d++) {
          const petId = pick(when, d / 50);
          if (petId === null) continue;
          expect(REGISTERED.get(petId)!).toBeLessThanOrEqual(when.getTime());
        }
      }
    }
  });

  it("returns null when no pet was registered yet, so the caller skips the event", () => {
    const pick = makeRegisteredByPicker(POOL, REGISTERED);
    expect(pick(at("2023-12-31T23:59:59Z"), 0.5)).toBeNull();
    expect(pick(at("2024-02-29T00:00:00Z"), 0.99)).toBeNull();
  });

  it("widens the pool as pets accumulate", () => {
    const pick = makeRegisteredByPicker(POOL, REGISTERED);
    const reachable = (when: Date): Set<string> => {
      const seen = new Set<string>();
      for (let d = 0; d < 100; d++) {
        const id = pick(when, d / 100);
        if (id) seen.add(id);
      }
      return seen;
    };

    expect(reachable(at("2024-06-01T00:00:00Z"))).toEqual(new Set(["pet-2024"]));
    expect(reachable(at("2025-06-01T00:00:00Z"))).toEqual(new Set(["pet-2024", "pet-2025"]));
    expect(reachable(at("2026-06-01T00:00:00Z"))).toEqual(
      new Set(["pet-2024", "pet-2025", "pet-2026"]),
    );
  });

  it("includes a pet at the exact instant it is registered (boundary is inclusive)", () => {
    const pick = makeRegisteredByPicker(POOL, REGISTERED);
    expect(pick(at("2024-03-01T00:00:00Z"), 0)).toBe("pet-2024");
  });

  it("drops candidates with no known registration instant rather than trusting them", () => {
    const pick = makeRegisteredByPicker([...POOL, "pet-unknown"], REGISTERED);
    for (let d = 0; d < 100; d++) {
      expect(pick(at("2026-06-01T00:00:00Z"), d / 100)).not.toBe("pet-unknown");
    }
  });

  it("tolerates a draw of exactly 1 without running off the end of the pool", () => {
    const pick = makeRegisteredByPicker(POOL, REGISTERED);
    expect(pick(at("2026-06-01T00:00:00Z"), 1)).toBeDefined();
    expect(pick(at("2026-06-01T00:00:00Z"), 1)).not.toBeUndefined();
  });
});

describe("dateInYear notBefore", () => {
  it("never returns an instant before the pet's registration in its own year", () => {
    const registeredAt = at("2025-09-14T12:00:00Z");
    // Deterministic sweep across the unit interval — an unbounded draw would
    // land in January 2025 for most of these.
    for (let i = 0; i < 500; i++) {
      const d = dateInYear(2025, () => i / 500, 0, 11, registeredAt);
      expect(d.getTime()).toBeGreaterThanOrEqual(registeredAt.getTime());
    }
  });

  it("leaves later years untouched — the clamp only binds in the registration year", () => {
    const registeredAt = at("2024-09-14T12:00:00Z");
    const withClamp = dateInYear(2025, () => 0, 0, 11, registeredAt);
    const withoutClamp = dateInYear(2025, () => 0);
    expect(withClamp.toISOString()).toBe(withoutClamp.toISOString());
  });

  it("still never emits a future-dated event", () => {
    const registeredAt = new Date(Date.now() - 86_400_000);
    const d = dateInYear(new Date().getUTCFullYear(), () => 0.999999, 0, 11, registeredAt);
    expect(d.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

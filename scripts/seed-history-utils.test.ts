import { describe, expect, it } from "vitest";

import { replayPetStatus } from "../lib/projections/pet-status";
import type { ProjectionEvent } from "../lib/projections/types";
import {
  type HistoryLossEpisode,
  dateInYear,
  makeMulberry32,
  monthIndex,
  monthlyEventCount,
  pickDateInMonth,
  pickRegisteredYear,
  provinceProfile,
  resolveHistoryLossOutcomes,
  seasonalFactor,
  trendFactor,
} from "./seed-history-utils";

// These are PURE helpers for the multi-year panorama history seed. They take an
// injected rng (so the seed can pass its global mulberry32 and keep the run
// deterministic) and must NEVER call Math.random. The tests below pin the date
// bounds and the determinism contract the seed relies on.

describe("dateInYear", () => {
  it("returns a Date within [year-01-01T00:00:00Z, year-12-31T23:59:59.999Z]", () => {
    const rng = makeMulberry32(0x1234);
    for (let i = 0; i < 500; i++) {
      const year = 2024 + (i % 3);
      const d = dateInYear(year, rng);
      const lo = Date.UTC(year, 0, 1, 0, 0, 0, 0);
      const hi = Date.UTC(year, 11, 31, 23, 59, 59, 999);
      expect(d.getTime()).toBeGreaterThanOrEqual(lo);
      expect(d.getTime()).toBeLessThanOrEqual(hi);
      expect(d.getUTCFullYear()).toBe(year);
    }
  });

  it("hits both the low and high edges of the year range across many draws", () => {
    const rng = makeMulberry32(0x9999);
    let sawEarly = false;
    let sawLate = false;
    for (let i = 0; i < 2000; i++) {
      const d = dateInYear(2025, rng);
      if (d.getUTCMonth() <= 0) sawEarly = true; // January
      if (d.getUTCMonth() >= 11) sawLate = true; // December
    }
    expect(sawEarly).toBe(true);
    expect(sawLate).toBe(true);
  });

  it("is deterministic: same seed → identical sequence", () => {
    const a = makeMulberry32(42);
    const b = makeMulberry32(42);
    for (let i = 0; i < 50; i++) {
      expect(dateInYear(2024, a).getTime()).toBe(dateInYear(2024, b).getTime());
    }
  });

  it("respects an optional month window [minMonth, maxMonth]", () => {
    const rng = makeMulberry32(0x5151);
    for (let i = 0; i < 500; i++) {
      const d = dateInYear(2026, rng, 2, 4); // March..May (0-indexed)
      expect(d.getUTCMonth()).toBeGreaterThanOrEqual(2);
      expect(d.getUTCMonth()).toBeLessThanOrEqual(4);
      expect(d.getUTCFullYear()).toBe(2026);
    }
  });
});

describe("provinceProfile", () => {
  it("Córdoba improving, Salta worsening, others uniform", () => {
    expect(provinceProfile("Córdoba").archetype).toBe("improving");
    expect(provinceProfile("Salta").archetype).toBe("worsening");
    expect(provinceProfile("Mendoza").archetype).toBe("uniform");
  });
  it("improving coverage rises, worsening falls", () => {
    const c = provinceProfile("Córdoba").coverageByYear;
    expect(c[2026].vacc).toBeGreaterThan(c[2024].vacc);
    const s = provinceProfile("Salta").coverageByYear;
    expect(s[2026].vacc).toBeLessThan(s[2024].vacc);
  });
  it("uniform province has all three years populated", () => {
    const u = provinceProfile("Mendoza");
    expect(u.coverageByYear[2024].vacc).toBeGreaterThan(0);
    expect(u.coverageByYear[2026].vacc).toBeGreaterThan(0);
    expect(u.zoonosisByYear[2025]).toBeGreaterThanOrEqual(0);
  });
});

function testRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("rate model", () => {
  it("monthIndex counts months since Jan 2024", () => {
    expect(monthIndex(2024, 0)).toBe(0);
    expect(monthIndex(2025, 0)).toBe(12);
    expect(monthIndex(2026, 5)).toBe(29);
  });
  it("seasonalFactor bounded", () => {
    for (let m = 0; m < 12; m++) {
      const f = seasonalFactor(m);
      expect(f).toBeGreaterThan(0.5);
      expect(f).toBeLessThan(1.6);
    }
  });
  it("trendFactor: improving rises, worsening falls, uniform mild", () => {
    expect(trendFactor("improving", 24)).toBeGreaterThan(trendFactor("improving", 0));
    expect(trendFactor("worsening", 24)).toBeLessThan(trendFactor("worsening", 0));
    expect(trendFactor("worsening", 1000)).toBeGreaterThanOrEqual(0.2);
  });
  it("monthlyEventCount deterministic + non-negative + zero base", () => {
    expect(monthlyEventCount(10, "uniform", 2025, 5, testRng(1))).toBe(
      monthlyEventCount(10, "uniform", 2025, 5, testRng(1)),
    );
    expect(monthlyEventCount(0, "uniform", 2025, 5, testRng(1))).toBe(0);
    expect(monthlyEventCount(10, "uniform", 2025, 5, testRng(2))).toBeGreaterThanOrEqual(0);
  });
  it("pickDateInMonth stays within month and never after anchor", () => {
    const d = pickDateInMonth(2025, 2, testRng(3)); // March 2025
    expect(d.getUTCFullYear()).toBe(2025);
    expect(d.getUTCMonth()).toBe(2);
    const future = pickDateInMonth(2026, 11, testRng(4)); // Dec 2026 — after anchor
    expect(future.getTime()).toBeLessThanOrEqual(new Date("2026-06-20T00:00:00Z").getTime());
  });
});

describe("pickRegisteredYear", () => {
  it("only returns years from the provided list", () => {
    const rng = makeMulberry32(7);
    const years = [2024, 2025, 2026] as const;
    for (let i = 0; i < 500; i++) {
      expect(years).toContain(pickRegisteredYear(rng, years));
    }
  });

  it("covers every year in the list across many draws (spread, not stuck)", () => {
    const rng = makeMulberry32(0xabc);
    const years = [2024, 2025, 2026] as const;
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(pickRegisteredYear(rng, years));
    for (const y of years) expect(seen.has(y)).toBe(true);
  });

  it("is deterministic: same seed → identical sequence", () => {
    const a = makeMulberry32(99);
    const b = makeMulberry32(99);
    const years = [2024, 2025, 2026] as const;
    for (let i = 0; i < 50; i++) {
      expect(pickRegisteredYear(a, years)).toBe(pickRegisteredYear(b, years));
    }
  });
});

// The history seed emitted status_changed(to_status='lost') for thousands of
// episodes and never closed one, nor moved pets.status — measured on staging:
// 5741 lost events, zero reunions, 2705 PANO-HIST pets whose latest
// status_changed said 'lost' over a cache that said 'active'. The helper below
// decides per PET what to emit and which pets to cache as 'lost'; these tests
// pin the invariants against the REAL projection (lib/projections/pet-status),
// which is what the nightly reconcile compares the cache to.
describe("resolveHistoryLossOutcomes", () => {
  const DAY = 86_400_000;
  const ANCHOR = new Date("2026-06-20T00:00:00Z");
  const at = (iso: string): Date => new Date(iso);
  const baseOpts = {
    anchor: ANCHOR,
    reunificationRate: 0.45,
    recentWindowDays: 30,
  };
  const resolve = (
    episodes: readonly HistoryLossEpisode[],
    overrides: Partial<{
      deceasedPetIds: ReadonlySet<string>;
      reunificationRate: number;
      rng: () => number;
    }> = {},
  ) =>
    resolveHistoryLossOutcomes(episodes, {
      ...baseOpts,
      deceasedPetIds: overrides.deceasedPetIds ?? new Set<string>(),
      reunificationRate: overrides.reunificationRate ?? baseOpts.reunificationRate,
      rng: overrides.rng ?? makeMulberry32(0x10ad),
    });

  /**
   * Mirror what the seed does with the helper's answer: the losses, the
   * reunifications and (for dead pets) a death_recorded go into the spine; the
   * cache gets 'lost' for stillLostPetIds, 'deceased' via the end-of-seed
   * reconcile for dead pets, 'active' otherwise. Replay per pet with the real
   * projection and compare. Ties on occurredAt keep emission order, which is
   * the order the seed inserts in.
   */
  function disagreements(
    episodes: readonly HistoryLossEpisode[],
    deceasedPetIds: ReadonlySet<string>,
    deathAt: (petId: string) => Date,
    result: ReturnType<typeof resolve>,
  ): string[] {
    const spine = new Map<string, Array<ProjectionEvent & { seq: number }>>();
    let seq = 0;
    const push = (petId: string, eventType: string, occurredAt: Date, payload: unknown) => {
      const list = spine.get(petId) ?? [];
      list.push({ id: `e${seq}`, eventType, occurredAt, recordedAt: occurredAt, payload, seq });
      seq++;
      spine.set(petId, list);
    };
    for (const ep of episodes) {
      push(ep.petId, "status_changed", ep.lostAt, { from_status: "active", to_status: "lost" });
    }
    for (const r of result.reunifications) {
      push(r.episode.petId, "status_changed", r.reunifiedAt, {
        from_status: "lost",
        to_status: "active",
      });
    }
    for (const petId of deceasedPetIds) push(petId, "death_recorded", deathAt(petId), {});

    const stillLost = new Set(result.stillLostPetIds);
    const out: string[] = [];
    for (const [petId, events] of spine) {
      events.sort(
        (a, b) =>
          (a.occurredAt as Date).getTime() - (b.occurredAt as Date).getTime() || a.seq - b.seq,
      );
      const replayed = replayPetStatus(events).status;
      const cached = deceasedPetIds.has(petId)
        ? "deceased"
        : stillLost.has(petId)
          ? "lost"
          : "active";
      if (replayed !== cached) out.push(`${petId}: spine=${replayed} cache=${cached}`);
    }
    return out;
  }

  /** Synthetic episodes shaped like the seed's: random pet, hour-granular date in [2024, anchor]. */
  function synthEpisodes(seed: number, count: number, petCount: number): HistoryLossEpisode[] {
    const rng = makeMulberry32(seed);
    const start = Date.UTC(2024, 0, 1);
    const span = ANCHOR.getTime() - start;
    const episodes: HistoryLossEpisode[] = [];
    for (let i = 0; i < count; i++) {
      const petId = `pet-${Math.floor(rng() * petCount)}`;
      // Hour granularity like pickDateInMonth; a slice lands exactly on the
      // anchor so the "no room before now" branch is exercised.
      const hourMs = Math.floor((rng() * span) / 3_600_000) * 3_600_000;
      const lostAt = rng() < 0.01 ? ANCHOR : new Date(start + hourMs);
      episodes.push({ petId, lostAt });
    }
    return episodes;
  }

  it("closes every earlier episode of a multi-episode pet, strictly before the next loss", () => {
    const episodes: HistoryLossEpisode[] = [
      { petId: "p", lostAt: at("2026-06-10T00:00:00Z") }, // latest, recent
      { petId: "p", lostAt: at("2024-03-05T00:00:00Z") },
      { petId: "p", lostAt: at("2025-08-20T00:00:00Z") },
    ];
    // rng always 0.99 → the recent latest episode is NOT reunified → stays open.
    const result = resolve(episodes, { rng: () => 0.99 });
    expect(result.stillLostPetIds).toEqual(["p"]);
    const closed = result.reunifications.map((r) => r.episode.lostAt.toISOString()).sort();
    expect(closed).toEqual(["2024-03-05T00:00:00.000Z", "2025-08-20T00:00:00.000Z"]);
    for (const r of result.reunifications) {
      expect(r.reunifiedAt.getTime()).toBeGreaterThan(r.episode.lostAt.getTime());
    }
    const first = result.reunifications.find((r) => r.episode.lostAt.getUTCFullYear() === 2024)!;
    expect(first.reunifiedAt.getTime()).toBeLessThan(at("2025-08-20T00:00:00Z").getTime());
  });

  it("clamps a reunification strictly before the next loss when the losses are days apart", () => {
    const episodes: HistoryLossEpisode[] = [
      { petId: "p", lostAt: at("2025-01-01T00:00:00Z") },
      { petId: "p", lostAt: at("2025-01-02T00:00:00Z") },
    ];
    // rng 0.99 → interval draw is 9 days, far past the next loss → clamped.
    const result = resolve(episodes, { rng: () => 0.99 });
    const first = result.reunifications.find((r) => r.episode.lostAt.getUTCDate() === 1)!;
    expect(first.reunifiedAt.getTime()).toBeGreaterThan(at("2025-01-01T00:00:00Z").getTime());
    expect(first.reunifiedAt.getTime()).toBeLessThan(at("2025-01-02T00:00:00Z").getTime());
  });

  it("closes a latest episode older than the recent window unconditionally", () => {
    const episodes: HistoryLossEpisode[] = [
      { petId: "old", lostAt: new Date(ANCHOR.getTime() - 31 * DAY) },
    ];
    // rng 0.99 would leave a RECENT episode open; an old one must still close.
    const result = resolve(episodes, { rng: () => 0.99 });
    expect(result.stillLostPetIds).toEqual([]);
    expect(result.reunifications).toHaveLength(1);
    expect(result.reunifications[0].reunifiedAt.getTime()).toBeLessThanOrEqual(ANCHOR.getTime());
  });

  it("leaves a recent latest episode open at the seed's reunification rate", () => {
    const episodes: HistoryLossEpisode[] = [];
    for (let i = 0; i < 4000; i++) {
      episodes.push({ petId: `r-${i}`, lostAt: new Date(ANCHOR.getTime() - (1 + (i % 29)) * DAY) });
    }
    const result = resolve(episodes, { rng: makeMulberry32(7) });
    const openShare = result.stillLostPetIds.length / episodes.length;
    expect(openShare).toBeGreaterThan(0.5);
    expect(openShare).toBeLessThan(0.6); // ≈ 1 - 0.45
  });

  it("never lands a reunification after the next loss or after the anchor", () => {
    const episodes = synthEpisodes(0xbeef, 3000, 400);
    const result = resolve(episodes, { rng: makeMulberry32(0xcafe) });
    const byPet = new Map<string, number[]>();
    for (const ep of episodes) {
      byPet.set(ep.petId, [...(byPet.get(ep.petId) ?? []), ep.lostAt.getTime()]);
    }
    for (const r of result.reunifications) {
      const t = r.reunifiedAt.getTime();
      const lostMs = r.episode.lostAt.getTime();
      expect(t).toBeGreaterThan(lostMs);
      expect(t).toBeLessThanOrEqual(ANCHOR.getTime());
      const next = byPet.get(r.episode.petId)!.filter((x) => x > lostMs);
      if (next.length > 0) expect(t).toBeLessThan(Math.min(...next));
    }
  });

  it("never marks a pet lost when it also dies in the seed", () => {
    const episodes = synthEpisodes(0xd00d, 2000, 300);
    const deceased = new Set(episodes.filter((_, i) => i % 5 === 0).map((e) => e.petId));
    const result = resolve(episodes, { deceasedPetIds: deceased, rng: makeMulberry32(3) });
    for (const petId of result.stillLostPetIds) expect(deceased.has(petId)).toBe(false);
    // And the exclusion is not vacuous: without it, some of those pets WOULD be marked.
    const without = resolve(episodes, { rng: makeMulberry32(3) });
    expect(without.stillLostPetIds.some((p) => deceased.has(p))).toBe(true);
  });

  it("leaves a loss dated at the anchor open — there is no room for a reunion before now", () => {
    const result = resolve([{ petId: "now", lostAt: ANCHOR }], { rng: () => 0 });
    expect(result.reunifications).toEqual([]);
    expect(result.stillLostPetIds).toEqual(["now"]);
  });

  it("property: replaying the emitted events yields the cached status for every pet", () => {
    for (const seed of [1, 2, 3]) {
      const episodes = synthEpisodes(seed, 5000, 900);
      const deceased = new Set(episodes.filter((_, i) => i % 7 === 0).map((e) => e.petId));
      const deathRng = makeMulberry32(seed + 100);
      const deathAt = () =>
        new Date(Date.UTC(2024, 0, 1) + deathRng() * (ANCHOR.getTime() - Date.UTC(2024, 0, 1)));
      const result = resolve(episodes, { deceasedPetIds: deceased, rng: makeMulberry32(seed) });
      expect(disagreements(episodes, deceased, deathAt, result)).toEqual([]);
      // Sanity: the fix is not "everything active" — a recent tail stays lost.
      expect(result.stillLostPetIds.length).toBeGreaterThan(0);
      expect(result.reunifications.length).toBeGreaterThan(episodes.length * 0.9);
    }
  });

  it("is deterministic: same seed → identical answer", () => {
    const episodes = synthEpisodes(42, 1000, 200);
    const a = resolve(episodes, { rng: makeMulberry32(9) });
    const b = resolve(episodes, { rng: makeMulberry32(9) });
    expect(a).toEqual(b);
  });
});

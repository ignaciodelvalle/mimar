/**
 * Pure date / trend helpers for the multi-year panorama history seed
 * (seedModelProvinceHistory in seed-panorama.ts).
 *
 * These are intentionally isolated from seed-panorama.ts so they are importable
 * by a unit test WITHOUT pulling in the seed's deferred db imports / local-only
 * guard. Every helper takes an injected `rng: () => number` (a mulberry32 draw
 * in [0,1)) so the seed can pass its single global PRNG and keep the whole run
 * deterministic. NEVER use Math.random here.
 */

/**
 * mulberry32 PRNG factory — THE definition. seed-panorama.ts imports it for its
 * global `rng` and the unit test constructs isolated seeded streams from it;
 * there used to be a byte-identical private copy in the seed, which is one
 * edit away from two generators that disagree.
 */
export function makeMulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    t = (t ^ (t >>> 14)) >>> 0;
    return t / 0x100000000;
  };
}

/**
 * Return a Date uniformly within a given calendar year (UTC), optionally bounded
 * to a [minMonth, maxMonth] window (0-indexed months, inclusive).
 *
 * The history seed needs ABSOLUTE dates spread across 2024–2026 — the seed's
 * `randomWindowDate` is anchored to a single 2026 date and is unsuitable. The
 * panorama scrubber filters with `lte(pet_events.occurred_at, asOf)`, so dating
 * a coverage event inside year Y means it only counts once `asOf` reaches Y,
 * which is exactly how the year-over-year trend climbs (CABA) or stagnates
 * (Salta).
 *
 * Bounds: result is always within [Y-01-01T00:00:00.000Z, Y-12-31T23:59:59.999Z]
 * (or the month-bounded sub-range). Uses one rng draw.
 *
 * `notBefore` raises the lower bound. A per-pet event drawn for the pet's OWN
 * registration year would otherwise land uniformly across that whole year and
 * so, roughly half the time, precede the registration that created the record —
 * a vaccination applied to a pet that does not exist yet. Passing the pet's
 * registeredAt confines the draw to the part of the year the pet was actually
 * alive in the registry. Years after the registration year are unaffected
 * (notBefore is already below the window).
 */
export function dateInYear(
  year: number,
  rng: () => number,
  minMonth = 0,
  maxMonth = 11,
  notBefore?: Date,
): Date {
  const windowStart = Date.UTC(year, minMonth, 1, 0, 0, 0, 0);
  const lo = notBefore === undefined ? windowStart : Math.max(windowStart, notBefore.getTime());
  // Day 0 of (maxMonth + 1) is the LAST day of maxMonth; +1 day minus 1ms gives
  // the inclusive end-of-month instant without overflowing into the next month.
  const hiExclusive = Date.UTC(year, maxMonth + 1, 1, 0, 0, 0, 0);
  let hi = hiExclusive - 1; // last representable ms inside the window
  // Never emit a FUTURE-dated event. For the current (partial) calendar year the
  // window would otherwise run to Dec 31, seeding events that "haven't happened
  // yet" and breaking the admin "en vivo" metrics. Clamp the upper bound to now
  // so the current year only spans up to today; past years are unaffected.
  const nowMs = Date.now();
  if (hi > nowMs) hi = nowMs;
  const span = Math.max(0, hi - lo);
  return new Date(lo + Math.floor(rng() * (span + 1)));
}

/**
 * Build a picker that returns a pet id drawn ONLY from the pets already
 * registered at a given instant — the guard against seeding an event that
 * happens before its own pet exists.
 *
 * The history seed dates its pooled events (deaths, bites, lost, shelter
 * intakes, zoonosis) from a per-province trend/seasonality curve, and used to
 * choose the pet with a completely independent draw. 45% of history events
 * landed before their pet's pet_registered as a result — 1623 of 3579
 * death_recorded events were pets dying before they existed.
 *
 * Narrowing the POOL rather than re-drawing the DATE is deliberate: the date
 * carries the trend the panorama history charts exist to show, so it must be
 * preserved exactly. Only the candidate set moves.
 *
 * @param petIds     candidate pets (any order; ids without a known registration
 *                   instant are dropped rather than silently trusted)
 * @param registeredAtMs  pet id → registration instant in epoch ms
 * @returns (at, draw) => pet id, or null when NO pet was registered yet at
 *          `at` — the caller must skip emitting the event. `draw` is a
 *          pre-drawn uniform in [0,1), taken in the caller's original rng
 *          position so the deterministic stream is unchanged.
 */
export function makeRegisteredByPicker(
  petIds: readonly string[],
  registeredAtMs: ReadonlyMap<string, number>,
): (at: Date, draw: number) => string | null {
  const sorted = petIds
    .filter((id) => registeredAtMs.has(id))
    .sort((a, b) => registeredAtMs.get(a)! - registeredAtMs.get(b)!);
  const times = sorted.map((id) => registeredAtMs.get(id)!);

  return (at, draw) => {
    // Upper bound: how many pets were registered at or before `at`.
    const t = at.getTime();
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return null;
    // Clamp guards draw === 1 (some rngs are inclusive at the top).
    return sorted[Math.min(lo - 1, Math.floor(draw * lo))];
  };
}

/**
 * Pick a registration year from a list, spread (roughly uniform) across the
 * provided years so every year is represented. Uses one rng draw. Determinism
 * is inherited from the injected rng.
 */
export function pickRegisteredYear<T extends number>(rng: () => number, years: readonly T[]): T {
  return years[Math.floor(rng() * years.length)];
}

// ---------------------------------------------------------------------------
// Province trend profiles
// ---------------------------------------------------------------------------

export type TrendArchetype = "improving" | "worsening" | "uniform";
export type HistoryYear = 2024 | 2025 | 2026;

type ProvinceProfile = {
  archetype: TrendArchetype;
  coverageByYear: Record<HistoryYear, { vacc: number; ster: number }>;
  zoonosisByYear: Record<HistoryYear, number>;
};

/** Córdoba: vaccination + sterilisation coverage rises, zoonosis declines. */
const CORDOBA_COVERAGE: Record<HistoryYear, { vacc: number; ster: number }> = {
  2024: { vacc: 0.3, ster: 0.25 },
  2025: { vacc: 0.43, ster: 0.35 },
  2026: { vacc: 0.55, ster: 0.44 },
};
const CORDOBA_ZOONOSIS: Record<HistoryYear, number> = { 2024: 0.6, 2025: 0.3, 2026: 0.1 };

/** Salta: coverage low and declining, zoonosis rises. */
const SALTA_COVERAGE: Record<HistoryYear, { vacc: number; ster: number }> = {
  2024: { vacc: 0.28, ster: 0.2 },
  2025: { vacc: 0.21, ster: 0.16 },
  2026: { vacc: 0.16, ster: 0.12 },
};
const SALTA_ZOONOSIS: Record<HistoryYear, number> = { 2024: 0.5, 2025: 1.1, 2026: 1.8 };

/** All other provinces: mild upward vacc/ster trend, flat-ish zoonosis. */
const UNIFORM_COVERAGE: Record<HistoryYear, { vacc: number; ster: number }> = {
  2024: { vacc: 0.32, ster: 0.26 },
  2025: { vacc: 0.4, ster: 0.32 },
  2026: { vacc: 0.48, ster: 0.38 },
};
const UNIFORM_ZOONOSIS: Record<HistoryYear, number> = { 2024: 0.4, 2025: 0.4, 2026: 0.45 };

// ---------------------------------------------------------------------------
// Monthly-rate model helpers
// ---------------------------------------------------------------------------

/**
 * Months elapsed since January 2024 (month is 0-indexed, so 0 = January).
 * Example: monthIndex(2026, 5) === 29 (June 2026).
 */
export function monthIndex(year: number, month: number): number {
  return (year - 2024) * 12 + month;
}

/**
 * Seasonal multiplier for a given 0-indexed month.
 * Peaks in January (month 0) at ~1.25, troughs in July (month 6) at ~0.75.
 * Bounded to approximately [0.75, 1.25].
 */
export function seasonalFactor(month: number): number {
  return 1 + 0.25 * Math.cos((2 * Math.PI * month) / 12);
}

/**
 * Trend multiplier based on archetype and how many months have elapsed.
 * - "uniform"   → mild upward drift: 1 + 0.01 * monthIndex
 * - "improving" → stronger upward drift: 1 + 0.025 * monthIndex
 * - "worsening" → downward drift, floored at 0.2: max(0.2, 1 − 0.02 * monthIndex)
 */
export function trendFactor(archetype: TrendArchetype, mi: number): number {
  switch (archetype) {
    case "uniform":
      return 1 + 0.01 * mi;
    case "improving":
      return 1 + 0.025 * mi;
    case "worsening":
      return Math.max(0.2, 1 - 0.02 * mi);
  }
}

/**
 * Realise the expected monthly count as a non-negative integer.
 * Expected = baseRate × trendFactor × seasonalFactor.
 * Uses one `rng()` draw for the fractional part (stochastic rounding).
 * When baseRate === 0 the result is always 0 (no rng draw).
 */
export function monthlyEventCount(
  baseRate: number,
  archetype: TrendArchetype,
  year: number,
  month: number,
  rng: () => number,
): number {
  if (baseRate === 0) return 0;
  const expected =
    baseRate * trendFactor(archetype, monthIndex(year, month)) * seasonalFactor(month);
  return Math.floor(expected) + (rng() < expected - Math.floor(expected) ? 1 : 0);
}

/** Default anchor: the latest date we consider "now" for the seed window. */
const DEFAULT_ANCHOR = new Date("2026-06-20T00:00:00Z");

/**
 * Pick a uniformly random day + hour within the given UTC month.
 * Uses two rng draws (one for day, one for hour).
 * If the resulting date is after `anchor` (default 2026-06-20T00:00:00Z),
 * the result is clamped to the anchor.
 */
export function pickDateInMonth(
  year: number,
  month: number,
  rng: () => number,
  anchor: Date = DEFAULT_ANCHOR,
): Date {
  const monthStart = Date.UTC(year, month, 1);
  const monthEndExclusive = Date.UTC(year, month + 1, 1);
  const daysInMonth = (monthEndExclusive - monthStart) / 86_400_000;

  const day = Math.floor(rng() * daysInMonth); // 0-indexed day within month
  const hour = Math.floor(rng() * 24);

  const ts = Date.UTC(year, month, 1 + day, hour, 0, 0, 0);
  const result = new Date(Math.min(ts, anchor.getTime()));
  return result;
}

/**
 * Return the trend archetype and per-year coverage/zoonosis numbers for any
 * Argentine province name. Pure and deterministic — no rng or Date.now() calls.
 *
 * - `"Córdoba"` → improving (coverage rises, zoonosis declines)
 * - `"Salta"`   → worsening (coverage falls, zoonosis rises)
 * - any other   → uniform (mild upward vacc/ster, flat-ish zoonosis)
 */
export function provinceProfile(provinceName: string): ProvinceProfile {
  if (provinceName === "Córdoba") {
    return {
      archetype: "improving",
      coverageByYear: CORDOBA_COVERAGE,
      zoonosisByYear: CORDOBA_ZOONOSIS,
    };
  }
  if (provinceName === "Salta") {
    return {
      archetype: "worsening",
      coverageByYear: SALTA_COVERAGE,
      zoonosisByYear: SALTA_ZOONOSIS,
    };
  }
  return {
    archetype: "uniform",
    coverageByYear: UNIFORM_COVERAGE,
    zoonosisByYear: UNIFORM_ZOONOSIS,
  };
}

// ---------------------------------------------------------------------------
// Lost-episode outcomes — the spine and the status cache agree by construction
// ---------------------------------------------------------------------------

/** One status_changed(active→lost) the history seed emitted. */
export type HistoryLossEpisode = {
  petId: string;
  lostAt: Date;
};

/** A status_changed(lost→active) the caller must emit to close an episode. */
export type HistoryReunification<E extends HistoryLossEpisode = HistoryLossEpisode> = {
  /** The episode being closed — the caller's own object, so it keeps its extras. */
  episode: E;
  reunifiedAt: Date;
};

export type HistoryLossResolution<E extends HistoryLossEpisode = HistoryLossEpisode> = {
  /** Reunifications to emit, in a stable, deterministic order. */
  reunifications: HistoryReunification<E>[];
  /**
   * Pets whose LATEST episode stays open — the only pets the caller may write
   * `pets.status = 'lost'` for. Never contains a pet from `deceasedPetIds`.
   */
  stillLostPetIds: string[];
};

export type ResolveHistoryLossOptions = {
  /** "Now" for the seed: no reunification lands after this instant. */
  anchor: Date;
  /**
   * Pets that also receive a death_recorded in this seed. death_recorded is
   * terminal in lib/projections/pet-status.ts, so writing 'lost' into their
   * cache would be drift in the other direction — they are never marked lost.
   */
  deceasedPetIds: ReadonlySet<string>;
  /** Share of RECENT open episodes that get reunified — the seed's own rate. */
  reunificationRate: number;
  /** How far back from `anchor` an episode still counts as "recent" (days). */
  recentWindowDays: number;
  rng: () => number;
};

const DAY_MS = 86_400_000;

/**
 * Decide, per PET, which history lost-episodes get a reunification and which
 * pets are genuinely still lost at the anchor — so that replaying the emitted
 * status_changed events yields exactly the status the caller writes into
 * `pets.status`.
 *
 * WHY THIS EXISTS. The history seed emitted status_changed(to_status='lost')
 * for thousands of episodes across 2024–2026 and never closed one of them, nor
 * touched the cache. Measured on staging: 5741 lost events, zero reunions, and
 * 2705 PANO-HIST pets whose latest status_changed said 'lost' while
 * pets.status said 'active'. The nightly reconcile cron reported the drift
 * every night, and /perdidas (which filters on the cache) showed ~70 lost pets
 * while the spine said 2775 — on a panel shown to government officials.
 *
 * The decision is per pet, not per episode, because the pooled picker draws
 * randomly and one pet can be lost several times across the years while the
 * projection only looks at the LATEST status_changed:
 *
 *   - Every non-latest episode of a pet is closed with a reunification placed
 *     strictly between its loss and the pet's NEXT loss (never after it, or
 *     the later loss would be shadowed). Two losses at the same instant leave
 *     no room; the earlier one is simply superseded and gets no reunion.
 *   - The latest episode is closed unconditionally when it is older than the
 *     recent window: a 2024 loss that leaves the animal missing today is not
 *     realistic at this volume, and the trend charts only need the loss to
 *     have happened.
 *   - A latest episode INSIDE the recent window is reunified with
 *     `reunificationRate` — the same knob the per-province block applies to
 *     its own recent (30-day) losses (REUNIFICATION_RATE, default 0.45) — and
 *     otherwise stays open: that pet goes into `stillLostPetIds`, unless it
 *     also dies in this seed.
 *   - A loss AT the anchor has no room for a reunion before "now" and stays
 *     open by construction.
 *
 * The reunion interval mirrors the per-province block (1–9 days after the
 * loss), clamped to stay strictly before the next loss / the anchor. Uses the
 * injected rng only; the order of draws is stable (pets in first-appearance
 * order, episodes by lostAt) so the seed stays deterministic.
 */
export function resolveHistoryLossOutcomes<E extends HistoryLossEpisode>(
  episodes: readonly E[],
  opts: ResolveHistoryLossOptions,
): HistoryLossResolution<E> {
  const { anchor, deceasedPetIds, reunificationRate, recentWindowDays, rng } = opts;
  const anchorMs = anchor.getTime();
  const recentSinceMs = anchorMs - recentWindowDays * DAY_MS;

  const reunifications: HistoryReunification<E>[] = [];
  const stillLostPetIds: string[] = [];

  for (const [petId, sorted] of groupEpisodesByPet(episodes)) {
    for (let i = 0; i < sorted.length; i++) {
      const ep = sorted[i];
      const lostMs = ep.lostAt.getTime();
      const isLatest = i === sorted.length - 1;
      // A reunion must land strictly before this bound: the next loss for an
      // earlier episode, "now" for the latest one.
      const boundMs = isLatest ? anchorMs : sorted[i + 1].lostAt.getTime();
      // No room before the bound: a loss AT the anchor stays open by
      // construction; two same-instant losses leave the earlier one superseded
      // by the later one in the projection, so it needs no reunion.
      const hasRoom = boundMs - lostMs >= 2;
      // An earlier episode always closes. The latest one closes unconditionally
      // when older than the recent window, and at the seed's own reunification
      // rate inside it (one rng draw, only when the draw can matter).
      const closes = hasRoom && (!isLatest || lostMs < recentSinceMs || rng() < reunificationRate);

      if (closes) {
        reunifications.push({ episode: ep, reunifiedAt: placeReunion(lostMs, boundMs, rng) });
      } else if (isLatest && !deceasedPetIds.has(petId)) {
        stillLostPetIds.push(petId);
      }
    }
  }

  return { reunifications, stillLostPetIds };
}

/**
 * Group episodes by pet — pets in first-appearance order, episodes by lostAt —
 * so the rng draws in resolveHistoryLossOutcomes happen in a stable order.
 */
function groupEpisodesByPet<E extends HistoryLossEpisode>(
  episodes: readonly E[],
): Map<string, E[]> {
  const byPet = new Map<string, E[]>();
  for (const ep of episodes) {
    const list = byPet.get(ep.petId);
    if (list) list.push(ep);
    else byPet.set(ep.petId, [ep]);
  }
  for (const list of byPet.values()) {
    list.sort((a, b) => a.lostAt.getTime() - b.lostAt.getTime());
  }
  return byPet;
}

/**
 * The reunion instant for a closed episode: 1–9 days after the loss (the
 * per-province block's own interval), or halfway to `boundMs` when that
 * interval would reach it. Always strictly inside (lostMs, boundMs); the caller
 * guarantees `boundMs - lostMs >= 2`. Uses one rng draw.
 */
function placeReunion(lostMs: number, boundMs: number, rng: () => number): Date {
  const intervalDays = 1 + Math.floor(rng() * 9); // mirrors randInt(1, 9)
  const candidateMs = lostMs + intervalDays * DAY_MS;
  return new Date(
    candidateMs < boundMs ? candidateMs : lostMs + Math.floor((boundMs - lostMs) / 2),
  );
}

// lib/metrics/vet-access.test.ts — integration tests for fetchVetAccessByLocality.
//
// Seeds synthetic pets + veterinary-act events across localities with different
// access densities (and one below the k=5 threshold) to assert the per-1k
// computation, ascending "care-desert-first" ordering, and k-anon suppression.
// Plus one locality PER MEMBER of VET_ACTIVITY_EVENT_TYPES, each a copy of
// LOC_LOW with only the event type changed, so the numerator's width is pinned
// act by act. Plus a DB-free pure-helper test for perThousand.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { withMutationOverride } from "../../__tests__/_helpers/db-overrides";
import { KPI_CATALOG } from "./kpi-catalog";
import {
  VET_ACCESS_DESERT_MIN_PERIOD_DAYS,
  VET_ACCESS_MIN_ACTIVE_PETS,
  VET_ACTIVITY_EVENT_TYPES,
  classifyVetAccess,
  fetchVetAccessByLocality,
  perThousand,
  vetAccessDesertThresholdPer1k,
} from "./vet-access";

const TEST_PROVINCE = "Córdoba";
const LOC_HIGH = "HighAccessVille";
const LOC_LOW = "LowAccessVille";
const LOC_TINY = "TinyHiddenVille";
// Predicate-width fixtures. Each is LOC_LOW with EXACTLY ONE axis changed —
// the event type — so a passing assertion can only be explained by that axis:
// same 5 active pets, same single event, same date, same author role.
const LOC_VAX = "VaxOnlyVille"; // vaccination_administered instead of a visit
const LOC_STERIL = "SterilOnlyVille"; // sterilization_performed
const LOC_CHIP = "ChipOnlyVille"; // microchip_implanted
const LOC_CLINICAL = "ClinicalOnlyVille"; // clinical_info_logged
const LOC_DEWORM = "DewormOnlyVille"; // deworming_administered — must NOT count
const TOKEN_PREFIX = "VET-ACC-TST";

const DAY_MS = 24 * 60 * 60 * 1000;
let seq = 0;

async function cleanup() {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`
      DELETE FROM pet_events
      WHERE pet_id IN (SELECT id FROM pets WHERE public_token LIKE ${`${TOKEN_PREFIX}-%`})
    `);
    await tx.execute(sql`
      DELETE FROM pets WHERE public_token LIKE ${`${TOKEN_PREFIX}-%`}
    `);
  });
}

async function seedPetsIn(locality: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    seq += 1;
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: `${TOKEN_PREFIX}-${seq}`,
        name: `VetPet-${seq}`,
        species: "dog",
        status: "active",
        jurisdictionProvince: TEST_PROVINCE,
        jurisdictionLocality: locality,
      })
      .returning({ id: pets.id });
    ids.push(pet.id);
  }
  return ids;
}

/** Minimal valid payloads per veterinary event type (schema-checked writers). */
const PAYLOADS: Record<string, Record<string, unknown>> = {
  vet_visit_logged: { payload_version: 1, reason: "control" },
  vaccination_administered: {
    payload_version: 1,
    vaccine_name: "Antirrábica",
    brand: null,
    batch: null,
    next_due_at: null,
  },
  sterilization_performed: { payload_version: 1, method: "surgical", performed_by: null },
  microchip_implanted: { payload_version: 1, code: "900000000000001", implanted_by: null },
  clinical_info_logged: { payload_version: 1, kind: "lab", summary: "hemograma" },
  deworming_administered: {
    payload_version: 1,
    product: "Antiparasitario",
    type: "internal",
    next_due_at: null,
  },
};

async function seedActs(petId: string, n: number, eventType = "vet_visit_logged") {
  for (let i = 0; i < n; i++) {
    await db.insert(petEvents).values({
      petId,
      eventType: eventType as never,
      occurredAt: new Date(Date.now() - 10 * DAY_MS),
      payload: PAYLOADS[eventType],
      authorRole: "owner",
      recordedByUserId: null,
    });
  }
}

const seedVisits = seedActs;

/** LOC_LOW's exact shape (5 active pets, ONE event) with a different act type. */
async function seedOneActVille(locality: string, eventType: string) {
  const ids = await seedPetsIn(locality, 5);
  await seedActs(ids[0], 1, eventType);
}

beforeAll(async () => {
  await cleanup();
  // High access: 5 active pets, 10 visits → 2000 / 1.000.
  const high = await seedPetsIn(LOC_HIGH, 5);
  await seedVisits(high[0], 10);
  // Low access: 5 active pets, 1 visit → 200 / 1.000 (a care desert).
  const low = await seedPetsIn(LOC_LOW, 5);
  await seedVisits(low[0], 1);
  // Tiny: 3 active pets (below k=5) → suppressed even though it has visits.
  const tiny = await seedPetsIn(LOC_TINY, 3);
  await seedVisits(tiny[0], 2);
  // One-axis variants of LOC_LOW — only the event type differs.
  await seedOneActVille(LOC_VAX, "vaccination_administered");
  await seedOneActVille(LOC_STERIL, "sterilization_performed");
  await seedOneActVille(LOC_CHIP, "microchip_implanted");
  await seedOneActVille(LOC_CLINICAL, "clinical_info_logged");
  await seedOneActVille(LOC_DEWORM, "deworming_administered");
}, 60_000);

afterAll(cleanup);

describe("perThousand", () => {
  it("returns 0 when there is no active population", () => {
    expect(perThousand(5, 0)).toBe(0);
  });

  it("computes visits per 1.000 active pets, one decimal", () => {
    expect(perThousand(10, 5)).toBe(2000);
    expect(perThousand(1, 5)).toBe(200);
    expect(perThousand(1, 3)).toBe(333.3);
  });
});

describe("fetchVetAccessByLocality", () => {
  const ctx = buildProjectionContext(
    { role: "govt" },
    [
      { province: TEST_PROVINCE, locality: LOC_HIGH },
      { province: TEST_PROVINCE, locality: LOC_LOW },
      { province: TEST_PROVINCE, locality: LOC_TINY },
    ],
    windows.trailing12m(),
  );

  it("suppresses localities below the k=5 active-pet threshold", async () => {
    const result = await fetchVetAccessByLocality(ctx);
    expect(result.suppressedCount).toBe(1);
    const localities = result.localities.map((r) => r.locality);
    expect(localities).toContain(LOC_HIGH);
    expect(localities).toContain(LOC_LOW);
    expect(localities).not.toContain(LOC_TINY);
  });

  // H6 (2026-07-30) — RENAMED. This used to be titled "orders care deserts
  // (lowest per1k) first", which is the exact conflation the red-team found on
  // /gob/analytics: it asserted an ORDER and called the result a desert. The
  // assertions themselves were always true and are unchanged; the name was the
  // lie, and it is the name the page's caption was written from. What the
  // fetcher guarantees is an ascending sort — nothing more.
  it("orders the lowest per1k first and computes the rate", async () => {
    const result = await fetchVetAccessByLocality(ctx);
    expect(result.localities[0].locality).toBe(LOC_LOW);
    expect(result.localities[0].per1k).toBe(200);
    expect(result.localities[0].visits).toBe(1);
    expect(result.localities[0].activePets).toBe(5);

    const high = result.localities.find((r) => r.locality === LOC_HIGH);
    expect(high?.per1k).toBe(2000);
  });

  it("refuses to call the first row a desert when its denominator is 5 pets", async () => {
    // The fixture is the false-desert shape in miniature: LOC_LOW leads the
    // ascending table at 200 per 1.000, which under the old caption made it a
    // "desierto de atención" purely by being first. It has five active pets —
    // one more veterinary act would put it at 400.
    const result = await fetchVetAccessByLocality(ctx);
    expect(result.localities[0].locality).toBe(LOC_LOW);
    expect(result.localities[0].band).toBe("small-sample");
  });

  it("carries the absolute floor the bands were measured against", async () => {
    // The page renders this number so the claim is checkable. Over a trailing
    // 12m window it is one act per pet per year.
    const result = await fetchVetAccessByLocality(ctx);
    expect(result.desertThresholdPer1k).toBeCloseTo(1000, 0);
  });

  it("classifies a well-populated locality against that floor, not against its neighbours", async () => {
    const result = await fetchVetAccessByLocality(ctx);
    const high = result.localities.find((r) => r.locality === LOC_HIGH);
    // LOC_HIGH is above the floor and, like every row here, under the
    // active-pet minimum — so it is reported without a verdict either way.
    expect(high?.band).toBe("small-sample");
    // And the classifier it delegates to would call the same rate "measured"
    // on a real population: the band is a function of the numbers, not of the
    // row's rank in the list.
    expect(classifyVetAccess({ per1k: high?.per1k ?? 0, activePets: 4000 }, 365)).toBe("measured");
  });
});

// ---------------------------------------------------------------------------
// Numerator width (2026-07-26). The numerator was `vet_visit_logged` ALONE,
// which is 85 rows in the whole database against 29.123 vaccinations, 19.742
// microchip implants and 17.817 sterilizations — so the layer read 0,0 in 23 of
// 24 provinces and only CABA had a value. A vaccination IS veterinary access.
// ---------------------------------------------------------------------------

describe("fetchVetAccessByLocality — the numerator counts every veterinary act", () => {
  const ctxFor = (locality: string) =>
    buildProjectionContext(
      { role: "govt" },
      [{ province: TEST_PROVINCE, locality }],
      windows.trailing12m(),
    );

  const rateIn = async (locality: string): Promise<number> => {
    const result = await fetchVetAccessByLocality(ctxFor(locality));
    const row = result.localities.find((r) => r.locality === locality);
    expect(row, `${locality} must survive k-anon (5 active pets)`).toBeDefined();
    return (row as { per1k: number }).per1k;
  };

  it.each([
    ["a vaccination", LOC_VAX],
    ["a sterilization", LOC_STERIL],
    ["a microchip implant", LOC_CHIP],
    ["a clinical record", LOC_CLINICAL],
  ])(
    "counts %s exactly like a logged visit (only the event type differs)",
    async (_label, loc) => {
      // Same 5 active pets, same single event, same date, same author role as
      // LOC_LOW — so an equal rate can only be explained by the event type.
      expect(await rateIn(loc)).toBe(200);
    },
    30_000,
  );

  it("does NOT count a deworming — antiparasitics are over-the-counter", async () => {
    // Including them would measure owner diligence, not access to a service.
    expect(await rateIn(LOC_DEWORM)).toBe(0);
  }, 30_000);

  it("declares the veterinary-act event set explicitly (shared with the desert layer)", () => {
    expect([...VET_ACTIVITY_EVENT_TYPES].sort()).toEqual(
      [
        "clinical_info_logged",
        "microchip_implanted",
        "sterilization_performed",
        "vaccination_administered",
        "vet_visit_logged",
      ].sort(),
    );
    // author_role names the REPORTER, not the performer (28.979 of 29.123
    // seeded vaccinations are owner-logged), so it is deliberately NOT a filter.
    expect(VET_ACTIVITY_EVENT_TYPES).not.toContain("deworming_administered");
  });
});

// ---------------------------------------------------------------------------
// H6 (external red-team 2026-07-30) — "desierto de atención" over a relative
// order. PURE, DB-free: everything below is the classifier, not the fetcher.
//
// WHAT SHIPPED: /gob/analytics sorted ascending and captioned the table "las
// primeras filas son desiertos de atención". Palermo led that list at 1.286,8
// actos / 1.000 activos — about 1,3 acts per pet per year, which is above the
// annual antirrábica the law already requires. The top of an ascending list is
// non-empty by construction; calling it a desert is a claim the sort cannot
// support, and a sanitary authority can allocate resources off it.
// ---------------------------------------------------------------------------

describe("classifyVetAccess — the 'desierto' label is measured, never positional", () => {
  const YEAR = 365;

  it("refuses to call the live Palermo figure a desert — lowest of the set is not a desert", () => {
    // The exact row that shipped: first in the ascending table, and above the
    // one-act-per-pet-per-year floor.
    expect(classifyVetAccess({ per1k: 1286.8, activePets: 4000 }, YEAR)).toBe("measured");
  });

  it("calls a genuinely deprived locality a desert — under one act per pet per year", () => {
    expect(classifyVetAccess({ per1k: 640, activePets: 4000 }, YEAR)).toBe("desert");
  });

  it("puts the boundary AT the floor: exactly one act per pet per year is not a desert", () => {
    expect(classifyVetAccess({ per1k: 1000, activePets: 4000 }, YEAR)).toBe("measured");
    expect(classifyVetAccess({ per1k: 999.9, activePets: 4000 }, YEAR)).toBe("desert");
  });

  it("never classifies a thin denominator, however low the ratio looks", () => {
    // The most tempting false desert on the table: a locality that cleared
    // k-anon (5 actives) reading 0 per 1.000 because nobody happened to take
    // an animal to a vet. One act would move it by 200.
    expect(classifyVetAccess({ per1k: 0, activePets: 5 }, YEAR)).toBe("small-sample");
    expect(classifyVetAccess({ per1k: 0, activePets: VET_ACCESS_MIN_ACTIVE_PETS - 1 }, YEAR)).toBe(
      "small-sample",
    );
  });

  it("classifies exactly AT the active-pet floor, not one pet above it", () => {
    expect(classifyVetAccess({ per1k: 0, activePets: VET_ACCESS_MIN_ACTIVE_PETS }, YEAR)).toBe(
      "desert",
    );
  });

  it("refuses to classify anything over a window too short to mean it", () => {
    // A 30-day window pro-rates the floor to ~82 per 1.000; a locality dips
    // under that by coincidence, not by deprivation.
    expect(classifyVetAccess({ per1k: 0, activePets: 4000 }, 30)).toBe("unclassified");
  });
});

describe("vetAccessDesertThresholdPer1k — pro-rated to the visible window", () => {
  it("is one act per pet over a year", () => {
    expect(vetAccessDesertThresholdPer1k(365)).toBe(1000);
  });

  it("scales with the window instead of pretending every period is a year", () => {
    // /gob/analytics has a period picker. A fixed acts-per-1k number would be
    // right on exactly one preset — this is the assertion that pins that the
    // threshold MOVES.
    expect(vetAccessDesertThresholdPer1k(90)).toBeCloseTo(246.6, 1);
    expect(vetAccessDesertThresholdPer1k(365 * 3)).toBe(3000);
  });

  it("returns null below the minimum window rather than a small confident number", () => {
    expect(vetAccessDesertThresholdPer1k(VET_ACCESS_DESERT_MIN_PERIOD_DAYS - 1)).toBeNull();
    expect(vetAccessDesertThresholdPer1k(7)).toBeNull();
    // …and exists exactly AT the minimum.
    expect(vetAccessDesertThresholdPer1k(VET_ACCESS_DESERT_MIN_PERIOD_DAYS)).not.toBeNull();
  });

  it("reads its active-pet floor from the catalog, not from a literal here", () => {
    // The threshold must live in the metric contract, so a future change to
    // the descriptor cannot leave the classifier behind.
    expect(VET_ACCESS_MIN_ACTIVE_PETS).toBe(
      KPI_CATALOG.vet_access_per_1k_locality.guards?.smallN?.min,
    );
  });
});

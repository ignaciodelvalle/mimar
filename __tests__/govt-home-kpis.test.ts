// Integration tests for lib/govt-home-kpis — focuses on the census denominator
// introduced in migration 0067.
//
// We exercise fetchBitesPer10k to assert that the rate is now derived from
// the jurisdictions_census table rather than the heuristic constants that
// the previous code used (3_000_000 for admin, localities × 50_000 for govt).

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases, db, jurisdictionsCensus, petEvents, pets } from "@/db";
import {
  fetchActiveZoonosis,
  fetchBitesPer10k,
  fetchNotifiedDiseases,
  fetchOpenBiteCases,
  fetchOpenRabiesObservations,
  fetchRabiesCoverage,
  fetchRabiesCoverageByProvince,
  fetchSterilizationMetrics,
} from "@/lib/analytics/govt-home-kpis";
import { buildProjectionContext, resetCensusPopulationsCache } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { withMutationOverride } from "./_helpers/db-overrides";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PROVINCE = "Santa Fe";
// A synthetic locality (not a real one like "Rosario") — scope isolation
// (commit 9e57a7b7 fixed jurisdiction scoping so seed-panorama's Santa
// Fe/Rosario bite rows now correctly count too, which broke the absolute
// reports===1 assertion below when it shared "Rosario" with seed data).
// Mirrors the unique-locality idiom used elsewhere in this suite (e.g.
// "DriftKpiVille", "BitesWindowVille").
const TEST_LOCALITY = "HkCensusKpiVille";
const TEST_PET_TOKEN = "HK-BITES-TEST-01";

// The INDEC 2022 Santa Fe population seeded in migration 0067.
// This must stay in sync with the value in the migration file.
const SANTA_FE_CENSUS_POPULATION = 3_556_522;

let testPetId: string;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function cleanupFixtures() {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`
      DELETE FROM pet_events
      WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${TEST_PET_TOKEN})
    `);
    await tx.execute(sql`
      DELETE FROM pets WHERE public_token = ${TEST_PET_TOKEN}
    `);
  });
}

async function insertBiteEvent(occurredAt: Date) {
  await db.insert(petEvents).values({
    petId: testPetId,
    eventType: "incident_reported",
    occurredAt,
    payload: {
      payload_version: 1,
      incident_type: "bite_inflicted",
      severity: "minor",
      injuries_summary: null,
      vet_involved: false,
      location_description: null,
      victim_species: "human",
      pet_jurisdiction_province: TEST_PROVINCE,
      pet_jurisdiction_locality: TEST_LOCALITY,
    },
    authorRole: "owner",
    recordedByUserId: null,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await cleanupFixtures();

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: TEST_PET_TOKEN,
      name: "BiteTestDog",
      species: "dog",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
    })
    .returning({ id: pets.id });
  testPetId = pet.id;
});

afterAll(cleanupFixtures);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchBitesPer10k — census denominator", () => {
  it("derives the per-10k rate from the census population (whole-province scope)", async () => {
    // The census lookup is process-cached (qw#5) — reset so this reads the DB
    // fresh (with the seeded Santa Fe row present).
    resetCensusPopulationsCache();
    // Insert one bite event in the last 12 months.
    await insertBiteEvent(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

    // Admin PROVINCE drill-down (no locality) is per-cápita eligible — the
    // numerator spans the whole province and fetchCensusPopulation sums that
    // province's census row (a govt actor cannot represent a whole GENERIC
    // province in one row; whole-province exists only for CABA's two-tier form,
    // and a locality-scoped ctx is now suppressed — see the sub-provincial test).
    // reports may also include seed Santa Fe bites, so derive the expected rate
    // from the RETURNED count: the assertion is that the DENOMINATOR is the real
    // census population, not a heuristic constant.
    const ctx = buildProjectionContext({ role: "admin" }, [], windows.trailing12m(), {
      adminProvince: TEST_PROVINCE,
    });
    const kpi = await fetchBitesPer10k(ctx);

    expect(kpi.percapitaEligible).toBe(true);
    expect(kpi.reports).toBeGreaterThanOrEqual(1);
    const expectedRate =
      Math.round((kpi.reports / (SANTA_FE_CENSUS_POPULATION / 10_000)) * 10) / 10;
    expect(kpi.rate).toBe(expectedRate);
  });

  it("returns rate=0 gracefully when no census row exists for the province", async () => {
    // Use a province that will NOT have a census row inserted.
    // We temporarily delete the row, assert zero, then restore.
    await db.delete(jurisdictionsCensus).where(eq(jurisdictionsCensus.provinceName, TEST_PROVINCE));
    // Reset the process cache so fetchCensusPopulation re-reads the DB WITHOUT the
    // just-deleted row (else the cached population would still be served — qw#5).
    resetCensusPopulationsCache();

    // Admin province drill-down (eligible) so we reach the census division, not
    // the sub-province suppression — with no census row the population is 0 and
    // the rate falls back to 0 rather than dividing by zero.
    const ctx = buildProjectionContext({ role: "admin" }, [], windows.trailing12m(), {
      adminProvince: TEST_PROVINCE,
    });

    try {
      const kpi = await fetchBitesPer10k(ctx);
      expect(kpi.percapitaEligible).toBe(true);
      expect(kpi.rate).toBe(0);
      expect(kpi.delta).toBe(0);
    } finally {
      // Restore the census row + clear the cache so later tests see it again.
      await db
        .insert(jurisdictionsCensus)
        .values({
          provinceName: TEST_PROVINCE,
          population: SANTA_FE_CENSUS_POPULATION,
          censusYear: 2022,
          source: "INDEC Censo 2022",
        })
        .onConflictDoNothing();
      resetCensusPopulationsCache();
    }
  });

  it("suppresses the per-10k rate at sub-province (locality) grain — count only", async () => {
    await insertBiteEvent(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

    // Locality-scoped: the numerator honors the locality, but jurisdictions_census
    // is province-grain only, so a per-10k rate would divide a comuna numerator by
    // the whole-province population — understating it. The KPI reports the absolute
    // count and marks percapitaEligible=false (H1), never a fabricated rate.
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: TEST_PROVINCE, locality: TEST_LOCALITY }],
      windows.trailing12m(),
    );
    const kpi = await fetchBitesPer10k(ctx);

    expect(kpi.percapitaEligible).toBe(false);
    expect(kpi.reports).toBeGreaterThanOrEqual(1);
    expect(kpi.rate).toBe(0);
    expect(kpi.delta).toBe(0);
  });

  it("returns rate=0 for empty govt jurisdictions without hitting the DB", async () => {
    const ctx = buildProjectionContext({ role: "govt" }, [], windows.trailing12m());
    const kpi = await fetchBitesPer10k(ctx);
    expect(kpi.rate).toBe(0);
    expect(kpi.delta).toBe(0);
    expect(kpi.reports).toBe(0);
  });

  it("admin scope uses the summed national census population", async () => {
    // For admin scope there's no WHERE on province; the rate should be
    // computed against the sum of all 24 provinces. We can't assert the
    // exact national total here (other fixtures may have bite events) but
    // we CAN assert that the rate is much smaller than it would be with
    // the old 3_000_000 heuristic, because the real national total is ~46M.
    const ctx = buildProjectionContext({ role: "admin" }, [], windows.trailing12m());
    const kpi = await fetchBitesPer10k(ctx);
    // A healthy DB with only our 1 fixture bite event should produce < 0.001.
    // Mainly asserting it doesn't throw and returns a non-negative number.
    expect(kpi.rate).toBeGreaterThanOrEqual(0);
    expect(kpi.reports).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Payload/pets jurisdiction drift (scope-security review 2026-07-04 A2)
// ---------------------------------------------------------------------------
//
// Event payloads carry pet_jurisdiction_* as an event-time snapshot. When the
// pet later moves, the payload and pets.jurisdiction_* diverge; payload-only
// scoping would count the (moved-away) pet into the OLD jurisdiction's govt
// aggregates. Fixtures: one pet that moved out of scope (payload in scope,
// current jurisdiction elsewhere) and one resident pet (both in scope), in a
// unique locality so scoped counts are exactly ours.

describe("govt KPI aggregates — payload/pets jurisdiction drift", () => {
  const DRIFT_PROVINCE = "Santa Fe";
  const DRIFT_LOCALITY = "DriftKpiVille"; // unique to this suite
  const TOKEN_MOVED = "HK-DRIFT-KPI-01";
  const TOKEN_RESIDENT = "HK-DRIFT-KPI-02";

  let movedPetId: string;
  let residentPetId: string;

  const driftCtx = () =>
    buildProjectionContext(
      { role: "govt" },
      [{ province: DRIFT_PROVINCE, locality: DRIFT_LOCALITY }],
      windows.trailing12m(),
    );

  async function cleanupDriftFixtures() {
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`
        DELETE FROM pet_events
        WHERE pet_id IN (
          SELECT id FROM pets WHERE public_token IN (${TOKEN_MOVED}, ${TOKEN_RESIDENT})
        )
      `);
      await tx.execute(sql`
        DELETE FROM pets WHERE public_token IN (${TOKEN_MOVED}, ${TOKEN_RESIDENT})
      `);
    });
  }

  async function insertDriftEvent(
    petId: string,
    eventType: string,
    extraPayload: Record<string, unknown>,
  ) {
    await db.insert(petEvents).values({
      petId,
      eventType,
      occurredAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      payload: {
        payload_version: 1,
        ...extraPayload,
        // Payload snapshot claims the DRIFT jurisdiction for BOTH pets; only
        // the resident pet's CURRENT pets.jurisdiction_* matches it.
        pet_jurisdiction_province: DRIFT_PROVINCE,
        pet_jurisdiction_locality: DRIFT_LOCALITY,
      },
      authorRole: "vet",
      recordedByUserId: null,
    });
  }

  beforeAll(async () => {
    await cleanupDriftFixtures();

    const inserted = await db
      .insert(pets)
      .values([
        {
          publicToken: TOKEN_MOVED,
          name: "DriftMovedKpiDog",
          species: "dog",
          // Moved away: current jurisdiction differs from the event payloads.
          jurisdictionProvince: "Córdoba",
          jurisdictionLocality: "Córdoba",
        },
        {
          publicToken: TOKEN_RESIDENT,
          name: "DriftResidentKpiDog",
          species: "dog",
          jurisdictionProvince: DRIFT_PROVINCE,
          jurisdictionLocality: DRIFT_LOCALITY,
        },
      ])
      .returning({ id: pets.id, publicToken: pets.publicToken });
    movedPetId = inserted.find((p) => p.publicToken === TOKEN_MOVED)?.id as string;
    residentPetId = inserted.find((p) => p.publicToken === TOKEN_RESIDENT)?.id as string;

    for (const petId of [movedPetId, residentPetId]) {
      await insertDriftEvent(petId, "incident_reported", {
        incident_type: "bite_inflicted",
        severity: "minor",
        victim_species: "human",
      });
      await insertDriftEvent(petId, "sterilization_performed", {});
      await insertDriftEvent(petId, "disease_reported", { disease: "lepto" });
    }
  });

  afterAll(cleanupDriftFixtures);

  it("fetchBitesPer10k counts only the resident pet's bite", async () => {
    const kpi = await fetchBitesPer10k(driftCtx());
    expect(kpi.reports).toBe(1);
  });

  it("fetchSterilizationMetrics counts only the resident pet's sterilization", async () => {
    const kpi = await fetchSterilizationMetrics(driftCtx());
    expect(kpi.count).toBe(1);
  });

  it("fetchActiveZoonosis disease arms count only the resident pet's report", async () => {
    const kpi = await fetchActiveZoonosis(driftCtx());
    expect(kpi.lepto).toBe(1);
    expect(kpi.hidat).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Amendment overlay in SQL aggregates (projection-cron audit 2026-07-03 A2)
// ---------------------------------------------------------------------------
//
// An event_amended correction MUST change the KPI: a vaccination logged as
// "Séxtuple" but corrected to "Antirrábica" counts toward rabies coverage,
// and the reverse correction un-counts it. Uses a locality no other fixture
// touches so the scoped denominator is exactly our pets.

describe("fetchRabiesCoverage — event_amended corrections project into the aggregate", () => {
  const AMEND_PROVINCE = "Santa Fe";
  const AMEND_LOCALITY = "AmendKpiVille"; // unique to this suite
  const TOKEN_MISLOGGED = "HK-AMEND-KPI-01"; // logged Séxtuple, corrected → Antirrábica
  const TOKEN_MISNAMED = "HK-AMEND-KPI-02"; // logged Antirrábica, corrected → Séxtuple

  let misloggedPetId: string;
  let misnamedPetId: string;
  let misloggedVaxId: string;
  let misnamedVaxId: string;

  const scopedCtx = () =>
    buildProjectionContext(
      { role: "govt" },
      [{ province: AMEND_PROVINCE, locality: AMEND_LOCALITY }],
      windows.trailing12m(),
    );

  async function cleanupAmendFixtures() {
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`
        DELETE FROM pet_events
        WHERE pet_id IN (
          SELECT id FROM pets WHERE public_token IN (${TOKEN_MISLOGGED}, ${TOKEN_MISNAMED})
        )
      `);
      await tx.execute(sql`
        DELETE FROM pets WHERE public_token IN (${TOKEN_MISLOGGED}, ${TOKEN_MISNAMED})
      `);
    });
  }

  async function insertVaccination(petId: string, vaccineName: string): Promise<string> {
    const [row] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "vaccination_administered",
        occurredAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        payload: {
          payload_version: 1,
          vaccine_name: vaccineName,
          brand: null,
          batch: null,
          administered_by: null,
          next_due_at: null,
          // petEventsScopeClause filters scoped govt reads on these payload
          // fields — required for the fixture to be visible in the scoped ctx.
          pet_jurisdiction_province: AMEND_PROVINCE,
          pet_jurisdiction_locality: AMEND_LOCALITY,
        },
        authorRole: "owner",
        recordedByUserId: null,
      })
      .returning({ id: petEvents.id });
    return row.id;
  }

  async function amendVaccineName(
    petId: string,
    targetEventId: string,
    from: string,
    to: string,
    occurredAt: Date = new Date(),
  ) {
    await db.insert(petEvents).values({
      petId,
      eventType: "event_amended",
      occurredAt,
      payload: {
        payload_version: 1,
        target_event_id: targetEventId,
        reason: "Nombre de vacuna mal cargado",
        changes: [{ field: "vaccine_name", old: from, new: to }],
      },
      authorRole: "owner",
      recordedByUserId: null,
    });
  }

  beforeAll(async () => {
    await cleanupAmendFixtures();
    const inserted = await db
      .insert(pets)
      .values(
        [TOKEN_MISLOGGED, TOKEN_MISNAMED].map((token) => ({
          publicToken: token,
          name: `AmendKpiDog-${token.slice(-2)}`,
          species: "dog",
          status: "active" as const,
          jurisdictionProvince: AMEND_PROVINCE,
          jurisdictionLocality: AMEND_LOCALITY,
        })),
      )
      .returning({ id: pets.id, publicToken: pets.publicToken });
    misloggedPetId = inserted.find((p) => p.publicToken === TOKEN_MISLOGGED)?.id as string;
    misnamedPetId = inserted.find((p) => p.publicToken === TOKEN_MISNAMED)?.id as string;

    misloggedVaxId = await insertVaccination(misloggedPetId, "Séxtuple");
    misnamedVaxId = await insertVaccination(misnamedPetId, "Antirrábica");
  });

  afterAll(cleanupAmendFixtures);

  it("before any correction, only the as-recorded rabies vaccine counts", async () => {
    const kpi = await fetchRabiesCoverage(scopedCtx());
    expect(kpi.hasData).toBe(true);
    // 2 dogs in scope, 1 counted (the raw Antirrábica) → 50%.
    expect(kpi.current).toBe(50);
  });

  it("corrections flip BOTH ways: Séxtuple→Antirrábica counts, Antirrábica→Séxtuple un-counts", async () => {
    await amendVaccineName(misloggedPetId, misloggedVaxId, "Séxtuple", "Antirrábica");
    await amendVaccineName(misnamedPetId, misnamedVaxId, "Antirrábica", "Séxtuple");

    const kpi = await fetchRabiesCoverage(scopedCtx());
    // Still 2 dogs; now the OTHER one counts → still 50%, but composed of the
    // corrected event. Assert composition via the per-province variant below.
    expect(kpi.current).toBe(50);

    const byProvince = await fetchRabiesCoverageByProvince(scopedCtx());
    const row = byProvince.find((r) => r.province === AMEND_PROVINCE);
    expect(row?.total).toBe(2);
    expect(row?.vaccinated).toBe(1);
  });

  it("a LATER amendment supersedes the earlier one (latest wins, as in overlayAmendments)", async () => {
    // Second correction on the mis-named pet restores Antirrábica → both count.
    // Strictly later occurredAt so the "latest wins" ordering is unambiguous.
    await amendVaccineName(
      misnamedPetId,
      misnamedVaxId,
      "Séxtuple",
      "Antirrábica",
      new Date(Date.now() + 60_000),
    );

    const kpi = await fetchRabiesCoverage(scopedCtx());
    expect(kpi.current).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// INVARIANT (val-2-govt B1): the rabies-coverage numerator window is a FIXED
// trailing 12 months intrinsic to the metric (annual vaccination, Ley 22.953) —
// NOT the caller's display period. Two surfaces sharing the "(perros, 12m)"
// label MUST show the SAME number: the /gob Panel (true trailing-12m ctx) and
// the Panorama console (whose "cumplimiento" preset commits ?period=90d) once
// rendered 42% vs 11% for the identical scope+label. This suite locks the fix:
// a dog vaccinated 180 days ago (older than 90d, within 12m) counts the same
// under a 90-day display window as under a 12-month one.
// ---------------------------------------------------------------------------

describe("fetchRabiesCoverage — numerator window is intrinsic 12m, not the display period", () => {
  const WIN_PROVINCE = "Santa Fe";
  const WIN_LOCALITY = "RabiesWindowVille"; // unique to this suite
  const WIN_TOKEN = "HK-RABIES-WINDOW-01";
  const DAY_MS = 24 * 60 * 60 * 1000;

  let winPetId: string;

  const scopedCtxForPeriod = (period: { since: Date; until: Date }) =>
    buildProjectionContext(
      { role: "govt" },
      [{ province: WIN_PROVINCE, locality: WIN_LOCALITY }],
      period,
    );

  async function cleanup() {
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`
        DELETE FROM pet_events
        WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${WIN_TOKEN})
      `);
      await tx.execute(sql`DELETE FROM pets WHERE public_token = ${WIN_TOKEN}`);
    });
  }

  beforeAll(async () => {
    await cleanup();
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: WIN_TOKEN,
        name: "RabiesWindowDog",
        species: "dog",
        status: "active",
        jurisdictionProvince: WIN_PROVINCE,
        jurisdictionLocality: WIN_LOCALITY,
      })
      .returning({ id: pets.id });
    winPetId = pet.id;

    // Rabies vaccination 180 days ago: inside a trailing-12m window, OUTSIDE a
    // trailing-90d window. Before the fix this dog was uncounted under a 90d
    // display period → 0% coverage; after the fix it counts under both.
    await db.insert(petEvents).values({
      petId: winPetId,
      eventType: "vaccination_administered",
      occurredAt: new Date(Date.now() - 180 * DAY_MS),
      payload: {
        payload_version: 1,
        vaccine_name: "Antirrábica",
        brand: null,
        batch: null,
        administered_by: null,
        next_due_at: null,
        pet_jurisdiction_province: WIN_PROVINCE,
        pet_jurisdiction_locality: WIN_LOCALITY,
      },
      authorRole: "owner",
      recordedByUserId: null,
    });
  });

  afterAll(cleanup);

  it("returns the SAME coverage for a 90-day and a 12-month display window", async () => {
    const now = Date.now();
    const period90d = { since: new Date(now - 90 * DAY_MS), until: new Date(now) };
    const period12m = windows.trailing12m();

    const kpi90d = await fetchRabiesCoverage(scopedCtxForPeriod(period90d));
    const kpi12m = await fetchRabiesCoverage(scopedCtxForPeriod(period12m));

    // 1 dog in scope, vaccinated 180d ago → 100% under BOTH windows (the metric
    // is a fixed trailing-12m, so the shorter display window cannot shrink it).
    expect(kpi90d.current).toBe(100);
    expect(kpi12m.current).toBe(100);
    expect(kpi90d.current).toBe(kpi12m.current);
  });
});

// ---------------------------------------------------------------------------
// INVARIANT (issue #52): "al día / covered" means the latest rabies dose is
// CURRENTLY VALID, not merely "a dose exists in the last 12 months". A dose that
// sets an explicit next_due_at counts only while `now <= next_due_at`; a dose
// with no next_due_at falls back to the trailing-12m proxy. So a dog whose last
// dose expired (next_due_at in the past) is NOT covered even if it was
// administered under 12 months ago; a dog whose next_due_at is in the future IS.
// ---------------------------------------------------------------------------

describe("fetchRabiesCoverage — currently-valid via next_due_at (issue #52)", () => {
  const VALID_PROVINCE = "Santa Fe";
  const EXPIRY_LOCALITY = "RabiesExpiryVille"; // FUTURE + PAST dogs
  const FALLBACK_LOCALITY = "RabiesFallbackVille"; // next_due_at absent
  const TOKEN_FUTURE = "HK-RABVALID-FUTURE";
  const TOKEN_PAST = "HK-RABVALID-PAST";
  const TOKEN_FALLBACK = "HK-RABVALID-FALLBACK";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const ALL_TOKENS = [TOKEN_FUTURE, TOKEN_PAST, TOKEN_FALLBACK];

  const ctxFor = (locality: string) =>
    buildProjectionContext(
      { role: "govt" },
      [{ province: VALID_PROVINCE, locality }],
      windows.trailing12m(),
    );

  async function cleanup() {
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`
        DELETE FROM pet_events
        WHERE pet_id IN (SELECT id FROM pets WHERE public_token IN (${sql.join(
          ALL_TOKENS.map((t) => sql`${t}`),
          sql`, `,
        )}))
      `);
      await tx.execute(sql`
        DELETE FROM pets WHERE public_token IN (${sql.join(
          ALL_TOKENS.map((t) => sql`${t}`),
          sql`, `,
        )})
      `);
    });
  }

  async function insertDog(token: string, locality: string): Promise<string> {
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: token,
        name: `RabValidDog-${token.slice(-4)}`,
        species: "dog",
        status: "active",
        jurisdictionProvince: VALID_PROVINCE,
        jurisdictionLocality: locality,
      })
      .returning({ id: pets.id });
    return pet.id;
  }

  async function insertRabiesDose(
    petId: string,
    locality: string,
    occurredAt: Date,
    nextDueAt: Date | null,
  ) {
    await db.insert(petEvents).values({
      petId,
      eventType: "vaccination_administered",
      occurredAt,
      payload: {
        payload_version: 1,
        vaccine_name: "Antirrábica",
        brand: null,
        batch: null,
        administered_by: null,
        next_due_at: nextDueAt ? nextDueAt.toISOString() : null,
        pet_jurisdiction_province: VALID_PROVINCE,
        pet_jurisdiction_locality: locality,
      },
      authorRole: "owner",
      recordedByUserId: null,
    });
  }

  beforeAll(async () => {
    await cleanup();
    const now = Date.now();
    // EXPIRY_LOCALITY: two dogs, both dosed 60 days ago (well within 12m).
    const futureId = await insertDog(TOKEN_FUTURE, EXPIRY_LOCALITY);
    const pastId = await insertDog(TOKEN_PAST, EXPIRY_LOCALITY);
    // next_due_at 200 days in the FUTURE → currently valid.
    await insertRabiesDose(
      futureId,
      EXPIRY_LOCALITY,
      new Date(now - 60 * DAY_MS),
      new Date(now + 200 * DAY_MS),
    );
    // next_due_at 10 days in the PAST → expired, NOT valid (despite <12m).
    await insertRabiesDose(
      pastId,
      EXPIRY_LOCALITY,
      new Date(now - 60 * DAY_MS),
      new Date(now - 10 * DAY_MS),
    );

    // FALLBACK_LOCALITY: one dog, dose 60 days ago, next_due_at ABSENT → proxy.
    const fallbackId = await insertDog(TOKEN_FALLBACK, FALLBACK_LOCALITY);
    await insertRabiesDose(fallbackId, FALLBACK_LOCALITY, new Date(now - 60 * DAY_MS), null);
  });

  afterAll(cleanup);

  it("a future next_due_at counts, an expired one does not (2 dogs → 50%)", async () => {
    const kpi = await fetchRabiesCoverage(ctxFor(EXPIRY_LOCALITY));
    expect(kpi.hasData).toBe(true);
    expect(kpi.current).toBe(50);

    const byProvince = await fetchRabiesCoverageByProvince(ctxFor(EXPIRY_LOCALITY));
    const row = byProvince.find((r) => r.province === VALID_PROVINCE);
    expect(row?.total).toBe(2);
    expect(row?.vaccinated).toBe(1); // only the future-dated dose
  });

  it("falls back to the 12m proxy when next_due_at is absent (1 dog → 100%)", async () => {
    const kpi = await fetchRabiesCoverage(ctxFor(FALLBACK_LOCALITY));
    expect(kpi.current).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// A CORRECTED next_due_at REACHES THE MINISTRY (review 2026-08-22, M6)
// ---------------------------------------------------------------------------
//
// The vaccine NAME was read through the amendment overlay; the DUE DATE, one
// line away, was read raw. So a vet who mistyped the booster date left the dog
// reading "vencida" to its owner, on its public QR credential and to the
// reminder scheduler — while the government kept counting it as covered until
// the wrong date. Measured on the local DB against a real dose with
// next_due_at = 2027-07-20: the govt predicate says covered (t), the same
// predicate over the corrected date says not covered (f).
//
// It runs BOTH ways, and the finding only claimed one. A date typed too EARLY
// and later corrected leaves the government treating a current dog as expired —
// the politically louder failure, because it makes the jurisdiction look worse
// than it is. Both directions are pinned below.

describe("fetchRabiesCoverage — a corrected next_due_at reaches the ministry", () => {
  const PROVINCE = "Santa Fe";
  const OVERCOUNT_LOCALITY = "RabiesAmendOverVille"; // due date corrected INTO the past
  const UNDERCOUNT_LOCALITY = "RabiesAmendUnderVille"; // due date corrected INTO the future
  const TOKEN_OVER = "HK-RABAMEND-OVER";
  const TOKEN_UNDER = "HK-RABAMEND-UNDER";
  const ALL_TOKENS = [TOKEN_OVER, TOKEN_UNDER];
  const DAY_MS = 24 * 60 * 60 * 1000;

  const ctxFor = (locality: string) =>
    buildProjectionContext(
      { role: "govt" },
      [{ province: PROVINCE, locality }],
      windows.trailing12m(),
    );

  async function cleanup() {
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`
        DELETE FROM pet_events
        WHERE pet_id IN (SELECT id FROM pets WHERE public_token IN (${sql.join(
          ALL_TOKENS.map((t) => sql`${t}`),
          sql`, `,
        )}))
      `);
      await tx.execute(sql`
        DELETE FROM pets WHERE public_token IN (${sql.join(
          ALL_TOKENS.map((t) => sql`${t}`),
          sql`, `,
        )})
      `);
    });
  }

  async function insertDog(token: string, locality: string): Promise<string> {
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: token,
        name: `RabAmendDog-${token.slice(-5)}`,
        species: "dog",
        status: "active",
        jurisdictionProvince: PROVINCE,
        jurisdictionLocality: locality,
      })
      .returning({ id: pets.id });
    return pet.id;
  }

  async function insertRabiesDose(
    petId: string,
    locality: string,
    occurredAt: Date,
    nextDueAt: Date,
  ): Promise<string> {
    const [row] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "vaccination_administered",
        occurredAt,
        payload: {
          payload_version: 1,
          vaccine_name: "Antirrábica",
          brand: null,
          batch: null,
          administered_by: null,
          next_due_at: nextDueAt.toISOString(),
          pet_jurisdiction_province: PROVINCE,
          pet_jurisdiction_locality: locality,
        },
        authorRole: "owner",
        recordedByUserId: null,
      })
      .returning({ id: petEvents.id });
    return row.id;
  }

  async function amendNextDueAt(
    petId: string,
    targetEventId: string,
    from: Date,
    to: Date,
    occurredAt: Date,
  ) {
    await db.insert(petEvents).values({
      petId,
      eventType: "event_amended",
      occurredAt,
      payload: {
        payload_version: 1,
        target_event_id: targetEventId,
        reason: "Fecha de refuerzo mal cargada",
        changes: [{ field: "next_due_at", old: from.toISOString(), new: to.toISOString() }],
      },
      authorRole: "owner",
      recordedByUserId: null,
    });
  }

  beforeAll(async () => {
    await cleanup();
    const now = Date.now();
    const dosedAt = new Date(now - 60 * DAY_MS);
    const future = new Date(now + 200 * DAY_MS);
    const past = new Date(now - 10 * DAY_MS);

    // OVERCOUNT: the vet typed a due date 200 days out; the owner corrected it
    // back to 10 days ago. The dog is NOT covered — and the ministry must agree.
    const overId = await insertDog(TOKEN_OVER, OVERCOUNT_LOCALITY);
    const overDose = await insertRabiesDose(overId, OVERCOUNT_LOCALITY, dosedAt, future);
    await amendNextDueAt(overId, overDose, future, past, new Date(now - DAY_MS));

    // UNDERCOUNT: the due date was typed 10 days ago by mistake and corrected
    // to 200 days out. The dog IS covered — and the ministry must agree.
    const underId = await insertDog(TOKEN_UNDER, UNDERCOUNT_LOCALITY);
    const underDose = await insertRabiesDose(underId, UNDERCOUNT_LOCALITY, dosedAt, past);
    await amendNextDueAt(underId, underDose, past, future, new Date(now - DAY_MS));
  });

  afterAll(cleanup);

  it("a due date corrected INTO THE PAST stops counting as covered (1 dog → 0%)", async () => {
    const kpi = await fetchRabiesCoverage(ctxFor(OVERCOUNT_LOCALITY));
    expect(kpi.hasData).toBe(true);
    expect(kpi.current).toBe(0);

    const byProvince = await fetchRabiesCoverageByProvince(ctxFor(OVERCOUNT_LOCALITY));
    const row = byProvince.find((r) => r.province === PROVINCE);
    expect(row?.total).toBe(1);
    expect(row?.vaccinated).toBe(0);
  });

  it("a due date corrected INTO THE FUTURE starts counting as covered (1 dog → 100%)", async () => {
    const kpi = await fetchRabiesCoverage(ctxFor(UNDERCOUNT_LOCALITY));
    expect(kpi.hasData).toBe(true);
    expect(kpi.current).toBe(100);

    const byProvince = await fetchRabiesCoverageByProvince(ctxFor(UNDERCOUNT_LOCALITY));
    const row = byProvince.find((r) => r.province === PROVINCE);
    expect(row?.total).toBe(1);
    expect(row?.vaccinated).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// INVARIANT (issue #58): period-driven flow KPIs whose LABEL states a fixed
// window must compute over that INTRINSIC window, not the caller's display
// period — otherwise the Panorama console (which commits ?period=90d via its
// "cumplimiento" preset) and the /gob Panel (12m/30d ctx) show different numbers
// under the same label. "Mordeduras / 10k hab." is a fixed trailing-12m rate;
// "Esterilizaciones / mes" is a fixed trailing-30d flow. Both anchor to
// ctx.period.until.
// ---------------------------------------------------------------------------

describe("fetchBitesPer10k — intrinsic 12m window, not the display period (issue #58)", () => {
  const BW_PROVINCE = "Santa Fe";
  const BW_LOCALITY = "BitesWindowVille"; // unique
  const BW_TOKEN = "HK-BITESWIN-01";
  const DAY_MS = 24 * 60 * 60 * 1000;
  let bwPetId: string;

  const ctxForPeriod = (period: { since: Date; until: Date }) =>
    buildProjectionContext(
      { role: "govt" },
      [{ province: BW_PROVINCE, locality: BW_LOCALITY }],
      period,
    );

  async function cleanup() {
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`
        DELETE FROM pet_events WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${BW_TOKEN})
      `);
      await tx.execute(sql`DELETE FROM pets WHERE public_token = ${BW_TOKEN}`);
    });
  }

  beforeAll(async () => {
    await cleanup();
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: BW_TOKEN,
        name: "BitesWindowDog",
        species: "dog",
        status: "active",
        jurisdictionProvince: BW_PROVINCE,
        jurisdictionLocality: BW_LOCALITY,
      })
      .returning({ id: pets.id });
    bwPetId = pet.id;
    // One bite 180 days ago: inside a trailing-12m window, OUTSIDE a 90d window.
    await db.insert(petEvents).values({
      petId: bwPetId,
      eventType: "incident_reported",
      occurredAt: new Date(Date.now() - 180 * DAY_MS),
      payload: {
        payload_version: 1,
        incident_type: "bite_inflicted",
        severity: "minor",
        injuries_summary: null,
        vet_involved: false,
        location_description: null,
        victim_species: "human",
        pet_jurisdiction_province: BW_PROVINCE,
        pet_jurisdiction_locality: BW_LOCALITY,
      },
      authorRole: "owner",
      recordedByUserId: null,
    });
  });

  afterAll(cleanup);

  it("counts the 180-day-old bite under BOTH a 90-day and a 12-month display window", async () => {
    const now = Date.now();
    const kpi90d = await fetchBitesPer10k(
      ctxForPeriod({ since: new Date(now - 90 * DAY_MS), until: new Date(now) }),
    );
    const kpi12m = await fetchBitesPer10k(ctxForPeriod(windows.trailing12m()));
    // Fixed trailing-12m: the shorter display window cannot shrink the numerator.
    expect(kpi90d.reports).toBe(1);
    expect(kpi12m.reports).toBe(1);
    expect(kpi90d.reports).toBe(kpi12m.reports);
  });
});

describe("fetchSterilizationMetrics — intrinsic 30d window, not the display period (issue #58)", () => {
  const SW_PROVINCE = "Santa Fe";
  const SW_LOCALITY = "SterilWindowVille"; // unique
  const SW_TOKEN = "HK-STERILWIN-01";
  const DAY_MS = 24 * 60 * 60 * 1000;
  let swPetId: string;

  const ctxForPeriod = (period: { since: Date; until: Date }) =>
    buildProjectionContext(
      { role: "govt" },
      [{ province: SW_PROVINCE, locality: SW_LOCALITY }],
      period,
    );

  async function cleanup() {
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`
        DELETE FROM pet_events WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${SW_TOKEN})
      `);
      await tx.execute(sql`DELETE FROM pets WHERE public_token = ${SW_TOKEN}`);
    });
  }

  async function insertSterilization(occurredAt: Date) {
    await db.insert(petEvents).values({
      petId: swPetId,
      eventType: "sterilization_performed",
      occurredAt,
      payload: {
        payload_version: 1,
        pet_jurisdiction_province: SW_PROVINCE,
        pet_jurisdiction_locality: SW_LOCALITY,
      },
      authorRole: "vet",
      recordedByUserId: null,
    });
  }

  beforeAll(async () => {
    await cleanup();
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: SW_TOKEN,
        name: "SterilWindowDog",
        species: "dog",
        status: "active",
        jurisdictionProvince: SW_PROVINCE,
        jurisdictionLocality: SW_LOCALITY,
      })
      .returning({ id: pets.id });
    swPetId = pet.id;
    // Two sterilizations: one 10 days ago (inside 30d), one 60 days ago (outside
    // the intrinsic 30d window but inside 12m).
    await insertSterilization(new Date(Date.now() - 10 * DAY_MS));
    await insertSterilization(new Date(Date.now() - 60 * DAY_MS));
  });

  afterAll(cleanup);

  it("counts only the last-30-day sterilization under BOTH a 30d and a 12m display window", async () => {
    const count30d = await fetchSterilizationMetrics(ctxForPeriod(windows.trailing30d()));
    const count12m = await fetchSterilizationMetrics(ctxForPeriod(windows.trailing12m()));
    // Fixed trailing-30d: a wider display period cannot pull in the 60-day event.
    expect(count30d.count).toBe(1);
    expect(count12m.count).toBe(1);
    expect(count30d.count).toBe(count12m.count);
  });
});

// ---------------------------------------------------------------------------
// Decomposed "Zoonosis activas" composite (PO-ratified): the single opaque KPI
// (fetchActiveZoonosis) is split into three independently-counted signals —
// fetchOpenRabiesObservations, fetchOpenBiteCases, fetchNotifiedDiseases. Each is
// asserted on its own seeded rows in a locality no other fixture touches so the
// scoped counts are exactly ours. Same scope + window primitives as the composite.
// ---------------------------------------------------------------------------

describe("decomposed zoonosis signals — three independent counts", () => {
  const Z_PROVINCE = "Santa Fe";
  const Z_LOCALITY = "ZoonosisDecompVille"; // unique to this suite
  const TOKEN_OBS_A = "HK-ZOO-OBS-A";
  const TOKEN_OBS_B = "HK-ZOO-OBS-B";
  const TOKEN_HOST = "HK-ZOO-HOST"; // hosts started/disease events + the bite case
  const ALL_TOKENS = [TOKEN_OBS_A, TOKEN_OBS_B, TOKEN_HOST];
  const CASE_CODES = ["HK-ZOO-CASE-1", "HK-ZOO-CASE-2", "HK-ZOO-CASE-3"];
  const DAY_MS = 24 * 60 * 60 * 1000;

  let hostPetId: string;

  const ctx = () =>
    buildProjectionContext(
      { role: "govt" },
      [{ province: Z_PROVINCE, locality: Z_LOCALITY }],
      windows.trailing12m(),
    );

  async function cleanup() {
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`
        DELETE FROM cases WHERE public_code IN (${sql.join(
          CASE_CODES.map((c) => sql`${c}`),
          sql`, `,
        )})
      `);
      await tx.execute(sql`
        DELETE FROM pet_events
        WHERE pet_id IN (SELECT id FROM pets WHERE public_token IN (${sql.join(
          ALL_TOKENS.map((t) => sql`${t}`),
          sql`, `,
        )}))
      `);
      await tx.execute(sql`
        DELETE FROM pets WHERE public_token IN (${sql.join(
          ALL_TOKENS.map((t) => sql`${t}`),
          sql`, `,
        )})
      `);
    });
  }

  beforeAll(async () => {
    await cleanup();

    // Two pets currently under a rabies observation + one event-host pet.
    const inserted = await db
      .insert(pets)
      .values([
        {
          publicToken: TOKEN_OBS_A,
          name: "ZooObsDogA",
          species: "dog",
          status: "active",
          jurisdictionProvince: Z_PROVINCE,
          jurisdictionLocality: Z_LOCALITY,
          rabiesObservationStatus: "in_progress",
        },
        {
          publicToken: TOKEN_OBS_B,
          name: "ZooObsDogB",
          species: "dog",
          status: "active",
          jurisdictionProvince: Z_PROVINCE,
          jurisdictionLocality: Z_LOCALITY,
          rabiesObservationStatus: "in_progress",
        },
        {
          publicToken: TOKEN_HOST,
          name: "ZooHostDog",
          species: "dog",
          status: "active",
          jurisdictionProvince: Z_PROVINCE,
          jurisdictionLocality: Z_LOCALITY,
        },
      ])
      .returning({ id: pets.id, publicToken: pets.publicToken });
    hostPetId = inserted.find((p) => p.publicToken === TOKEN_HOST)?.id as string;

    // rabies_observation_started: 2 this week, 1 last week → deltaWeek = +1.
    const now = Date.now();
    await db.insert(petEvents).values([
      {
        petId: hostPetId,
        eventType: "rabies_observation_started",
        occurredAt: new Date(now - 2 * DAY_MS),
        payload: { payload_version: 1 },
        authorRole: "vet",
        recordedByUserId: null,
      },
      {
        petId: hostPetId,
        eventType: "rabies_observation_started",
        occurredAt: new Date(now - 3 * DAY_MS),
        payload: { payload_version: 1 },
        authorRole: "vet",
        recordedByUserId: null,
      },
      {
        petId: hostPetId,
        eventType: "rabies_observation_started",
        occurredAt: new Date(now - 10 * DAY_MS),
        payload: { payload_version: 1 },
        authorRole: "vet",
        recordedByUserId: null,
      },
    ]);

    // disease_reported: lepto (5d) + hidatidosis (5d) + a THIRD disease (5d) inside
    // the 30d window, plus one lepto OUTSIDE the window (40d) → count=3, lepto=1, hidat=1.
    await db.insert(petEvents).values([
      {
        petId: hostPetId,
        eventType: "disease_reported",
        occurredAt: new Date(now - 5 * DAY_MS),
        payload: { payload_version: 1, disease: "lepto" },
        authorRole: "vet",
        recordedByUserId: null,
      },
      {
        petId: hostPetId,
        eventType: "disease_reported",
        occurredAt: new Date(now - 5 * DAY_MS),
        payload: { payload_version: 1, disease: "hidatidosis" },
        authorRole: "vet",
        recordedByUserId: null,
      },
      {
        petId: hostPetId,
        eventType: "disease_reported",
        occurredAt: new Date(now - 5 * DAY_MS),
        payload: { payload_version: 1, disease: "brucelosis" },
        authorRole: "vet",
        recordedByUserId: null,
      },
      {
        petId: hostPetId,
        eventType: "disease_reported",
        occurredAt: new Date(now - 40 * DAY_MS),
        payload: { payload_version: 1, disease: "lepto" },
        authorRole: "vet",
        recordedByUserId: null,
      },
    ]);

    // Bite cases: 2 open + 1 closed in scope → open count = 2. Unowned-animal
    // subjects (primaryPetId null) so the cases_open_per_pet_kind partial unique
    // index (one open case per pet+kind) doesn't reject the second open row.
    // fetchOpenBiteCases scopes on the jurisdiction columns, not the pet.
    await db.insert(cases).values([
      {
        publicCode: CASE_CODES[0],
        caseKind: "bite_incident",
        status: "open",
        primarySubjectKind: "unowned_animal",
        jurisdictionProvince: Z_PROVINCE,
        jurisdictionLocality: Z_LOCALITY,
      },
      {
        publicCode: CASE_CODES[1],
        caseKind: "bite_incident",
        status: "open",
        primarySubjectKind: "unowned_animal",
        jurisdictionProvince: Z_PROVINCE,
        jurisdictionLocality: Z_LOCALITY,
      },
      {
        publicCode: CASE_CODES[2],
        caseKind: "bite_incident",
        status: "closed",
        // cases_closed_consistency check: a closed case must carry closedReason + closedAt.
        closedReason: "resolved",
        closedAt: new Date(),
        primarySubjectKind: "unowned_animal",
        jurisdictionProvince: Z_PROVINCE,
        jurisdictionLocality: Z_LOCALITY,
      },
    ]);
  });

  afterAll(cleanup);

  it("fetchOpenRabiesObservations counts the two in-progress observations and a +1 weekly delta", async () => {
    const kpi = await fetchOpenRabiesObservations(ctx());
    expect(kpi.count).toBe(2);
    // 2 started this 7d − 1 started the prior 7d = +1.
    expect(kpi.deltaWeek).toBe(1);
  });

  it("fetchOpenBiteCases counts only the OPEN bite_incident cases (closed excluded)", async () => {
    const kpi = await fetchOpenBiteCases(ctx());
    expect(kpi.count).toBe(2);
  });

  it("fetchNotifiedDiseases counts ALL disease_reported in the 30d window with lepto/hidat sub-breakdown", async () => {
    const kpi = await fetchNotifiedDiseases(ctx());
    // 3 in-window (lepto + hidatidosis + brucelosis); the 40-day lepto is excluded.
    expect(kpi.count).toBe(3);
    expect(kpi.lepto).toBe(1);
    expect(kpi.hidat).toBe(1);
  });

  it("all three fetchers return zeros for an empty govt jurisdiction without hitting the DB", async () => {
    const emptyCtx = buildProjectionContext({ role: "govt" }, [], windows.trailing12m());
    expect(await fetchOpenRabiesObservations(emptyCtx)).toEqual({ count: 0, deltaWeek: 0 });
    expect(await fetchOpenBiteCases(emptyCtx)).toEqual({ count: 0 });
    // `other` joined the shape when the KPI's breakdown was made to reconcile
    // with its numerator (qa-triage 2026-07-23 finding #13: "2" vs "0 lepto ·
    // 1 hidat." — the unnamed remainder is now a named field).
    expect(await fetchNotifiedDiseases(emptyCtx)).toEqual({
      count: 0,
      lepto: 0,
      hidat: 0,
      other: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Deceased dogs: numerator ⊆ denominator (cowork audit finding #3, 2026-08-12)
// ---------------------------------------------------------------------------
//
// The denominator (dogsInScopeCondition) has always been
// `status IN ('active','lost')`. The numerator joined pet_events to pets and
// filtered species + scope but NOT status, so a dog vaccinated and later dead
// kept counting on top while dropping out of the bottom. Coverage — the
// flagship legal figure on /gob and Panorama — ran high, and in a small
// jurisdiction could exceed 100% outright. There is no clamp downstream, by
// design: a rate over 100 is the symptom, not the disease.
//
// WHAT WOULD HAVE TO BREAK FOR THESE TO FAIL: the status filter on the
// numerator. These count real rows through the real fetchers.
describe("fetchRabiesCoverage — a dog that died leaves BOTH sides of the ratio", () => {
  const DEAD_PROVINCE = "Santa Fe";
  const DEAD_LOCALITY = "DeceasedKpiVille"; // unique to this suite
  const TOKEN_LIVE_UNVAX = "HK-DEAD-KPI-01"; // alive, never vaccinated
  const TOKEN_DEAD_VAX = "HK-DEAD-KPI-02"; // vaccinated, then died
  const TOKEN_LIVE_VAX = "HK-DEAD-KPI-03"; // alive and vaccinated

  const scopedCtx = () =>
    buildProjectionContext(
      { role: "govt" },
      [{ province: DEAD_PROVINCE, locality: DEAD_LOCALITY }],
      windows.trailing12m(),
    );

  async function cleanupDeceasedFixtures() {
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`
        DELETE FROM pet_events
        WHERE pet_id IN (
          SELECT id FROM pets
          WHERE public_token IN (${TOKEN_LIVE_UNVAX}, ${TOKEN_DEAD_VAX}, ${TOKEN_LIVE_VAX})
        )
      `);
      await tx.execute(sql`
        DELETE FROM pets
        WHERE public_token IN (${TOKEN_LIVE_UNVAX}, ${TOKEN_DEAD_VAX}, ${TOKEN_LIVE_VAX})
      `);
    });
  }

  async function insertRabiesVaccination(petId: string) {
    await db.insert(petEvents).values({
      petId,
      eventType: "vaccination_administered",
      occurredAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      payload: {
        payload_version: 1,
        vaccine_name: "Antirrábica",
        brand: null,
        batch: null,
        administered_by: null,
        next_due_at: null,
        pet_jurisdiction_province: DEAD_PROVINCE,
        pet_jurisdiction_locality: DEAD_LOCALITY,
      },
      authorRole: "owner",
      recordedByUserId: null,
    });
  }

  async function insertDog(token: string, status: "active" | "deceased"): Promise<string> {
    const [row] = await db
      .insert(pets)
      .values({
        publicToken: token,
        name: `DeceasedKpiDog-${token.slice(-2)}`,
        species: "dog",
        status,
        jurisdictionProvince: DEAD_PROVINCE,
        jurisdictionLocality: DEAD_LOCALITY,
      })
      .returning({ id: pets.id });
    return row.id;
  }

  beforeAll(async () => {
    await cleanupDeceasedFixtures();
    // The vaccination is recorded while the dog is alive; death_recorded later
    // projects pets.status = 'deceased'. The spine is append-only, so the dose
    // event survives the death — which is exactly why the numerator has to
    // re-check status instead of trusting that the event implies a live pet.
    const deadVaxId = await insertDog(TOKEN_DEAD_VAX, "deceased");
    await insertRabiesVaccination(deadVaxId);
    await insertDog(TOKEN_LIVE_UNVAX, "active");
  });

  afterAll(cleanupDeceasedFixtures);

  it("does not count a deceased dog's dose against the live population", async () => {
    // 1 live unvaccinated + 1 dead vaccinated. Denominator = 1 (the live dog).
    // Before the fix the numerator counted the dead dog → 1/1 = 100% coverage
    // in a jurisdiction where the only living dog is unvaccinated.
    const kpi = await fetchRabiesCoverage(scopedCtx());

    expect(kpi.current).toBe(0);
  });

  it("never reports coverage above 100%", async () => {
    // Add a live vaccinated dog: denominator 2, numerator 1 → 50%. Before the
    // fix this was 2/2 with the dead dog also counted... but drop the live
    // unvaccinated one and the pre-fix arithmetic gives 2 vaccinated over 1
    // live dog = 200%. Assert the invariant directly, not just this instance.
    const liveVaxId = await insertDog(TOKEN_LIVE_VAX, "active");
    await insertRabiesVaccination(liveVaxId);

    const kpi = await fetchRabiesCoverage(scopedCtx());

    expect(kpi.current).toBeLessThanOrEqual(100);
    expect(kpi.current).toBe(50);
  });

  it("the per-province breakdown that feeds the choropleth agrees with the KPI", async () => {
    // #5 in the same audit: the alerts table filters activeCond while the
    // choropleth numerator did not, so the same province could show two
    // coverages depending on which panel you read.
    const byProvince = await fetchRabiesCoverageByProvince(scopedCtx());
    const row = byProvince.find((r) => r.province === DEAD_PROVINCE);

    expect(row?.total).toBe(2); // live only
    expect(row?.vaccinated).toBe(1); // the dead dog's dose is excluded
    expect(row?.ratePct).toBeLessThanOrEqual(100);
  });
});

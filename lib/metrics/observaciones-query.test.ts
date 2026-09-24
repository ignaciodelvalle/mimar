// Integration tests for lib/metrics/observaciones-query (F-migration
// 2026-07-21, OpFilterBar sweep tail — /admin/observaciones previously had NO
// filters at all). Requires a running local Postgres (local Supabase stack).
//
// Coverage:
//   1. Default view (no `status` filter) = in_progress OR completed with a
//      RECENT (<=30d) rabies_observation_ended event — unchanged from the
//      pre-migration page's hardcoded query.
//   2. `status` filter narrows to EXACTLY that status, with no time bound
//      (a historically-closed pet the default view excludes still shows up).
//   3. Jurisdiction (province) filter narrows an admin's universal scope.
//   4. Govt stays jurisdiction-fenced: a pet outside the govt's assigned
//      jurisdiction never appears, even though it matches every other filter.
//   5. Zero assignments ⇒ empty result (fail-closed), no query round-trip.

import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import { fetchObservaciones, parseObservacionEstado } from "@/lib/metrics/observaciones-query";
import { withMutationOverride } from "../../__tests__/_helpers/db-overrides";

const PREFIX = "OBS-"; // observaciones-query test
const PROV_A = "Santa Fe";
const LOC_A = "Rosario";
const PROV_B = "Córdoba";
const LOC_B = "Córdoba";
// Whole-province subsumption fixtures (pre-push review 2026-07-21): CABA is
// modeled by INDEC as a two-tier jurisdiction (lib/domain/jurisdiction-canonical.ts
// WHOLE_PROVINCE_LOCALITY) — the whole-province sentinel locality vs. specific
// barrios. A govt assignment on the sentinel must subsume every barrio.
const PROV_CABA = "CABA";
const LOC_CABA_WHOLE = "Ciudad Autónoma de Buenos Aires";
const LOC_PALERMO = "Palermo";
const LOC_ALMAGRO = "Almagro";

let createdPetIds: string[] = [];

let petInProgressAId = "";
let petCompletedRecentAId = "";
let petCompletedOldAId = "";
let petCompletedPositiveAId = "";
let petInProgressBId = "";
let petCabaPalermoId = "";
let petCabaAlmagroId = "";
let petWindowExpiredAId = "";

async function insertPet(opts: {
  token: string;
  province: string;
  locality: string;
  status:
    | "in_progress"
    | "window_expired_unclosed"
    | "completed_negative"
    | "completed_positive_rabies"
    | null;
}): Promise<string> {
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: opts.token,
      name: `${PREFIX}${opts.token}`,
      species: "dog",
      status: "active",
      jurisdictionProvince: opts.province,
      jurisdictionLocality: opts.locality,
      rabiesObservationStatus: opts.status,
    })
    .returning({ id: pets.id });
  createdPetIds.push(row.id);
  return row.id;
}

async function insertEndedEvent(petId: string, occurredAt: Date): Promise<void> {
  await db.insert(petEvents).values({
    petId,
    eventType: "rabies_observation_ended",
    occurredAt,
    recordedAt: occurredAt,
    authorRole: "vet",
    payload: { payload_version: 1 },
  });
}

async function cleanup() {
  const fixturePets = await db
    .select({ id: pets.id })
    .from(pets)
    .where(sql`${pets.publicToken} LIKE ${`${PREFIX}%`}`);
  const ids = fixturePets.map((p) => p.id);
  if (ids.length > 0) {
    await withMutationOverride(async (tx) => {
      await tx.delete(petEvents).where(inArray(petEvents.petId, ids));
    });
    await db.delete(pets).where(inArray(pets.id, ids));
  }
  createdPetIds = [];
}

beforeAll(async () => {
  await cleanup();

  const now = new Date();
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  petInProgressAId = await insertPet({
    token: `${PREFIX}IN-PROGRESS-A`,
    province: PROV_A,
    locality: LOC_A,
    status: "in_progress",
  });

  petWindowExpiredAId = await insertPet({
    token: `${PREFIX}WINDOW-EXPIRED-A`,
    province: PROV_A,
    locality: LOC_A,
    status: "window_expired_unclosed",
  });

  petCompletedRecentAId = await insertPet({
    token: `${PREFIX}COMPLETED-RECENT-A`,
    province: PROV_A,
    locality: LOC_A,
    status: "completed_negative",
  });
  await insertEndedEvent(petCompletedRecentAId, now);

  petCompletedOldAId = await insertPet({
    token: `${PREFIX}COMPLETED-OLD-A`,
    province: PROV_A,
    locality: LOC_A,
    status: "completed_negative",
  });
  await insertEndedEvent(petCompletedOldAId, sixtyDaysAgo);

  petCompletedPositiveAId = await insertPet({
    token: `${PREFIX}COMPLETED-POSITIVE-A`,
    province: PROV_A,
    locality: LOC_A,
    status: "completed_positive_rabies",
  });
  await insertEndedEvent(petCompletedPositiveAId, sixtyDaysAgo);

  petInProgressBId = await insertPet({
    token: `${PREFIX}IN-PROGRESS-B`,
    province: PROV_B,
    locality: LOC_B,
    status: "in_progress",
  });

  petCabaPalermoId = await insertPet({
    token: `${PREFIX}CABA-PALERMO`,
    province: PROV_CABA,
    locality: LOC_PALERMO,
    status: "in_progress",
  });

  petCabaAlmagroId = await insertPet({
    token: `${PREFIX}CABA-ALMAGRO`,
    province: PROV_CABA,
    locality: LOC_ALMAGRO,
    status: "in_progress",
  });
}, 30_000);

afterAll(async () => {
  await cleanup();
});

describe("parseObservacionEstado", () => {
  it("parses a valid status", () => {
    expect(parseObservacionEstado("completed_negative")).toBe("completed_negative");
  });

  it("returns null for an unknown or absent value (genuine 'all' default)", () => {
    expect(parseObservacionEstado(undefined)).toBeNull();
    expect(parseObservacionEstado("bogus")).toBeNull();
  });
});

describe("fetchObservaciones — default composite view", () => {
  it("includes in_progress and recently-completed pets, excludes old completions, universal admin scope", async () => {
    const rows = await fetchObservaciones(
      { role: "admin", province: null, locality: null },
      { status: null },
    );
    const ids = rows.map((r) => r.petId);

    expect(ids).toContain(petInProgressAId);
    expect(ids).toContain(petCompletedRecentAId);
    expect(ids).toContain(petInProgressBId);
    expect(ids).not.toContain(petCompletedOldAId);
    expect(ids).not.toContain(petCompletedPositiveAId);
  });

  // 2026-08-17: window_expired_unclosed is the ONLY row on this screen that
  // still needs an operator. It has no rabies_observation_ended event, so the
  // recency arm can never pick it up — if the open-status arm forgot it, the
  // entire new queue would be invisible on the screen built to work it.
  it("includes window_expired_unclosed pets in the default view", async () => {
    const rows = await fetchObservaciones(
      { role: "admin", province: null, locality: null },
      { status: null },
    );
    expect(rows.map((r) => r.petId)).toContain(petWindowExpiredAId);
  });

  it("sorts open observations (including window_expired_unclosed) ahead of closed ones", async () => {
    const rows = await fetchObservaciones(
      { role: "admin", province: PROV_A, locality: LOC_A },
      { status: null },
    );
    const openIdx = rows.findIndex((r) => r.petId === petWindowExpiredAId);
    const closedIdx = rows.findIndex((r) => r.petId === petCompletedRecentAId);
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(closedIdx).toBeGreaterThanOrEqual(0);
    expect(openIdx).toBeLessThan(closedIdx);
  });
});

describe("fetchObservaciones — status filter narrows results", () => {
  it("returns every pet with that status regardless of recency, and nothing else", async () => {
    const rows = await fetchObservaciones(
      { role: "admin", province: null, locality: null },
      { status: "completed_negative" },
    );
    const ids = rows.map((r) => r.petId);

    // Both the recent AND the old completed_negative pet — the status filter
    // has NO time bound, unlike the default composite view.
    expect(ids).toContain(petCompletedRecentAId);
    expect(ids).toContain(petCompletedOldAId);
    // Genuinely narrowed: none of the other statuses leak through.
    expect(ids).not.toContain(petInProgressAId);
    expect(ids).not.toContain(petInProgressBId);
    expect(ids).not.toContain(petCompletedPositiveAId);
  });

  it("a different status value narrows to a disjoint set", async () => {
    const rows = await fetchObservaciones(
      { role: "admin", province: null, locality: null },
      { status: "completed_positive_rabies" },
    );
    const ids = rows.map((r) => r.petId);

    expect(ids).toContain(petCompletedPositiveAId);
    expect(ids).not.toContain(petCompletedRecentAId);
    expect(ids).not.toContain(petCompletedOldAId);
  });
});

describe("fetchObservaciones — jurisdiction filter narrows an admin's universal scope", () => {
  it("province filter excludes pets outside that province", async () => {
    const rows = await fetchObservaciones(
      { role: "admin", province: PROV_A, locality: null },
      { status: null },
    );
    const ids = rows.map((r) => r.petId);

    expect(ids).toContain(petInProgressAId);
    expect(ids).toContain(petCompletedRecentAId);
    expect(ids).not.toContain(petInProgressBId);
  });
});

describe("fetchObservaciones — govt stays jurisdiction-fenced", () => {
  it("never returns a pet outside the govt's assigned jurisdiction, even matching every other filter", async () => {
    const rows = await fetchObservaciones(
      { role: "govt", jurisdictions: [{ province: PROV_A, locality: LOC_A }] },
      { status: null },
    );
    const ids = rows.map((r) => r.petId);

    expect(ids).toContain(petInProgressAId);
    expect(ids).toContain(petCompletedRecentAId);
    // PROV_B's in_progress pet matches the default composite condition on its
    // own — it must still be excluded purely by the jurisdiction fence.
    expect(ids).not.toContain(petInProgressBId);
  });

  it("zero assignments short-circuits to an empty result (fail-closed)", async () => {
    const rows = await fetchObservaciones({ role: "govt", jurisdictions: [] }, { status: null });
    expect(rows).toEqual([]);
  });
});

describe("fetchObservaciones — whole-province subsumption (pre-push review 2026-07-21)", () => {
  it("a whole-CABA assignment (province='CABA', locality=INDEC sentinel) matches a pet in a specific barrio (Palermo)", async () => {
    // Before the fix, the govt branch built raw AND(province=X, locality=Y)
    // pairs, so a whole-province assignment only matched the literal sentinel
    // locality string — never a real barrio like "Palermo". This is the
    // regression the fix (routing through jurisdictionPairClause) closes.
    const rows = await fetchObservaciones(
      { role: "govt", jurisdictions: [{ province: PROV_CABA, locality: LOC_CABA_WHOLE }] },
      { status: null },
    );
    const ids = rows.map((r) => r.petId);

    expect(ids).toContain(petCabaPalermoId);
    expect(ids).toContain(petCabaAlmagroId);
    // Still cross-province excluded.
    expect(ids).not.toContain(petInProgressAId);
    expect(ids).not.toContain(petInProgressBId);
  });

  it("a barrio-specific assignment (CABA/Palermo) stays exact-match — does not widen to the whole province", async () => {
    const rows = await fetchObservaciones(
      { role: "govt", jurisdictions: [{ province: PROV_CABA, locality: LOC_PALERMO }] },
      { status: null },
    );
    const ids = rows.map((r) => r.petId);

    expect(ids).toContain(petCabaPalermoId);
    expect(ids).not.toContain(petCabaAlmagroId);
  });
});

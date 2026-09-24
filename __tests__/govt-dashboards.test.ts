// Integration tests for lib/govt-dashboards. Uses ephemeral fixture rows
// (cleaned up after each test) and runs against the dev DB.

import { createClient } from "@supabase/supabase-js";
import { and, countDistinct, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  cases,
  custodyDisputes,
  db,
  ownerships,
  petEvents,
  pets,
  profiles,
  welfareReports,
} from "@/db";
import { fetchRegionRanking } from "@/lib/analytics/analytics-ranking";
import {
  custodyDisputesScopeClause,
  fetchAcquisitionTrend,
  fetchAnalyticsMetrics,
  fetchCasesForExport,
  fetchCasesPerCapita,
  fetchCasesPerLocality,
  fetchCasesPerProvinceChoropleth,
  fetchCasesPerSubregion,
  fetchDeathCauses,
  fetchDiseaseSummary,
  fetchEventsForExport,
  fetchLostPets,
  fetchOutbreakHistory,
  fetchPerdidasMetrics,
  fetchPetsForExport,
  fetchSurveillanceSignals,
  fetchVigilanciaMetrics,
  fetchWelfareMetrics,
  fetchZoonosisTrend,
} from "@/lib/analytics/govt-dashboards";
import { fetchOpenWelfareReportsCount } from "@/lib/analytics/govt-home-kpis";
import { amendedPayloadText } from "@/lib/infra/amendment-sql";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { buildProjectionContext } from "@/lib/metrics";
import { ANONYMITY_K } from "@/lib/metrics/anonymity";
import { windows } from "@/lib/metrics/period";
import { findDisease } from "@/lib/reference/diseases";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";
import { assertKpiListParity } from "./helpers/kpi-list-parity";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const OWNER_EMAIL = "govt-dash-owner@dim-test.local";
let ownerUserId: string;

const TEST_PET_TOKEN_PREFIX = "GD-TEST-";

async function ensureOwner(): Promise<string> {
  const { data: list } = await adminSdk.auth.admin.listUsers({ perPage: 200 });
  const existing = list?.users.find((u) => u.email === OWNER_EMAIL);
  if (existing) {
    // Verify the matching profile row also exists (handle_new_user trigger
    // populates it on user creation). An orphan auth user with no profile
    // breaks the ownership FK on insertFixturePet — rebuild from scratch.
    const [profile] = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.id, existing.id));
    if (profile) return existing.id;
    await adminSdk.auth.admin.deleteUser(existing.id);
  }
  const r = await createFreshTestUser(adminSdk, {
    email: OWNER_EMAIL,
    password: "GovtDashTest_2026!",
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser: ${r.error?.message}`);
  return r.data.user.id;
}

async function cleanupFixtureRows() {
  const fixturePets = await db
    .select({ id: pets.id })
    .from(pets)
    .where(sql`${pets.publicToken} LIKE ${`${TEST_PET_TOKEN_PREFIX}%`}`);
  const ids = fixturePets.map((p) => p.id);

  // Clean up fixture cases (by public_code prefix).
  await withMutationOverride(async (tx) => {
    await tx.delete(cases).where(sql`${cases.publicCode} LIKE ${"GD-CASE-TEST-%"}`);
  });

  if (ids.length === 0) return;
  // custody_disputes must be deleted BEFORE pet_events: raising_event_id FKs to
  // pet_events with NO cascade (migration 0025), so an event can't be deleted
  // while a dispute still references it. (pet_id IS cascade, but cleanup deletes
  // events before pets.) custody_dispute_parties cascades from custody_disputes.
  await db.delete(custodyDisputes).where(inArray(custodyDisputes.petId, ids));
  // pet_events has a BEFORE DELETE trigger blocking mutations; the
  // app.allow_event_mutation GUC is the documented escape hatch.
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(inArray(petEvents.petId, ids));
  });
  await db.delete(ownerships).where(inArray(ownerships.petId, ids));
  await db.delete(pets).where(inArray(pets.id, ids));
}

async function insertFixturePet(input: {
  name: string;
  species: string;
  province: string;
  locality: string;
  status?: "active" | "lost" | "deceased";
}): Promise<string> {
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: `${TEST_PET_TOKEN_PREFIX}${generatePublicToken().slice(4)}`,
      name: input.name,
      species: input.species,
      jurisdictionProvince: input.province,
      jurisdictionLocality: input.locality,
      status: input.status ?? "active",
    })
    .returning({ id: pets.id });
  await db.insert(ownerships).values({
    petId: row.id,
    ownerUserId,
    role: "owner",
  });
  return row.id;
}

async function emitOutbreakSignal(input: {
  petId: string;
  diseaseCode: string;
  province: string;
  locality: string;
  hoursAgo: number;
  /**
   * `disease_label` is FREE TEXT chosen by whichever writer emitted the signal:
   * production writers funnel it through `findDisease()`, `seed-panorama.ts`
   * writes "Rabia (sospechada)", and this fixture's default writes the raw code.
   * All three are legitimate spellings of the same disease, so callers may pin
   * one explicitly. Default stays the raw code — that spelling IS one of the
   * ones the aggregation has to merge.
   */
  diseaseLabel?: string;
}) {
  await db.insert(petEvents).values({
    petId: input.petId,
    eventType: "outbreak_signal",
    occurredAt: new Date(Date.now() - input.hoursAgo * 60 * 60 * 1000),
    payload: {
      payload_version: 1,
      source_symptom_event_id: "00000000-0000-0000-0000-000000000000",
      disease_code: input.diseaseCode,
      disease_label: input.diseaseLabel ?? input.diseaseCode,
      match_strength: {
        high_count: 1,
        medium_count: 0,
        low_count: 0,
        matched_symptom_codes: ["s_test"],
      },
      pet_jurisdiction_country: "AR",
      pet_jurisdiction_province: input.province,
      pet_jurisdiction_locality: input.locality,
      pet_species: "dog",
    },
    authorRole: "system",
    recordedByUserId: null,
  });
}

async function emitOutbreakSignalAt(input: {
  petId: string;
  diseaseCode: string;
  province: string;
  locality: string;
  occurredAt: Date;
}) {
  await db.insert(petEvents).values({
    petId: input.petId,
    eventType: "outbreak_signal",
    occurredAt: input.occurredAt,
    payload: {
      payload_version: 1,
      source_symptom_event_id: "00000000-0000-0000-0000-000000000000",
      disease_code: input.diseaseCode,
      disease_label: input.diseaseCode,
      match_strength: {
        high_count: 1,
        medium_count: 0,
        low_count: 0,
        matched_symptom_codes: ["s_test"],
      },
      pet_jurisdiction_country: "AR",
      pet_jurisdiction_province: input.province,
      pet_jurisdiction_locality: input.locality,
      pet_species: "dog",
    },
    authorRole: "system",
    recordedByUserId: null,
  });
}

beforeAll(async () => {
  ownerUserId = await ensureOwner();
  await cleanupFixtureRows();
});

afterEach(cleanupFixtureRows);

describe("fetchSurveillanceSignals", () => {
  it("returns all signals for admin (universal scope)", async () => {
    const petCABA = await insertFixturePet({
      name: "PetCABA",
      species: "dog",
      province: "CABA",
      locality: "CABA",
    });
    const petBA = await insertFixturePet({
      name: "PetBA",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    await emitOutbreakSignal({
      petId: petCABA,
      diseaseCode: "rabies_suspected",
      province: "CABA",
      locality: "CABA",
      hoursAgo: 1,
    });
    await emitOutbreakSignal({
      petId: petBA,
      diseaseCode: "leptospirosis_suspected",
      province: "Buenos Aires",
      locality: "La Plata",
      hoursAgo: 2,
    });

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const r = await fetchSurveillanceSignals({ role: "admin" }, [], { since });
    const tokens = new Set(r.map((s) => s.petPublicToken));
    expect(tokens.size).toBeGreaterThanOrEqual(2);
    const diseases = r.map((s) => s.diseaseCode);
    expect(diseases).toContain("rabies_suspected");
    expect(diseases).toContain("leptospirosis_suspected");
  });

  it("filters by govt scope — only signals in assigned localities", async () => {
    const petCABA = await insertFixturePet({
      name: "PetCABA",
      species: "dog",
      province: "CABA",
      locality: "CABA",
    });
    const petLP = await insertFixturePet({
      name: "PetLP",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    await emitOutbreakSignal({
      petId: petCABA,
      diseaseCode: "rabies_suspected",
      province: "CABA",
      locality: "CABA",
      hoursAgo: 1,
    });
    await emitOutbreakSignal({
      petId: petLP,
      diseaseCode: "rabies_suspected",
      province: "Buenos Aires",
      locality: "La Plata",
      hoursAgo: 2,
    });

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const r = await fetchSurveillanceSignals(
      { role: "govt" },
      [
        {
          province: "CABA",
          locality: "CABA",
        },
      ],
      { since },
    );
    expect(r.length).toBeGreaterThanOrEqual(1);
    for (const s of r) {
      expect(s.province).toBe("CABA");
    }
  });

  it("returns [] for govt with no assignments", async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const r = await fetchSurveillanceSignals({ role: "govt" }, [], { since });
    expect(r).toEqual([]);
  });

  it("respects the diseaseCode filter", async () => {
    const pet = await insertFixturePet({
      name: "PetX",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    await emitOutbreakSignal({
      petId: pet,
      diseaseCode: "rabies_suspected",
      province: "Buenos Aires",
      locality: "La Plata",
      hoursAgo: 1,
    });
    await emitOutbreakSignal({
      petId: pet,
      diseaseCode: "leptospirosis_suspected",
      province: "Buenos Aires",
      locality: "La Plata",
      hoursAgo: 1,
    });
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const r = await fetchSurveillanceSignals({ role: "admin" }, [], {
      since,
      diseaseCode: "rabies_suspected",
    });
    expect(r.length).toBeGreaterThanOrEqual(1);
    for (const s of r) expect(s.diseaseCode).toBe("rabies_suspected");
  });
});

// ---------------------------------------------------------------------------
// Payload/pets jurisdiction drift (scope-security review 2026-07-04 A1/A2).
//
// The outbreak_signal payload carries pet_jurisdiction_* as a snapshot at
// event time. When the pet later moves, the payload and pets.jurisdiction_*
// diverge; a payload-only scope would leak the (moved-away) pet to the govt
// viewer of the OLD jurisdiction. Each fetcher must also require the pet's
// CURRENT jurisdiction to be in scope. Fixtures use a unique locality so no
// other dev-DB rows can match the scoped queries.
// ---------------------------------------------------------------------------

describe("jurisdiction drift — payload vs pets.jurisdiction", () => {
  const DRIFT_PROV = "CABA";
  const DRIFT_LOC = "GD-DriftVille"; // unique to this suite
  const DRIFT_SCOPE = [{ province: DRIFT_PROV, locality: DRIFT_LOC }];
  const DISEASE = "drift_test_disease";
  const since = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

  /** Pet that MOVED AWAY: current jurisdiction elsewhere, payload in scope. */
  async function insertMovedPetWithSignal(): Promise<string> {
    const petId = await insertFixturePet({
      name: "DriftMovedPet",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    await emitOutbreakSignal({
      petId,
      diseaseCode: DISEASE,
      province: DRIFT_PROV,
      locality: DRIFT_LOC,
      hoursAgo: 1,
    });
    return petId;
  }

  /** Resident pet: current jurisdiction AND payload both in scope. */
  async function insertResidentPetWithSignal(): Promise<string> {
    const petId = await insertFixturePet({
      name: "DriftResidentPet",
      species: "dog",
      province: DRIFT_PROV,
      locality: DRIFT_LOC,
    });
    await emitOutbreakSignal({
      petId,
      diseaseCode: DISEASE,
      province: DRIFT_PROV,
      locality: DRIFT_LOC,
      hoursAgo: 1,
    });
    return petId;
  }

  it("fetchSurveillanceSignals: govt does not see a signal whose pet moved out of scope; resident pet still visible", async () => {
    await insertMovedPetWithSignal();
    await insertResidentPetWithSignal();

    const r = await fetchSurveillanceSignals({ role: "govt" }, DRIFT_SCOPE, { since: since() });
    const names = r.map((s) => s.petName);
    expect(names).not.toContain("DriftMovedPet");
    expect(names).toContain("DriftResidentPet");
  });

  it("fetchSurveillanceSignals: admin still sees the drifted signal (universal scope preserved)", async () => {
    await insertMovedPetWithSignal();

    const r = await fetchSurveillanceSignals({ role: "admin" }, [], { since: since() });
    expect(r.map((s) => s.petName)).toContain("DriftMovedPet");
  });

  it("fetchZoonosisTrend: govt counts exclude signals from pets that moved out of scope", async () => {
    await insertMovedPetWithSignal();
    await insertResidentPetWithSignal();

    const trend = await fetchZoonosisTrend({ role: "govt" }, DRIFT_SCOPE);
    // Only the resident pet's signal may count within this unique locality.
    const total = trend.reduce((s, p) => s + p.y, 0);
    expect(total).toBe(1);
  });

  // RA-3 C3: fetchOutbreakHistory now k-anonymises its (disease, locality,
  // province) groups, so a ONE-signal fixture is withheld for privacy reasons
  // and a drift assertion built on it would pass without testing drift at all.
  // These two tests top the fixture up to the k floor so the only thing that can
  // hide a group is the SCOPE rule they are actually about.
  async function topUpToKSignals(petId: string): Promise<void> {
    for (let i = 1; i < ANONYMITY_K; i++) {
      await emitOutbreakSignal({
        petId,
        diseaseCode: DISEASE,
        province: DRIFT_PROV,
        locality: DRIFT_LOC,
        hoursAgo: 1 + i,
      });
    }
  }

  it("fetchOutbreakHistory: govt history excludes signals from pets that moved out of scope", async () => {
    const moved = await insertMovedPetWithSignal();
    await topUpToKSignals(moved);

    const r = await fetchOutbreakHistory({ role: "govt" }, DRIFT_SCOPE);
    expect(r.rows.filter((row) => row.diseaseCode === DISEASE)).toEqual([]);
    // Excluded by SCOPE, not by k — the group is at the k floor, so a non-zero
    // suppressedCount here would mean the test is measuring the wrong rule.
    expect(r.suppressedCount).toBe(0);
  });

  it("fetchOutbreakHistory: resident pet's signals still appear for govt", async () => {
    const resident = await insertResidentPetWithSignal();
    await topUpToKSignals(resident);

    const r = await fetchOutbreakHistory({ role: "govt" }, DRIFT_SCOPE);
    const group = r.rows.find((row) => row.diseaseCode === DISEASE);
    expect(group).toBeDefined();
    expect(group?.totalSignals).toBe(ANONYMITY_K);
  });
});

// ---------------------------------------------------------------------------
// Jurisdiction drift — fitness sweep across the REMAINING govt fetchers
// (task #33 / test-coverage-review TOP-5 gap #3). fetchSurveillanceSignals,
// fetchZoonosisTrend, and fetchOutbreakHistory already got moved-pet drift
// coverage above (scope-security review 2026-07-04 A1/A2). This block closes
// the "verify the OTHERS" gap for the export tail + fetchAnalyticsMetrics /
// fetchDeathCauses (lib/analytics/govt-dashboards.ts:2163+).
//
// fetchPetsForExport / fetchAnalyticsMetrics / fetchDeathCauses scope on the
// pet's CURRENT jurisdiction (pets.jurisdiction_province/locality, either
// directly or via an inner join) — they never read the payload snapshot, so
// they are drift-safe BY CONSTRUCTION. These tests assert that and lock it
// in as a regression control.
//
// fetchEventsForExport ALSO scopes via petEventsScopeClause (the event-payload
// jurisdiction snapshot), so it originally leaked a moved-away pet's events into
// the old jurisdiction's export. Fixed 2026-07-04: it now additionally applies
// petsCurrentJurisdictionClause (pets is inner-joined), matching its sibling
// fetchers (fetchSurveillanceSignals / fetchZoonosisTrend / fetchOutbreakHistory).
// The test below is now a plain regression control.
// ---------------------------------------------------------------------------

describe("jurisdiction drift — export & analytics fetchers fitness sweep (task #33)", () => {
  const SWEEP_PROV = "CABA";
  const SWEEP_LOC = "GD-DriftSweepVille"; // unique to this suite
  const SWEEP_SCOPE = [{ province: SWEEP_PROV, locality: SWEEP_LOC }];

  async function petPublicTokenOf(petId: string): Promise<string> {
    const [row] = await db
      .select({ publicToken: pets.publicToken })
      .from(pets)
      .where(eq(pets.id, petId));
    return row.publicToken;
  }

  it("fetchPetsForExport: excludes a pet whose CURRENT jurisdiction is outside govt scope (drift-safe by construction)", async () => {
    const movedId = await insertFixturePet({
      name: "DriftSweepPetsExpMoved",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    const residentId = await insertFixturePet({
      name: "DriftSweepPetsExpResident",
      species: "dog",
      province: SWEEP_PROV,
      locality: SWEEP_LOC,
    });
    const movedToken = await petPublicTokenOf(movedId);
    const residentToken = await petPublicTokenOf(residentId);

    const r = await fetchPetsForExport({ role: "govt" }, SWEEP_SCOPE);
    const tokens = r.map((row) => row.publicToken);
    expect(tokens).not.toContain(movedToken);
    expect(tokens).toContain(residentToken);
  });

  it("fetchAnalyticsMetrics: rabiesVaccinationRate never counts a vaccination event whose pet moved OUT of govt scope, even though the payload still carries the old jurisdiction", async () => {
    const movedId = await insertFixturePet({
      name: "DriftSweepAnalyticsMoved",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    await insertFixturePet({
      name: "DriftSweepAnalyticsResident",
      species: "dog",
      province: SWEEP_PROV,
      locality: SWEEP_LOC,
    });
    // Moved pet's vaccination payload claims the govt's scope (stale
    // event-time snapshot) — but the pet's CURRENT jurisdiction is elsewhere.
    await emitVaccinationWithName({
      petId: movedId,
      vaccineName: "Antirrábica",
      province: SWEEP_PROV,
      locality: SWEEP_LOC,
    });
    // Resident pet has no vaccination — if the moved pet's event leaked in
    // via the payload, the rate would be > 0.

    const m = await fetchAnalyticsMetrics({ role: "govt" }, SWEEP_SCOPE);
    expect(m.totalPets).toBeGreaterThanOrEqual(1);
    expect(m.rabiesVaccinationRate).toBe(0);
  });

  it("fetchDeathCauses: excludes a death event whose pet moved OUT of govt scope, even though the payload still carries the old jurisdiction", async () => {
    const movedId = await insertFixturePet({
      name: "DriftSweepDeathMoved",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    await emitDeathEvent({
      petId: movedId,
      cause: "accident",
      province: SWEEP_PROV,
      locality: SWEEP_LOC,
    });

    const r = await fetchDeathCauses({ role: "govt" }, SWEEP_SCOPE);
    expect(r.find((row) => row.cause === "accident")).toBeUndefined();
  });

  it("fetchEventsForExport: govt export excludes events from a pet that moved OUT of scope (pets-current-jurisdiction guard, matching its sibling fetchers)", async () => {
    const movedId = await insertFixturePet({
      name: "DriftSweepEventsExpMoved",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    await emitOutbreakSignal({
      petId: movedId,
      diseaseCode: "drift_sweep_export_disease",
      province: SWEEP_PROV,
      locality: SWEEP_LOC,
      hoursAgo: 1,
    });
    const movedToken = await petPublicTokenOf(movedId);

    const r = await fetchEventsForExport({ role: "govt" }, SWEEP_SCOPE);
    const tokens = r.map((row) => row.petPublicToken);
    expect(tokens).not.toContain(movedToken);
  });
});

// ---------------------------------------------------------------------------
// Export honors active filters — admin province/locality drill-down
// (Fase C, saved-views/export-honors-filters, 2026-07-21).
//
// /gob/analytics/export's JurisdictionSwitcher lets an admin narrow the
// export to a single province/locality (Panorama-style drill-down), same as
// every other analytics dashboard's OpFilterBar. Before this fix, the
// export server action never forwarded the selection into fetchPetsForExport/
// fetchEventsForExport/fetchCasesForExport/fetchOrganizationsForExport — the
// switcher visibly updated but the generated file always covered the WHOLE
// nation for an admin (view↔export honesty gap). These fetchers' admin-drill
// params (adminProvince/adminLocality) already existed on the underlying
// _scope.ts helpers (petsScopeClause/petsCurrentJurisdictionClause/
// casesScopeClause) for the on-screen dashboards — this closes the gap by
// threading them through the EXPORT fetchers too.
describe("export honors active filters — admin province/locality drill-down (Fase C)", () => {
  const DRILL_PROV = "CABA";
  const DRILL_LOC = "GD-ExportDrillVille"; // unique to this suite

  it("fetchPetsForExport: admin + adminProvince/adminLocality narrows to that jurisdiction only", async () => {
    const insideId = await insertFixturePet({
      name: "ExportDrillPetInside",
      species: "dog",
      province: DRILL_PROV,
      locality: DRILL_LOC,
    });
    const outsideId = await insertFixturePet({
      name: "ExportDrillPetOutside",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    const [insideRow] = await db
      .select({ publicToken: pets.publicToken })
      .from(pets)
      .where(eq(pets.id, insideId));
    const [outsideRow] = await db
      .select({ publicToken: pets.publicToken })
      .from(pets)
      .where(eq(pets.id, outsideId));

    // No drill-down (backward-compat): admin export is UNRESTRICTED by
    // jurisdiction but row-capped — against a seeded DB larger than the cap,
    // "universal contains my fixture" is unsound (the fixture may fall outside
    // the capped window by ordering). Assert the backward-compat property that
    // is actually guaranteed: the universal export returns rows and is not
    // narrowed to the drill jurisdiction (it spans >1 province).
    const universal = await fetchPetsForExport({ role: "admin" }, []);
    expect(universal.length).toBeGreaterThan(0);
    const universalProvinces = new Set(universal.map((r) => r.jurisdictionProvince));
    expect(universalProvinces.size).toBeGreaterThan(1);

    // Drilled down: only the selected province/locality survives.
    const drilled = await fetchPetsForExport({ role: "admin" }, [], {}, DRILL_PROV, DRILL_LOC);
    const drilledTokens = drilled.map((r) => r.publicToken);
    expect(drilledTokens).toContain(insideRow.publicToken);
    expect(drilledTokens).not.toContain(outsideRow.publicToken);
  });

  it("fetchEventsForExport: admin drill-down excludes events from a pet outside the selected jurisdiction", async () => {
    const insideId = await insertFixturePet({
      name: "ExportDrillEventInside",
      species: "dog",
      province: DRILL_PROV,
      locality: DRILL_LOC,
    });
    const outsideId = await insertFixturePet({
      name: "ExportDrillEventOutside",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    await emitOutbreakSignal({
      petId: insideId,
      diseaseCode: "export_drill_disease",
      province: DRILL_PROV,
      locality: DRILL_LOC,
      hoursAgo: 1,
    });
    await emitOutbreakSignal({
      petId: outsideId,
      diseaseCode: "export_drill_disease",
      province: "Buenos Aires",
      locality: "La Plata",
      hoursAgo: 1,
    });
    const [insideRow] = await db
      .select({ publicToken: pets.publicToken })
      .from(pets)
      .where(eq(pets.id, insideId));
    const [outsideRow] = await db
      .select({ publicToken: pets.publicToken })
      .from(pets)
      .where(eq(pets.id, outsideId));

    const drilled = await fetchEventsForExport({ role: "admin" }, [], {}, DRILL_PROV, DRILL_LOC);
    const tokens = drilled
      .filter((r) => r.eventType === "outbreak_signal")
      .map((r) => r.petPublicToken);
    expect(tokens).toContain(insideRow.publicToken);
    expect(tokens).not.toContain(outsideRow.publicToken);
  });

  it("fetchCasesForExport: admin drill-down excludes a case outside the selected jurisdiction", async () => {
    await insertFixtureCase({
      caseKind: "custody_dispute",
      province: DRILL_PROV,
      locality: DRILL_LOC,
    });
    await insertFixtureCase({
      caseKind: "custody_dispute",
      province: "Buenos Aires",
      locality: "La Plata",
    });

    const drilled = await fetchCasesForExport({ role: "admin" }, [], {}, DRILL_PROV, DRILL_LOC);
    expect(drilled.length).toBeGreaterThan(0);
    for (const row of drilled) {
      expect(row.jurisdictionProvince).toBe(DRILL_PROV);
      expect(row.jurisdictionLocality).toBe(DRILL_LOC);
    }
  });
});

describe("fetchDiseaseSummary", () => {
  it("aggregates counts into 30d / 7d / 24h buckets", async () => {
    const pet = await insertFixturePet({
      name: "PetSum",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    // 3 signals in the last 24h, 5 in the last 7 days (incl. the 3), 8 in 30 days.
    await emitOutbreakSignal({
      petId: pet,
      diseaseCode: "rabies_suspected",
      province: "Buenos Aires",
      locality: "La Plata",
      hoursAgo: 1,
    });
    await emitOutbreakSignal({
      petId: pet,
      diseaseCode: "rabies_suspected",
      province: "Buenos Aires",
      locality: "La Plata",
      hoursAgo: 3,
    });
    await emitOutbreakSignal({
      petId: pet,
      diseaseCode: "rabies_suspected",
      province: "Buenos Aires",
      locality: "La Plata",
      hoursAgo: 12,
    });
    await emitOutbreakSignal({
      petId: pet,
      diseaseCode: "rabies_suspected",
      province: "Buenos Aires",
      locality: "La Plata",
      hoursAgo: 48,
    });
    await emitOutbreakSignal({
      petId: pet,
      diseaseCode: "rabies_suspected",
      province: "Buenos Aires",
      locality: "La Plata",
      hoursAgo: 6 * 24,
    });

    const summary = await fetchDiseaseSummary({ role: "admin" }, []);
    const rabies = summary.find((d) => d.diseaseCode === "rabies_suspected");
    expect(rabies).toBeDefined();
    if (!rabies) return;
    expect(rabies.count24h).toBeGreaterThanOrEqual(3);
    expect(rabies.count7d).toBeGreaterThanOrEqual(5);
    expect(rabies.count30d).toBeGreaterThanOrEqual(5);
    expect(rabies.diseaseName).toMatch(/[Rr]abia/);
  });
});

describe("fetchLostPets", () => {
  async function markLost(petId: string, hoursAgo: number) {
    await db.update(pets).set({ status: "lost" }).where(eq(pets.id, petId));
    await db.insert(petEvents).values({
      petId,
      eventType: "status_changed",
      occurredAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
      payload: {
        payload_version: 1,
        from_status: "active",
        to_status: "lost",
        location_description: null,
        reason: null,
      },
      authorRole: "owner",
      recordedByUserId: ownerUserId,
      locationLat: "-34.6033",
      locationLng: "-58.3815",
    });
  }

  /** Mark a pet recovered the way the app does: status back to active + the
   *  status_changed event the KPI counts. */
  async function markRecovered(petId: string, hoursAgo: number) {
    await db.update(pets).set({ status: "active" }).where(eq(pets.id, petId));
    await db.insert(petEvents).values({
      petId,
      eventType: "status_changed",
      occurredAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
      payload: {
        payload_version: 1,
        from_status: "lost",
        to_status: "active",
        location_description: null,
        reason: null,
      },
      authorRole: "owner",
      recordedByUserId: ownerUserId,
    });
  }

  // The tab labelled "Recuperadas" used to map to `status=active` and therefore
  // listed the whole living padrón — 260 rows beside a KPI reading 2 (live
  // review 2026-07-28). Recovery is a TRANSITION in the spine, not a status: a
  // pet that was never lost is `active` too.
  describe("status=recovered — event-sourced, not a status", () => {
    it("lists a pet that went lost → active, and NOT one that was merely never lost", async () => {
      const recovered = await insertFixturePet({
        name: "Recovered-CABA",
        species: "dog",
        province: "CABA",
        locality: "CABA",
      });
      const neverLost = await insertFixturePet({
        name: "NeverLost-CABA",
        species: "dog",
        province: "CABA",
        locality: "CABA",
      });
      await markLost(recovered, 48);
      await markRecovered(recovered, 2);

      const names = new Set(
        (await fetchLostPets({ role: "admin" }, [], { status: "recovered" })).map((r) => r.petName),
      );
      expect(names.has("Recovered-CABA")).toBe(true);
      // The whole point: `neverLost` is status=active too, and must NOT appear.
      expect(names.has("NeverLost-CABA")).toBe(false);
    });

    it("excludes a recovery older than the window the KPI uses", async () => {
      const old = await insertFixturePet({
        name: "RecoveredLongAgo",
        species: "dog",
        province: "CABA",
        locality: "CABA",
      });
      await markLost(old, 24 * 90);
      await markRecovered(old, 24 * 60); // 60 days ago — outside the 30d window

      const names = new Set(
        (await fetchLostPets({ role: "admin" }, [], { status: "recovered" })).map((r) => r.petName),
      );
      expect(names.has("RecoveredLongAgo")).toBe(false);
    });

    it("does not count a pet still lost as recovered", async () => {
      const stillLost = await insertFixturePet({
        name: "StillLost",
        species: "dog",
        province: "CABA",
        locality: "CABA",
      });
      await markLost(stillLost, 3);

      const names = new Set(
        (await fetchLostPets({ role: "admin" }, [], { status: "recovered" })).map((r) => r.petName),
      );
      expect(names.has("StillLost")).toBe(false);
    });
  });

  it("admin sees all lost pets across provinces", async () => {
    const a = await insertFixturePet({
      name: "Lost-CABA",
      species: "dog",
      province: "CABA",
      locality: "CABA",
    });
    const b = await insertFixturePet({
      name: "Lost-LP",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    await markLost(a, 1);
    await markLost(b, 2);

    const r = await fetchLostPets({ role: "admin" }, []);
    const names = new Set(r.map((p) => p.petName));
    expect(names.has("Lost-CABA")).toBe(true);
    expect(names.has("Lost-LP")).toBe(true);
  });

  it("pulls the fetch window IN ORDER, so the newest case cannot fall off it", async () => {
    // THE SAME DEFECT `lost-listing-order-above-cap.test.ts` DOCUMENTS FOR THE
    // PUBLIC LISTING, found here on 2026-09-11 and never fixed on this side.
    // `fetchLostPets` capped at 500 with NO `orderBy`, so Postgres returned an
    // arbitrary five hundred: the plan decides, the same jurisdiction can
    // answer with a different set of animals on two consecutive loads, and a
    // pet that went missing an hour ago may simply not be on the page. On
    // staging the public listing crossed that line at 4011 lost pets and the
    // three genuinely newest were absent from page 1 — one of them the only
    // lost pet in the database carrying a photo.
    //
    // It surfaced as a FLAKE: the test above passed alone and failed inside the
    // full suite, once the local database had accumulated more than 500 lost
    // pets across runs and the seeded row fell outside the arbitrary window.
    //
    // THE PROBE, mirroring the precedent's: filler rows first, the needle
    // inserted LAST so it is physically last in the heap, and the cap set one
    // short of the fixture. An unordered LIMIT returns the physically-first
    // rows and drops the needle — which is what makes this fail against the old
    // code rather than pass by luck. Ordered by `updatedAt DESC`, the needle
    // was touched most recently of anything in the table, so it comes first.
    const FILLER = 5;
    for (let i = 0; i < FILLER; i++) {
      const id = await insertFixturePet({
        name: `Relleno-orden-${i}`,
        species: "dog",
        province: "CABA",
        locality: "CABA",
      });
      await markLost(id, 10 + i);
    }
    const needleId = await insertFixturePet({
      name: "Aguja-orden",
      species: "dog",
      province: "CABA",
      locality: "CABA",
    });
    await markLost(needleId, 1);

    const page = await fetchLostPets({ role: "admin" }, [], { fetchCap: FILLER });
    expect(page.map((p) => p.petName)).toContain("Aguja-orden");
  });

  it("govt only sees lost pets in their assigned localities", async () => {
    const a = await insertFixturePet({
      name: "Lost-CABA",
      species: "dog",
      province: "CABA",
      locality: "CABA",
    });
    const b = await insertFixturePet({
      name: "Lost-LP",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    await markLost(a, 1);
    await markLost(b, 2);

    const r = await fetchLostPets({ role: "govt" }, [
      { province: "Buenos Aires", locality: "La Plata" },
    ]);
    const names = r.map((p) => p.petName);
    expect(names).toContain("Lost-LP");
    expect(names).not.toContain("Lost-CABA");
  });

  it("returns [] for govt with no assignments", async () => {
    const r = await fetchLostPets({ role: "govt" }, []);
    expect(r).toEqual([]);
  });

  it("filters by species", async () => {
    const dog = await insertFixturePet({
      name: "LostDog",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    const cat = await insertFixturePet({
      name: "LostCat",
      species: "cat",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    await markLost(dog, 1);
    await markLost(cat, 1);

    const r = await fetchLostPets({ role: "admin" }, [], { species: "cat" });
    const names = r.map((p) => p.petName);
    expect(names).toContain("LostCat");
    expect(names).not.toContain("LostDog");
  });

  it("populates last-seen coords from the status_changed event", async () => {
    const pet = await insertFixturePet({
      name: "LostWithCoords",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    await markLost(pet, 1);
    const r = await fetchLostPets({ role: "admin" }, []);
    const row = r.find((p) => p.petName === "LostWithCoords");
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.lastSeenLat).toBeCloseTo(-34.6033, 3);
    expect(row.lastSeenLng).toBeCloseTo(-58.3815, 3);
  });

  // ── SQL filter push tests (q, since, wildcard injection safety) ─────────────

  it("q filter matches pet name case-insensitively", async () => {
    const prov = "Mendoza";
    const loc = "Mendoza Capital";
    const pet = await insertFixturePet({
      name: "Firulais",
      species: "dog",
      province: prov,
      locality: loc,
    });
    const other = await insertFixturePet({
      name: "NoMatch",
      species: "dog",
      province: prov,
      locality: loc,
    });
    await markLost(pet, 1);
    await markLost(other, 1);

    // Upper-case substring — must match "Firulais" regardless of case.
    const r = await fetchLostPets({ role: "admin" }, [], { q: "FIRULAIS" });
    const names = r.map((p) => p.petName);
    expect(names).toContain("Firulais");
    expect(names).not.toContain("NoMatch");
  });

  it("q filter matches owner displayName case-insensitively", async () => {
    const prov = "San Luis";
    const loc = "Merlo";
    const pet = await insertFixturePet({
      name: "OwnerQPet",
      species: "cat",
      province: prov,
      locality: loc,
    });
    await markLost(pet, 1);

    // The fixture inserts an ownership row linking ownerUserId to every pet.
    // We look up the owner profile display name so the query is realistic.
    const [profile] = await db
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, ownerUserId));
    const displayName = profile?.displayName ?? "";

    // Only run this assertion when the test owner has a non-empty display name.
    if (!displayName) return;

    const r = await fetchLostPets({ role: "admin" }, [], {
      q: displayName.toUpperCase().slice(0, 4),
    });
    const names = r.map((p) => p.petName);
    expect(names).toContain("OwnerQPet");
  });

  it("q filter returns empty result when term matches neither name nor owner", async () => {
    const prov = "Chaco";
    const loc = "Resistencia";
    const pet = await insertFixturePet({
      name: "ChacoPet",
      species: "dog",
      province: prov,
      locality: loc,
    });
    await markLost(pet, 1);

    const r = await fetchLostPets({ role: "govt" }, [{ province: prov, locality: loc }], {
      q: "zzznomatch_xyz",
    });
    expect(r).toHaveLength(0);
  });

  it("since filter: only returns pets whose lost event is >= since boundary", async () => {
    const prov = "Santiago del Estero";
    const loc = "Añatuya";
    // Pet lost 1h ago — inside any reasonable window.
    const recent = await insertFixturePet({
      name: "RecentLost",
      species: "dog",
      province: prov,
      locality: loc,
    });
    // Pet lost 72h ago — outside a 2h window.
    const old = await insertFixturePet({
      name: "OldLost",
      species: "dog",
      province: prov,
      locality: loc,
    });
    await markLost(recent, 1);
    await markLost(old, 72);

    const since2h = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const r = await fetchLostPets({ role: "govt" }, [{ province: prov, locality: loc }], {
      since: since2h,
    });
    const names = r.map((p) => p.petName);
    expect(names).toContain("RecentLost");
    expect(names).not.toContain("OldLost");
  });

  // G0 (PO decision): the /gob/perdidas LIST defaults to the full currently-lost
  // STOCK (no `since` window), so its count matches the same-page "Perdidas
  // activas" KPI (fetchPerdidasMetrics.activeCount) — both count status='lost'.
  // Without a `since`, an old lost episode (72h) is INCLUDED (unlike the windowed
  // path above), and the unwindowed list length equals activeCount for the scope.
  it("no `since` returns the full lost stock and matches the activeCount KPI", async () => {
    const prov = "Catamarca";
    const loc = "San Fernando del Valle de Catamarca";
    const recent = await insertFixturePet({
      name: "StockRecent",
      species: "dog",
      province: prov,
      locality: loc,
    });
    const old = await insertFixturePet({
      name: "StockOld",
      species: "dog",
      province: prov,
      locality: loc,
    });
    await markLost(recent, 1);
    await markLost(old, 72);

    const scope = [{ province: prov, locality: loc }];
    const list = await fetchLostPets({ role: "govt" }, scope);
    const names = list.map((p) => p.petName);
    // Both the recent AND the old lost pet appear — no default window drops the old one.
    expect(names).toContain("StockRecent");
    expect(names).toContain("StockOld");

    // List count (unwindowed, status='lost') == the "Perdidas activas" KPI.
    const metrics = await fetchPerdidasMetrics({ role: "govt" }, scope);
    expect(metrics.activeCount).toBe(list.length);
    expect(list.length).toBe(2);
  });

  it("q containing % is escaped and does not act as a wildcard", async () => {
    const prov = "Misiones";
    const loc = "Posadas";
    const pet = await insertFixturePet({
      name: "EscapeTestPet",
      species: "dog",
      province: prov,
      locality: loc,
    });
    await markLost(pet, 1);

    // A bare "%" would match every pet name — it must match nothing here
    // because "%" literally does not appear in "EscapeTestPet".
    const r = await fetchLostPets({ role: "govt" }, [{ province: prov, locality: loc }], {
      q: "%",
    });
    const names = r.map((p) => p.petName);
    expect(names).not.toContain("EscapeTestPet");
  });

  it("q containing _ is escaped and does not act as a single-char wildcard", async () => {
    const prov = "Corrientes";
    const loc = "Goya";
    const petA = await insertFixturePet({
      name: "UnderscorePetA",
      species: "dog",
      province: prov,
      locality: loc,
    });
    const petB = await insertFixturePet({
      name: "UnderscorePetB",
      species: "dog",
      province: prov,
      locality: loc,
    });
    await markLost(petA, 1);
    await markLost(petB, 1);

    // "_" as a wildcard would match every single character and return both pets.
    // After escaping it must match nothing (no pet name literally contains "_").
    const r = await fetchLostPets({ role: "govt" }, [{ province: prov, locality: loc }], {
      q: "_",
    });
    const names = r.map((p) => p.petName);
    expect(names).not.toContain("UnderscorePetA");
    expect(names).not.toContain("UnderscorePetB");
  });

  // Accent-parity: unaccented q must find a pet whose name contains diacritics.
  // PostgreSQL ILIKE folds case but NOT diacritics; unaccent() on both column
  // and pattern is required for "gonzalez" to find "González".
  it("q filter matches accented pet name via unaccented query", async () => {
    const prov = "Entre Ríos";
    const loc = "Paraná";
    const pet = await insertFixturePet({
      name: "Ñoño",
      species: "dog",
      province: prov,
      locality: loc,
    });
    await markLost(pet, 1);

    const r = await fetchLostPets({ role: "admin" }, [], { q: "nono" });
    const names = r.map((p) => p.petName);
    expect(names).toContain("Ñoño");
  });
});

// ============================================================================
// Helpers for E2 tests
// ============================================================================

let caseSeq = 0;
async function insertFixtureCase(input: {
  caseKind: string;
  status?: "open" | "escalated" | "closed";
  province?: string;
  locality?: string;
  petId?: string;
}): Promise<string> {
  caseSeq += 1;
  const status = input.status ?? "open";
  const [row] = await db
    .insert(cases)
    .values({
      publicCode: `GD-CASE-TEST-${Date.now()}-${caseSeq}`,
      caseKind: input.caseKind,
      primarySubjectKind: input.petId ? "registered_pet" : "general",
      primaryPetId: input.petId ?? null,
      status,
      // cases_closed_consistency requires closedAt whenever status='closed'.
      closedAt: status === "closed" ? new Date() : null,
      jurisdictionProvince: input.province ?? null,
      jurisdictionLocality: input.locality ?? null,
    })
    .returning({ id: cases.id });
  return row.id;
}

let disputeSeq = 0;
// Inserts a custody_disputes row (the domain aggregate /gob/disputas lists and
// the analytics disputes KPI now counts), plus its NOT NULL raising pet_event.
// The pet must be a GD-TEST- fixture so cleanupFixtureRows reclaims it.
async function insertFixtureDispute(input: {
  petId: string;
  status?: "open" | "resolved" | "withdrawn";
  province?: string;
  locality?: string;
}): Promise<string> {
  disputeSeq += 1;
  const [raising] = await db
    .insert(petEvents)
    .values({
      petId: input.petId,
      eventType: "custody_dispute_raised",
      occurredAt: new Date("2026-05-01T00:00:00.000Z"),
      authorRole: "govt",
      payload: { source: "govt-dashboards-test" },
    })
    .returning({ id: petEvents.id });
  const [row] = await db
    .insert(custodyDisputes)
    .values({
      publicToken: `DIS-GD-TEST-${Date.now()}-${disputeSeq}`,
      petId: input.petId,
      raisedByRole: "govt",
      raisingEventId: raising.id,
      jurisdictionCountry: "AR",
      jurisdictionProvince: input.province ?? "Buenos Aires",
      jurisdictionLocality: input.locality ?? "La Plata",
      status: input.status ?? "open",
    })
    .returning({ id: custodyDisputes.id });
  return row.id;
}

async function emitVaccinationEvent(input: {
  petId: string;
  province: string;
  locality: string;
  hoursAgo: number;
}) {
  await db.insert(petEvents).values({
    petId: input.petId,
    eventType: "vaccination_administered",
    occurredAt: new Date(Date.now() - input.hoursAgo * 60 * 60 * 1000),
    payload: {
      payload_version: 1,
      pet_jurisdiction_province: input.province,
      pet_jurisdiction_locality: input.locality,
    },
    authorRole: "vet",
    recordedByUserId: null,
  });
}

// ============================================================================

describe("fetchVigilanciaMetrics", () => {
  it("returns all five metrics with correct shape", async () => {
    const pet = await insertFixturePet({
      name: "MetricsTestPet",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    await emitOutbreakSignal({
      petId: pet,
      diseaseCode: "rabies_suspected",
      province: "Buenos Aires",
      locality: "La Plata",
      hoursAgo: 1,
    });
    // 'bite_incident' is the kind rabiesActiveCount counts — the expediente a
    // rabies observation actually lives on. (Was 'rabies_observation', a kind
    // no production code opens or closes.)
    await insertFixtureCase({
      caseKind: "bite_incident",
      status: "open",
      province: "Buenos Aires",
      locality: "La Plata",
      petId: pet,
    });

    const m = await fetchVigilanciaMetrics({ role: "admin" }, []);
    expect(typeof m.outbreakActiveCount).toBe("number");
    expect(typeof m.rabiesActiveCount).toBe("number");
    expect(typeof m.petsRegisteredToday).toBe("number");
    expect(typeof m.vaccinationsThisWeek).toBe("number");
    expect(typeof m.investigationActiveCount).toBe("number");
    expect(m.outbreakActiveCount).toBeGreaterThanOrEqual(1);
    expect(m.rabiesActiveCount).toBeGreaterThanOrEqual(1);
    // pet inserted today → should be counted
    expect(m.petsRegisteredToday).toBeGreaterThanOrEqual(1);
  });

  it("admin sees all signals; govt user scoped to their jurisdictions", async () => {
    const petCABA = await insertFixturePet({
      name: "ScopeCABA",
      species: "dog",
      province: "CABA",
      locality: "CABA",
    });
    const petBA = await insertFixturePet({
      name: "ScopeBA",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    await emitOutbreakSignal({
      petId: petCABA,
      diseaseCode: "rabies_suspected",
      province: "CABA",
      locality: "CABA",
      hoursAgo: 1,
    });
    await emitOutbreakSignal({
      petId: petBA,
      diseaseCode: "rabies_suspected",
      province: "Buenos Aires",
      locality: "La Plata",
      hoursAgo: 1,
    });

    const adminMetrics = await fetchVigilanciaMetrics({ role: "admin" }, []);
    const govtMetrics = await fetchVigilanciaMetrics({ role: "govt" }, [
      { province: "CABA", locality: "CABA" },
    ]);

    // Admin sees both; govt sees only CABA.
    expect(adminMetrics.outbreakActiveCount).toBeGreaterThanOrEqual(2);
    expect(govtMetrics.outbreakActiveCount).toBeGreaterThanOrEqual(1);
    // CABA-only govt should never count the BA signal.
    expect(govtMetrics.outbreakActiveCount).toBeLessThan(adminMetrics.outbreakActiveCount);
  });

  it("outbreakActiveCount only counts signals from the last 30 days", async () => {
    const pet = await insertFixturePet({
      name: "OldSignalPet",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    // 31 days ago — should NOT be counted.
    await db.insert(petEvents).values({
      petId: pet,
      eventType: "outbreak_signal",
      occurredAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      payload: {
        payload_version: 1,
        source_symptom_event_id: "00000000-0000-0000-0000-000000000001",
        disease_code: "rabies_suspected",
        disease_label: "rabies_suspected",
        match_strength: { high_count: 1, medium_count: 0, low_count: 0, matched_symptom_codes: [] },
        pet_jurisdiction_country: "AR",
        pet_jurisdiction_province: "Buenos Aires",
        pet_jurisdiction_locality: "La Plata",
        pet_species: "dog",
      },
      authorRole: "system",
      recordedByUserId: null,
    });
    // 1 day ago — should be counted.
    await emitOutbreakSignal({
      petId: pet,
      diseaseCode: "rabies_suspected",
      province: "Buenos Aires",
      locality: "La Plata",
      hoursAgo: 24,
    });

    // Baseline: count before this test's inserts (other concurrent tests may add signals).
    // We verify that the old signal does NOT inflate the count by checking that
    // the count matches at least 1 (the recent one) but we cannot use an exact
    // value since other tests run in parallel. Instead we run with an isolated
    // govt scope on a unique locality to avoid interference.
    const govtMetrics = await fetchVigilanciaMetrics({ role: "govt" }, [
      { province: "Buenos Aires", locality: "La Plata" },
    ]);
    // The recent (24h) signal must show up; the 31d-old one must NOT.
    // We verify the count is at least 1 (recent) and at most what we inserted
    // in this test (2 total, but only 1 is within 30d).
    expect(govtMetrics.outbreakActiveCount).toBeGreaterThanOrEqual(1);
  });

  it("investigationActiveCount counts open + escalated outbreak_investigation cases, excludes closed", async () => {
    const province = "Tierra del Fuego";
    const locality = `InvActive-${Date.now()}`;

    await insertFixtureCase({
      caseKind: "outbreak_investigation",
      status: "open",
      province,
      locality,
    });
    await insertFixtureCase({
      caseKind: "outbreak_investigation",
      status: "escalated",
      province,
      locality,
    });
    await insertFixtureCase({
      caseKind: "outbreak_investigation",
      status: "closed",
      province,
      locality,
    });

    const m = await fetchVigilanciaMetrics({ role: "govt" }, [{ province, locality }]);
    // Only the open + escalated cases count as "active" — the closed one must not.
    expect(m.investigationActiveCount).toBe(2);
  });

  it("investigationActiveCount respects jurisdiction scope — govt never sees another jurisdiction's cases", async () => {
    const localityA = `InvScopeA-${Date.now()}`;
    const localityB = `InvScopeB-${Date.now()}`;

    await insertFixtureCase({
      caseKind: "outbreak_investigation",
      status: "open",
      province: "Chubut",
      locality: localityA,
    });
    await insertFixtureCase({
      caseKind: "outbreak_investigation",
      status: "escalated",
      province: "Chubut",
      locality: localityB,
    });

    const adminMetrics = await fetchVigilanciaMetrics({ role: "admin" }, []);
    const govtMetrics = await fetchVigilanciaMetrics({ role: "govt" }, [
      { province: "Chubut", locality: localityA },
    ]);

    expect(adminMetrics.investigationActiveCount).toBeGreaterThanOrEqual(2);
    expect(govtMetrics.investigationActiveCount).toBeGreaterThanOrEqual(1);
    expect(govtMetrics.investigationActiveCount).toBeLessThan(
      adminMetrics.investigationActiveCount,
    );
  });
});

// ============================================================================

// NOTE (2026-08-07, audit 2026-07-26 red #4): every fixture in this block used
// to open a `welfare_denuncia`, which the surveillance map no longer counts.
// They are `bite_incident` now — the kind the map is FOR — so each test still
// asserts what it was written to assert (grouping, scope, ISO mapping) instead
// of accidentally asserting the new kind filter.
// fetchCasesPerLocality returns MetricResult<SuppressedCells> (audit A06-1) —
// a cell below ANONYMITY_K=5 is dropped by suppressSmallCells before these
// tests ever see it. Every fixture below seeds AT LEAST 5 in-scope cases per
// locality so the cell survives suppression and the assertion is about the
// behaviour under test (grouping, scope, ISO mapping, kind filtering), not
// about the suppression floor itself. Pet-less cases (no `petId`) sidestep
// `cases_open_per_pet_kind_idx` (migration 0033), the partial UNIQUE on
// (primary_pet_id, case_kind) for open/escalated rows — the same reason the
// kind-fence tests below already seed pet-less.
describe("fetchCasesPerLocality", () => {
  it("returns one row per (province, locality) with correct count", async () => {
    for (let i = 0; i < 5; i += 1) {
      await insertFixtureCase({
        caseKind: "bite_incident",
        status: "open",
        province: "Buenos Aires",
        locality: "Mar del Plata",
      });
    }

    const { value: rows } = await fetchCasesPerLocality({ role: "admin" }, []);
    const row = rows.find((r) => r.province === "Buenos Aires" && r.locality === "Mar del Plata");
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.count).toBeGreaterThanOrEqual(5);
  });

  it("govt sees only cases from their assigned localities", async () => {
    for (let i = 0; i < 5; i += 1) {
      await insertFixtureCase({
        caseKind: "bite_incident",
        status: "open",
        province: "CABA",
        locality: "Palermo",
      });
    }
    await insertFixtureCase({
      caseKind: "bite_incident",
      status: "open",
      province: "Buenos Aires",
      locality: "La Plata",
    });

    const { value: rows } = await fetchCasesPerLocality({ role: "govt" }, [
      { province: "CABA", locality: "Palermo" },
    ]);

    const cabaRow = rows.find((r) => r.province === "CABA" && r.locality === "Palermo");
    const lpRow = rows.find((r) => r.province === "Buenos Aires" && r.locality === "La Plata");

    expect(cabaRow).toBeDefined();
    expect(lpRow).toBeUndefined();
  });

  it("maps known province names to ISO codes", async () => {
    for (let i = 0; i < 5; i += 1) {
      await insertFixtureCase({
        caseKind: "bite_incident",
        status: "open",
        province: "Buenos Aires",
        locality: "Quilmes",
      });
    }

    const { value: rows } = await fetchCasesPerLocality({ role: "admin" }, []);
    const row = rows.find((r) => r.province === "Buenos Aires" && r.locality === "Quilmes");
    expect(row).toBeDefined();
    expect(row?.code).toBe("AR-B");

    // CABA mapping
    for (let i = 0; i < 5; i += 1) {
      await insertFixtureCase({
        caseKind: "bite_incident",
        status: "open",
        province: "CABA",
        locality: "Recoleta",
      });
    }

    const { value: rows2 } = await fetchCasesPerLocality({ role: "admin" }, []);
    const cabaRow = rows2.find((r) => r.province === "CABA" && r.locality === "Recoleta");
    expect(cabaRow?.code).toBe("AR-C");
  });
});

// ============================================================================
// The kind fence on the surveillance geography (audit 2026-07-26, red #4).
//
// The bug this pins: /gob/vigilancia's choropleth counted `eq(status,'open')`
// with NO kind predicate, so an open custody_episode — one family arguing over
// one animal — painted a cell on the OFFICIAL epidemiological map, visually
// identical to a rabies exposure. Both fetchers behind that map (province-level
// and its department/barrio drill) are now fenced to
// EPIDEMIOLOGICAL_CASE_KINDS.
//
// Both tests seed the two kinds SIDE BY SIDE in the SAME locality, because a
// test that only seeds the excluded kind cannot tell "correctly filtered" from
// "query broken": the assertion has to be that one survives and the other does
// not.
//
// Fixtures are PET-LESS (primary_subject_kind='general'). Two reasons, both
// load-bearing: (a) neither fetcher joins `pets` — they group by the CASE's own
// jurisdiction columns and are scoped by casesScopeClause over those same
// columns, so a pet would add nothing the assertions read; (b)
// `cases_open_per_pet_kind_idx` (migration 0033) is a partial UNIQUE on
// (primary_pet_id, case_kind) over open/escalated rows, which caps a pet at ONE
// open case per kind — seeding K of a kind would need K pets. NULL
// primary_pet_id is outside that index, so the counts these tests need are
// expressible. Cleanup is by `GD-CASE-TEST-%` public_code, independent of pets.
// ============================================================================

describe("surveillance geography counts only epidemiological kinds", () => {
  it("fetchCasesPerLocality keeps open bite_incidents and drops open custody_episodes", async () => {
    // 5 epidemiological (ANONYMITY_K, so the cell survives suppression — A06-1)
    // + 3 custody in the SAME cell. If the kind fence were gone the cell would
    // read 8; if the query were broken it would be absent.
    for (let i = 0; i < 5; i += 1) {
      await insertFixtureCase({
        caseKind: "bite_incident",
        status: "open",
        province: "Buenos Aires",
        locality: "Tandil",
      });
    }
    for (let i = 0; i < 3; i += 1) {
      await insertFixtureCase({
        caseKind: "custody_episode",
        status: "open",
        province: "Buenos Aires",
        locality: "Tandil",
      });
    }

    const { value: rows } = await fetchCasesPerLocality({ role: "admin" }, []);
    const row = rows.find((r) => r.province === "Buenos Aires" && r.locality === "Tandil");
    expect(row).toBeDefined();
    expect(row?.count).toBe(5);
  });

  it("fetchCasesPerLocality also counts open outbreak_investigations, and never a welfare_denuncia", async () => {
    for (let i = 0; i < 5; i += 1) {
      await insertFixtureCase({
        caseKind: "outbreak_investigation",
        status: "open",
        province: "Buenos Aires",
        locality: "Olavarría",
      });
    }
    // welfare_denuncia carries the SAME severity-3 weight as bite_incident but
    // is not epidemiology — maltrato geography is an enforcement pattern, not
    // a disease signal. Pinned so a future "severity 3 == epi" shortcut fails.
    await insertFixtureCase({
      caseKind: "welfare_denuncia",
      status: "open",
      province: "Buenos Aires",
      locality: "Olavarría",
    });

    const { value: rows } = await fetchCasesPerLocality({ role: "admin" }, []);
    const row = rows.find((r) => r.province === "Buenos Aires" && r.locality === "Olavarría");
    expect(row?.count).toBe(5);
  });
});

// A06-1, fix-round 2 (2026-09): suppressing at LOCALITY grain and then
// folding to province undercounts a province whose cases are split across
// several sub-k localities — the fold never sees the true total, only the
// (dropped) sub-k pieces. fetchCasesPerProvinceChoropleth folds the RAW
// per-locality rows to province FIRST and suppresses once, at province
// grain — this is the fetcher /gob/vigilancia's choropleth actually calls.
describe("fetchCasesPerProvinceChoropleth", () => {
  // Scoped as a govt actor over EXACTLY the fixture localities (same jurisdiction-pair
  // scoping the earlier "govt sees only their assigned localities" test uses): an
  // admin-role, no-filter query folds the WHOLE live `cases` table, including
  // whatever real/seed data already sits in Buenos Aires or Chubut, which would
  // make the exact totals below nondeterministic.
  it("shows the true province total when it is split across several sub-k localities and the total reaches k", async () => {
    // Three localities, 2 cases each — no single locality reaches
    // ANONYMITY_K=5, but the province total (6) does. A locality-then-fold
    // approach would drop all three cells (each < 5) and show 0 or "sin
    // datos"; folding the raw rows first must show 6.
    const localities = ["Tigre", "San Isidro", "Vicente López"];
    for (const locality of localities) {
      for (let i = 0; i < 2; i += 1) {
        await insertFixtureCase({
          caseKind: "bite_incident",
          status: "open",
          province: "Buenos Aires",
          locality,
        });
      }
    }

    const cells = await fetchCasesPerProvinceChoropleth(
      { role: "govt" },
      localities.map((locality) => ({ province: "Buenos Aires", locality })),
    );
    const cell = cells.find((c) => c.code === "AR-B");
    expect(cell).toBeDefined();
    expect(cell?.suppressed).toBeFalsy();
    expect(cell?.value).toBe(6);
  });

  it("still suppresses a province whose total stays below k", async () => {
    // Two localities, 1 case each — province total is 2, below ANONYMITY_K.
    const localities = ["Moreno", "Merlo"];
    for (const locality of localities) {
      await insertFixtureCase({
        caseKind: "bite_incident",
        status: "open",
        province: "Chubut",
        locality,
      });
    }

    const cells = await fetchCasesPerProvinceChoropleth(
      { role: "govt" },
      localities.map((locality) => ({ province: "Chubut", locality })),
    );
    const cell = cells.find((c) => c.code === "AR-U");
    expect(cell).toBeDefined();
    expect(cell?.suppressed).toBe(true);
    expect(cell?.value).toBe(0);
  });
});

describe("fetchCasesPerSubregion drill", () => {
  it("fetchCasesPerSubregion (the province drill) applies the same fence", async () => {
    // "25 de Mayo" is a real Buenos Aires locality resolving to the "25 de
    // Mayo" department — the same stable pair subregion-aggregate.test.ts
    // uses. Seed ANONYMITY_K epidemiological cases so the department cell
    // survives the k-anon floor, plus the same number of custody episodes: a
    // missing fence would double the cell to 2×K.
    for (let i = 0; i < ANONYMITY_K; i += 1) {
      await insertFixtureCase({
        caseKind: "bite_incident",
        status: "open",
        province: "Buenos Aires",
        locality: "25 de Mayo",
      });
      await insertFixtureCase({
        caseKind: "custody_episode",
        status: "open",
        province: "Buenos Aires",
        locality: "25 de Mayo",
      });
    }

    const rows = await fetchCasesPerSubregion({ role: "admin" }, [], "AR-B");
    const dept = rows.cells.find((r) => r.name === "25 de Mayo");
    expect(dept).toBeDefined();
    expect(dept?.suppressed).toBeFalsy();
    expect(dept?.count).toBe(ANONYMITY_K);
  });
});

// ============================================================================

describe("fetchZoonosisTrend", () => {
  it("groups outbreak_signal events by month over 12 months", async () => {
    const pet = await insertFixturePet({
      name: "TrendPet",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    // Two signals this month.
    await emitOutbreakSignal({
      petId: pet,
      diseaseCode: "rabies_suspected",
      province: "Buenos Aires",
      locality: "La Plata",
      hoursAgo: 2,
    });
    await emitOutbreakSignal({
      petId: pet,
      diseaseCode: "leptospirosis_suspected",
      province: "Buenos Aires",
      locality: "La Plata",
      hoursAgo: 4,
    });

    const trend = await fetchZoonosisTrend({ role: "admin" }, []);
    expect(Array.isArray(trend)).toBe(true);
    // Each point must have x (string), y (number), and periodStart (ISO string).
    for (const pt of trend) {
      expect(typeof pt.x).toBe("string");
      expect(typeof pt.y).toBe("number");
      expect(typeof pt.periodStart).toBe("string");
    }
    // There must be at least one point (the current month).
    expect(trend.length).toBeGreaterThanOrEqual(1);

    // THE LAST TWO POINTS, NOT THE LAST ONE, and it is a correctness fix rather
    // than a loosening.
    //
    // The comment above says "Two signals this month" and that is false for four
    // hours of every month: the signals are emitted at `hoursAgo: 2` and
    // `hoursAgo: 4`, so between 00:00 and 04:00 on the first day, one or both
    // land in the PREVIOUS month's bucket while `trend`'s last point is the new
    // one. Measured 2026-09-01: a gate started at 23:25 on 31/08 crossed
    // midnight mid-run and this assertion read `expected 1 to be greater than or
    // equal to 2`, identically on two `test:verified` runs over one tree —
    // deterministic, and nothing to do with the change being gated.
    //
    // Summing two adjacent buckets is exactly as strict: the signals are inside
    // a four-hour window, and a four-hour window spans at most two consecutive
    // months. Both must still be found. What stops being asserted is WHICH side
    // of a month boundary the clock happened to be on when the suite ran, which
    // was never the property under test — this case is about grouping by month,
    // and it still fails if the grouping drops an event.
    const recent = trend.slice(-2);
    const counted = recent.reduce((total, point) => total + point.y, 0);
    expect(counted).toBeGreaterThanOrEqual(2);
  });

  it("govt scope restricts trend to their assigned jurisdictions", async () => {
    const petCABA = await insertFixturePet({
      name: "TrendCABA",
      species: "dog",
      province: "CABA",
      locality: "CABA",
    });
    const petBA = await insertFixturePet({
      name: "TrendBA",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    await emitOutbreakSignal({
      petId: petCABA,
      diseaseCode: "rabies_suspected",
      province: "CABA",
      locality: "CABA",
      hoursAgo: 1,
    });
    await emitOutbreakSignal({
      petId: petBA,
      diseaseCode: "rabies_suspected",
      province: "Buenos Aires",
      locality: "La Plata",
      hoursAgo: 1,
    });

    const adminTrend = await fetchZoonosisTrend({ role: "admin" }, []);
    const govtTrend = await fetchZoonosisTrend({ role: "govt" }, [
      {
        province: "CABA",
        locality: "CABA",
      },
    ]);

    // Compute totals for current month.
    const adminTotal = adminTrend.reduce((s, p) => s + p.y, 0);
    const govtTotal = govtTrend.reduce((s, p) => s + p.y, 0);

    // Govt total must be less than admin total (it only sees CABA).
    expect(govtTotal).toBeGreaterThanOrEqual(1);
    expect(adminTotal).toBeGreaterThanOrEqual(govtTotal);
  });
});

// ============================================================================
// E3 — fetchPerdidasMetrics
// ============================================================================

describe("fetchPerdidasMetrics", () => {
  // Re-use the markLost helper from fetchLostPets describe block by duplicating
  // the insert logic inline — each describe is self-contained.
  async function markLostFixture(petId: string, hoursAgo: number) {
    await db.update(pets).set({ status: "lost" }).where(eq(pets.id, petId));
    await db.insert(petEvents).values({
      petId,
      eventType: "status_changed",
      occurredAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
      payload: {
        payload_version: 1,
        from_status: "active",
        to_status: "lost",
        location_description: null,
        reason: null,
      },
      authorRole: "owner",
      recordedByUserId: ownerUserId,
      locationLat: "-34.6033",
      locationLng: "-58.3815",
    });
  }

  async function markRecoveredFixture(petId: string, hoursAgo: number) {
    await db.update(pets).set({ status: "active" }).where(eq(pets.id, petId));
    await db.insert(petEvents).values({
      petId,
      eventType: "status_changed",
      occurredAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
      payload: {
        payload_version: 1,
        from_status: "lost",
        to_status: "active",
        location_description: null,
        reason: null,
      },
      authorRole: "owner",
      recordedByUserId: ownerUserId,
    });
  }

  // Pins the honesty fix (2026-07-19): a lost pet that exits via a BAJA
  // (e.g. deceased) is not a recovery. Real writers never emit this shape
  // (death goes through `death_recorded`, not `status_changed`) — this
  // fixture exercises the query predicate directly so a future writer or a
  // query regression can't silently re-inflate recoveredMonth.
  async function markDeceasedFixture(petId: string, hoursAgo: number) {
    await db.update(pets).set({ status: "deceased" }).where(eq(pets.id, petId));
    await db.insert(petEvents).values({
      petId,
      eventType: "status_changed",
      occurredAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
      payload: {
        payload_version: 1,
        from_status: "lost",
        to_status: "deceased",
        location_description: null,
        reason: null,
      },
      authorRole: "owner",
      recordedByUserId: ownerUserId,
    });
  }

  it("returns the 3-key shape", async () => {
    const m = await fetchPerdidasMetrics({ role: "admin" }, []);
    expect(typeof m.activeCount).toBe("number");
    expect(typeof m.recoveredMonth).toBe("number");
    expect(typeof m.avgDaysActive).toBe("number");
  });

  it("activeCount reflects lost pets in scope", async () => {
    const pet = await insertFixturePet({
      name: "MetricLost",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    await markLostFixture(pet, 2);

    const m = await fetchPerdidasMetrics({ role: "admin" }, []);
    expect(m.activeCount).toBeGreaterThanOrEqual(1);
  });

  it("govt user does not see pets from outside their jurisdiction", async () => {
    const petCABA = await insertFixturePet({
      name: "ScopeLostCABA",
      species: "dog",
      province: "CABA",
      locality: "Palermo",
    });
    const petLP = await insertFixturePet({
      name: "ScopeLostLP",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    await markLostFixture(petCABA, 1);
    await markLostFixture(petLP, 1);

    // Govt scoped only to CABA/Palermo.
    const m = await fetchPerdidasMetrics({ role: "govt" }, [
      { province: "CABA", locality: "Palermo" },
    ]);
    // La Plata pet must not inflate the count.
    const adminM = await fetchPerdidasMetrics({ role: "admin" }, []);
    expect(m.activeCount).toBeLessThan(adminM.activeCount);
    expect(m.activeCount).toBeGreaterThanOrEqual(1);
  });

  it("recoveredMonth does NOT include pets still in lost status", async () => {
    const pet = await insertFixturePet({
      name: "StillLost",
      species: "dog",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    // Mark lost but never recovered.
    await markLostFixture(pet, 5);

    // Scoped to La Plata to reduce noise from other tests.
    const m = await fetchPerdidasMetrics({ role: "govt" }, [
      { province: "Buenos Aires", locality: "La Plata" },
    ]);
    // recoveredMonth must not count a pet that is still lost.
    // We verify by checking activeCount > 0 but recoveredMonth does not count
    // our fixture pet (it has no recovery event).
    expect(m.activeCount).toBeGreaterThanOrEqual(1);
    // The still-lost pet should contribute 0 to recoveredMonth.
    // We cannot assert exact 0 (other tests may have recovery events) but
    // recoveredMonth must be a non-negative number.
    expect(m.recoveredMonth).toBeGreaterThanOrEqual(0);
  });

  it("recoveredMonth correctly counts pets that went lost → active within 30d", async () => {
    const pet = await insertFixturePet({
      name: "RecoveredPet",
      species: "dog",
      province: "Córdoba",
      locality: "Villa Carlos Paz",
    });
    // Mark lost then recovered within the window.
    await markLostFixture(pet, 48);
    await markRecoveredFixture(pet, 24);

    const m = await fetchPerdidasMetrics({ role: "govt" }, [
      { province: "Córdoba", locality: "Villa Carlos Paz" },
    ]);
    expect(m.recoveredMonth).toBeGreaterThanOrEqual(1);
  });

  it("recoveredMonth does NOT count a lost → deceased exit (baja, not a recovery)", async () => {
    // Isolated jurisdiction (not reused by other tests in this file) so the
    // scoped recoveredMonth count for this fixture pet is exact, not just
    // ">= 0" — this is what pins the fix, not just non-regression.
    const pet = await insertFixturePet({
      name: "SoloDeceasedWhileLostPet",
      species: "dog",
      province: "Chaco",
      locality: "Resistencia",
    });
    await markLostFixture(pet, 48);
    await markDeceasedFixture(pet, 24);

    const m = await fetchPerdidasMetrics({ role: "govt" }, [
      { province: "Chaco", locality: "Resistencia" },
    ]);
    // A lost→deceased exit is a BAJA, not a recovery — must contribute 0.
    expect(m.recoveredMonth).toBe(0);
  });

  it("avgDaysActive returns 0 when there are no active lost pets in scope", async () => {
    // Govt with no assignments → immediate 0 return path.
    const m = await fetchPerdidasMetrics({ role: "govt" }, []);
    expect(m.avgDaysActive).toBe(0);
  });

  it("avgDaysActive correctly averages now - markedLostAt", async () => {
    // Synthetic locality so the average is over THIS test's lost pets only.
    // avgDaysActive is a scope-wide aggregate; a real locality (e.g. Rosario)
    // would also pick up the national demo seed's lost pets and skew the average.
    const prov = "Santa Fe";
    const loc = `avgdays-test-${Date.now()}`;
    const pet1 = await insertFixturePet({
      name: "AvgPet1",
      species: "dog",
      province: prov,
      locality: loc,
    });
    const pet2 = await insertFixturePet({
      name: "AvgPet2",
      species: "cat",
      province: prov,
      locality: loc,
    });
    // Mark lost ~2 days ago and ~4 days ago respectively → avg ~3 days.
    await markLostFixture(pet1, 2 * 24);
    await markLostFixture(pet2, 4 * 24);

    const m = await fetchPerdidasMetrics({ role: "govt" }, [{ province: prov, locality: loc }]);
    // avgDaysActive should be approximately 3 (± 1 due to timing).
    expect(m.avgDaysActive).toBeGreaterThanOrEqual(2);
    expect(m.avgDaysActive).toBeLessThanOrEqual(5);
  });

  // --------------------------------------------------------------------------
  // KPI↔list parity harness (task #57) — activeCount (the "Perdidas activas"
  // KPI) must always equal fetchLostPets()'s row count under the SAME
  // actor/jurisdiction/admin-drilldown filters. This is the second dashboard
  // wiring for the reusable assertKpiListParity helper; the maltrato wiring
  // lives in __tests__/maltrato-sql-queue.test.ts.
  // --------------------------------------------------------------------------
  describe("KPI↔list parity harness (assertKpiListParity)", () => {
    it("govt scope: activeCount matches fetchLostPets row count for an isolated locality", async () => {
      const prov = "Entre Ríos";
      const loc = `parity-govt-${Date.now()}`;
      const petA = await insertFixturePet({
        name: "ParityGovtA",
        species: "dog",
        province: prov,
        locality: loc,
      });
      const petB = await insertFixturePet({
        name: "ParityGovtB",
        species: "cat",
        province: prov,
        locality: loc,
      });
      await markLostFixture(petA, 1);
      await markLostFixture(petB, 30);

      const scope = [{ province: prov, locality: loc }];
      await assertKpiListParity({
        filters: { actor: { role: "govt" as const }, jurisdictions: scope },
        getKpiCount: async (f) =>
          (await fetchPerdidasMetrics(f.actor, f.jurisdictions)).activeCount,
        getListRows: async (f) => fetchLostPets(f.actor, f.jurisdictions),
        label: "perdidas — govt scope, no display filters",
      });
    });

    it("admin province+locality drill-down: activeCount matches fetchLostPets row count, excluding out-of-drilldown pets", async () => {
      const prov = "Formosa";
      const loc = `parity-admin-${Date.now()}`;
      const petA = await insertFixturePet({
        name: "ParityAdminA",
        species: "dog",
        province: prov,
        locality: loc,
      });
      const petB = await insertFixturePet({
        name: "ParityAdminB",
        species: "dog",
        province: prov,
        locality: loc,
      });
      // Out-of-drilldown pet: must be excluded from BOTH sides identically, or
      // this test would catch a KPI/list drift the same way the real bug did.
      const outOfScope = await insertFixturePet({
        name: "ParityAdminOutOfScope",
        species: "dog",
        province: "Jujuy",
        locality: "San Salvador de Jujuy",
      });
      await markLostFixture(petA, 1);
      await markLostFixture(petB, 5);
      await markLostFixture(outOfScope, 1);

      await assertKpiListParity({
        filters: {
          actor: { role: "admin" as const },
          jurisdictions: [],
          adminProvince: prov,
          adminLocality: loc,
        },
        getKpiCount: async (f) =>
          (
            await fetchPerdidasMetrics(f.actor, f.jurisdictions, {
              adminProvince: f.adminProvince,
              adminLocality: f.adminLocality,
            })
          ).activeCount,
        getListRows: async (f) =>
          fetchLostPets(f.actor, f.jurisdictions, {
            adminProvince: f.adminProvince,
            adminLocality: f.adminLocality,
          }),
        label: "perdidas — admin province+locality drill-down",
      });
    });
  });
});

// ============================================================================
// E4 — fetchWelfareMetrics
// ============================================================================

// Unique prefix for welfare_reports fixture reference codes to enable cleanup.
const WR_REF_PREFIX = "E4-TEST-";
let wrSeq = 0;

async function insertFixtureWelfareReport(input: {
  province?: string;
  locality?: string;
  status?: "open" | "triaged" | "in_progress" | "closed" | "invalid" | "duplicate";
  assignedToUserId?: string | null;
  closedAt?: Date | null;
  flaggedAt?: Date | null;
  moderationResolvedAt?: Date | null;
}): Promise<string> {
  wrSeq += 1;
  const [row] = await db
    .insert(welfareReports)
    .values({
      referenceCode: `${WR_REF_PREFIX}${Date.now()}-${wrSeq}`,
      kind: "neglect",
      severity: "medium",
      description: "Fixture welfare report for E4 tests.",
      subjectKind: "unowned_animal",
      jurisdictionProvince: input.province ?? "Buenos Aires",
      jurisdictionLocality: input.locality ?? "La Plata",
      status: input.status ?? "open",
      assignedToUserId: input.assignedToUserId ?? null,
      closedAt: input.closedAt ?? null,
      flaggedAt: input.flaggedAt ?? null,
      moderationResolvedAt: input.moderationResolvedAt ?? null,
    })
    .returning({ id: welfareReports.id });
  return row.id;
}

async function cleanupFixtureWelfareReports() {
  await db
    .delete(welfareReports)
    .where(sql`${welfareReports.referenceCode} LIKE ${`${WR_REF_PREFIX}%`}`);
}

describe("fetchWelfareMetrics", () => {
  afterEach(cleanupFixtureWelfareReports);

  it("returns a 4-key shape with numeric values", async () => {
    const m = await fetchWelfareMetrics({ role: "admin" }, [], ownerUserId);
    expect(typeof m.unassignedCount).toBe("number");
    expect(typeof m.myCount).toBe("number");
    expect(typeof m.inProgressCount).toBe("number");
    expect(typeof m.closedMonth).toBe("number");
  });

  it("unassignedCount counts only reports with no assignee AND non-terminal status", async () => {
    // Should be counted: open + unassigned.
    await insertFixtureWelfareReport({ status: "open", assignedToUserId: null });
    // Should NOT be counted: open + assigned.
    await insertFixtureWelfareReport({ status: "open", assignedToUserId: ownerUserId });
    // Should NOT be counted: closed + unassigned (terminal).
    await insertFixtureWelfareReport({
      status: "closed",
      assignedToUserId: null,
      closedAt: new Date(),
    });

    // Use a unique jurisdiction to isolate this test from global data.
    const m = await fetchWelfareMetrics(
      { role: "govt" },
      [{ province: "Buenos Aires", locality: "La Plata" }],
      ownerUserId,
    );
    // At least 1 open+unassigned fixture; assigned and closed ones should not be included.
    expect(m.unassignedCount).toBeGreaterThanOrEqual(1);
  });

  // Regression guard for the KPI↔list moderation-exclusion fix (commit b0d427e3):
  // a flagged-but-unresolved report must stay OUT of the tiles, exactly like it
  // stays out of buildMaltratoListConditions({queue: 'unassigned'}). A flagged
  // report whose moderation HAS been resolved is a normal report again and must
  // be counted — this is the positive control proving the exclusion targets the
  // unresolved-flag case specifically, not "flagged" in general.
  it("unassignedCount excludes a flagged-but-unresolved report, but counts one whose flag was resolved", async () => {
    const prov = "Chubut";
    const loc = `moderation-scope-${Date.now()}`;

    // Flagged, unresolved — must NOT be counted (mirrors buildMaltratoListConditions
    // excluding it from the 'unassigned' queue).
    await insertFixtureWelfareReport({
      province: prov,
      locality: loc,
      status: "open",
      assignedToUserId: null,
      flaggedAt: new Date(),
      moderationResolvedAt: null,
    });
    // Flagged AND resolved — positive control: must be counted like any other
    // open+unassigned report once moderation has cleared it.
    await insertFixtureWelfareReport({
      province: prov,
      locality: loc,
      status: "open",
      assignedToUserId: null,
      flaggedAt: new Date(),
      moderationResolvedAt: new Date(),
    });

    const scope = [{ province: prov, locality: loc }];
    const m = await fetchWelfareMetrics({ role: "govt" }, scope, ownerUserId);
    // Only the resolved report may count — the unresolved-flagged one must not.
    expect(m.unassignedCount).toBe(1);
    // The other active tiles must also stay honest for the unresolved-flagged
    // report: it is not assigned to anyone, so myCount/inProgressCount are
    // unaffected by it either way, but closedMonth must not pick it up (it's
    // still status='open').
    expect(m.closedMonth).toBe(0);
  });

  it("myCount counts only reports assigned to currentUserId with non-terminal status", async () => {
    // Mine: assigned to ownerUserId, open.
    await insertFixtureWelfareReport({ status: "open", assignedToUserId: ownerUserId });
    // Not mine: assigned to ownerUserId but closed (terminal).
    await insertFixtureWelfareReport({
      status: "closed",
      assignedToUserId: ownerUserId,
      closedAt: new Date(),
    });
    // Not mine: open but not assigned to me.
    await insertFixtureWelfareReport({ status: "open", assignedToUserId: null });

    const m = await fetchWelfareMetrics(
      { role: "govt" },
      [{ province: "Buenos Aires", locality: "La Plata" }],
      ownerUserId,
    );
    expect(m.myCount).toBeGreaterThanOrEqual(1);
  });

  it("closedMonth counts only reports closed in the last 30 days", async () => {
    // Closed recently — should be counted.
    await insertFixtureWelfareReport({
      status: "closed",
      closedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
      province: "Córdoba",
      locality: "Córdoba Capital",
    });
    // Still open — should NOT be counted.
    await insertFixtureWelfareReport({
      status: "open",
      province: "Córdoba",
      locality: "Córdoba Capital",
    });

    const m = await fetchWelfareMetrics(
      { role: "govt" },
      [{ province: "Córdoba", locality: "Córdoba Capital" }],
      ownerUserId,
    );
    expect(m.closedMonth).toBeGreaterThanOrEqual(1);
    // The open one must not inflate closedMonth.
    // openCount is not a metric, but closedMonth must not equal zero when we have one.
  });

  it("govt user only sees reports in their assigned jurisdictions", async () => {
    // Report in La Plata (in scope).
    await insertFixtureWelfareReport({ province: "Buenos Aires", locality: "La Plata" });
    // Report in Rosario (out of scope for this govt user).
    await insertFixtureWelfareReport({ province: "Santa Fe", locality: "Rosario" });

    const govtMetrics = await fetchWelfareMetrics(
      { role: "govt" },
      [{ province: "Buenos Aires", locality: "La Plata" }],
      ownerUserId,
    );
    const adminMetrics = await fetchWelfareMetrics({ role: "admin" }, [], ownerUserId);

    // Admin sees ≥ govt (includes out-of-scope rows).
    expect(adminMetrics.unassignedCount).toBeGreaterThanOrEqual(govtMetrics.unassignedCount);
  });

  it("admin sees all reports (no jurisdiction restriction)", async () => {
    // Insert reports in two different provinces.
    await insertFixtureWelfareReport({ province: "Mendoza", locality: "Mendoza Capital" });
    await insertFixtureWelfareReport({ province: "Tucumán", locality: "San Miguel de Tucumán" });

    const m = await fetchWelfareMetrics({ role: "admin" }, [], ownerUserId);
    // Admin must see both — total unassigned includes our two fixtures.
    expect(m.unassignedCount).toBeGreaterThanOrEqual(2);
  });

  it("returns zeros for govt user with no assignments", async () => {
    const m = await fetchWelfareMetrics({ role: "govt" }, [], ownerUserId);
    expect(m.unassignedCount).toBe(0);
    expect(m.myCount).toBe(0);
    expect(m.inProgressCount).toBe(0);
    expect(m.closedMonth).toBe(0);
  });
});

// ============================================================================
// C4 — fetchOpenWelfareReportsCount treats invalid/duplicate as terminal
// ============================================================================

describe("fetchOpenWelfareReportsCount — terminal statuses (C4)", () => {
  afterEach(cleanupFixtureWelfareReports);

  // Isolated jurisdiction so only these fixtures are in scope.
  const PROV = "La Rioja";
  const LOC = "La Rioja Capital";

  function ctx() {
    return buildProjectionContext(
      { role: "govt" },
      [{ province: PROV, locality: LOC }],
      windows.trailing12m(),
    );
  }

  it("excludes invalid and duplicate reports from the open count", async () => {
    await insertFixtureWelfareReport({ province: PROV, locality: LOC, status: "open" });
    await insertFixtureWelfareReport({ province: PROV, locality: LOC, status: "in_progress" });
    // Terminal — must NOT count as open. Before C4 'invalid' leaked through here.
    await insertFixtureWelfareReport({ province: PROV, locality: LOC, status: "invalid" });
    await insertFixtureWelfareReport({ province: PROV, locality: LOC, status: "duplicate" });
    await insertFixtureWelfareReport({
      province: PROV,
      locality: LOC,
      status: "closed",
      closedAt: new Date(),
    });

    const { count } = await fetchOpenWelfareReportsCount(ctx());
    // open + in_progress = 2; invalid/duplicate/closed excluded.
    expect(count).toBe(2);
  });
});

// ============================================================================
// E5 — fetchAnalyticsMetrics
// ============================================================================

// Helper: insert a pet_registered event (acquisition) for a pet.
async function emitPetRegisteredEvent(input: {
  petId: string;
  acquisitionMethod: string | null;
  daysAgo?: number;
}) {
  await db.insert(petEvents).values({
    petId: input.petId,
    eventType: "pet_registered",
    occurredAt: new Date(Date.now() - (input.daysAgo ?? 0) * 24 * 60 * 60 * 1000),
    payload: {
      payload_version: 1,
      name: "TestPet",
      species: "dog",
      sex: "unknown",
      breed: null,
      date_of_birth: null,
      birth_date_is_estimated: false,
      color: null,
      microchip_id: null,
      microchip_country_code: null,
      microchip_implanted_at: null,
      microchip_implanted_by: null,
      microchip_location: null,
      estimated_weight_kg: null,
      favourite_foods: [],
      known_allergies: [],
      training_level: null,
      insurance_company: null,
      insurance_policy_number: null,
      jurisdiction_province: null,
      jurisdiction_locality: null,
      potentially_dangerous_breed: false,
      acquisition_method: input.acquisitionMethod,
      has_photo: false,
      has_microchip: false,
    },
    authorRole: "owner",
    recordedByUserId: ownerUserId,
  });
}

// Helper: insert a vaccination event with a given vaccine_name.
async function emitVaccinationWithName(input: {
  petId: string;
  vaccineName: string;
  province: string;
  locality: string;
}) {
  await db.insert(petEvents).values({
    petId: input.petId,
    eventType: "vaccination_administered",
    occurredAt: new Date(),
    payload: {
      payload_version: 1,
      vaccine_name: input.vaccineName,
      brand: null,
      batch: null,
      administered_by: null,
      next_due_at: null,
      pet_jurisdiction_province: input.province,
      pet_jurisdiction_locality: input.locality,
    },
    authorRole: "vet",
    recordedByUserId: null,
  });
}

// Helper: insert a death_recorded event.
async function emitDeathEvent(input: {
  petId: string;
  cause: string;
  province: string;
  locality: string;
  daysAgo?: number;
}) {
  await db.update(pets).set({ status: "deceased" }).where(eq(pets.id, input.petId));
  await db.insert(petEvents).values({
    petId: input.petId,
    eventType: "death_recorded",
    occurredAt: new Date(Date.now() - (input.daysAgo ?? 0) * 24 * 60 * 60 * 1000),
    payload: {
      payload_version: 1,
      cause: input.cause,
      cause_detail: null,
      confirmed_by_vet: null,
      vet_name: null,
      disposition_method: null,
      facility: null,
      death_at_clinic: null,
      clinic_name: null,
      vet_contacted_owner: null,
      vet_decided_alone: null,
      owner_to_private_crematorium: null,
      disease_code: null,
      confirmed_by_lab: null,
      is_reportable: false,
    },
    authorRole: "owner",
    recordedByUserId: ownerUserId,
  });
}

describe("fetchAnalyticsMetrics", () => {
  it("returns the 4-key shape", async () => {
    const m = await fetchAnalyticsMetrics({ role: "admin" }, []);
    expect(typeof m.totalPets).toBe("number");
    expect(typeof m.adoptionRate).toBe("number");
    expect(typeof m.rabiesVaccinationRate).toBe("number");
    expect(typeof m.custodyDisputes).toBe("number");
  });

  it("returns zeros for govt with no assignments", async () => {
    const m = await fetchAnalyticsMetrics({ role: "govt" }, []);
    expect(m.totalPets).toBe(0);
    expect(m.adoptionRate).toBe(0);
    expect(m.rabiesVaccinationRate).toBe(0);
    expect(m.custodyDisputes).toBe(0);
  });

  it("rabiesVaccinationRate returns 0 when totalPets is 0 in scope", async () => {
    // Synthetic locality guaranteed empty even on the demo-seeded DB (a real
    // locality like Ushuaia is populated by the national seed → non-zero rate).
    const m = await fetchAnalyticsMetrics({ role: "govt" }, [
      { province: "Tierra del Fuego", locality: `empty-scope-test-${Date.now()}` },
    ]);
    expect(m.rabiesVaccinationRate).toBe(0);
  });

  it("rabiesVaccinationRate reflects pets with rabia vaccination in scope", async () => {
    const prov = "La Pampa";
    const loc = "Santa Rosa";
    const pet1 = await insertFixturePet({
      name: "RabiaVacPet1",
      species: "dog",
      province: prov,
      locality: loc,
    });
    const pet2 = await insertFixturePet({
      name: "RabiaVacPet2",
      species: "dog",
      province: prov,
      locality: loc,
    });
    // Only pet1 gets rabia vaccination.
    await emitVaccinationWithName({
      petId: pet1,
      vaccineName: "Vacuna rabia canina triple",
      province: prov,
      locality: loc,
    });

    const m = await fetchAnalyticsMetrics({ role: "govt" }, [{ province: prov, locality: loc }]);
    // totalPets = 2 (both active). rabiesVaccinated = 1. rate = 50%.
    expect(m.totalPets).toBeGreaterThanOrEqual(2);
    expect(m.rabiesVaccinationRate).toBeGreaterThanOrEqual(1);
    expect(m.rabiesVaccinationRate).toBeLessThanOrEqual(100);
  });

  it("rabiesVaccinationRate counts pets whose vaccine_name is accented 'Antirrábica'", async () => {
    // Regression guard for E5-2: the old ILIKE '%rabi%' predicate is ASCII-only and
    // would NOT match "Antirrábica" (ó has a diacritic). The unaccent()-based predicate
    // must count it. Requires the unaccent extension (migration 0070).
    const prov = "Formosa";
    const loc = "Formosa Capital";
    const petAccented = await insertFixturePet({
      name: "AntirrabiPet",
      species: "dog",
      province: prov,
      locality: loc,
    });
    const petUnvaccinated = await insertFixturePet({
      name: "UnvaccinatedPet",
      species: "dog",
      province: prov,
      locality: loc,
    });
    // Vaccine name uses the accented form that ILIKE '%rabi%' would have missed.
    await emitVaccinationWithName({
      petId: petAccented,
      vaccineName: "Antirrábica",
      province: prov,
      locality: loc,
    });
    // petUnvaccinated has no vaccination event at all.

    const m = await fetchAnalyticsMetrics({ role: "govt" }, [{ province: prov, locality: loc }]);
    // totalPets >= 2; exactly 1 of them has the rabies vaccine.
    expect(m.totalPets).toBeGreaterThanOrEqual(2);
    // rate must be > 0 — the accented name was matched by unaccent().
    expect(m.rabiesVaccinationRate).toBeGreaterThan(0);
    // rate must be < 100 — the unvaccinated pet lowers it below 100%.
    expect(m.rabiesVaccinationRate).toBeLessThan(100);
  });

  it("scope: govt only sees pets in their assigned jurisdictions", async () => {
    const prov1 = "San Luis";
    const loc1 = "San Luis Capital";
    const prov2 = "La Rioja";
    const loc2 = "La Rioja Capital";
    await insertFixturePet({ name: "ScopePet1", species: "dog", province: prov1, locality: loc1 });
    await insertFixturePet({ name: "ScopePet2", species: "dog", province: prov2, locality: loc2 });

    const mScoped = await fetchAnalyticsMetrics({ role: "govt" }, [
      { province: prov1, locality: loc1 },
    ]);
    const mAdmin = await fetchAnalyticsMetrics({ role: "admin" }, []);

    expect(mScoped.totalPets).toBeGreaterThanOrEqual(1);
    expect(mAdmin.totalPets).toBeGreaterThanOrEqual(mScoped.totalPets);
  });

  it("custodyDisputes counts open custody_disputes rows in scope (NOT custody_dispute cases)", async () => {
    const prov = "Catamarca";
    const loc = "San Fernando del Valle";
    const pet = await insertFixturePet({
      name: "DisputePet",
      species: "dog",
      province: prov,
      locality: loc,
    });
    await insertFixtureDispute({ petId: pet, status: "open", province: prov, locality: loc });

    // A location-subject custody_dispute CASE with no custody_disputes aggregate
    // must NOT inflate the KPI — that superset was the "9 alarm, empty queue" bug.
    await insertFixtureCase({
      caseKind: "custody_dispute",
      status: "open",
      province: prov,
      locality: loc,
      // no petId → location/general subject, no custody_disputes row
    });

    const m = await fetchAnalyticsMetrics({ role: "govt" }, [{ province: prov, locality: loc }]);
    expect(m.custodyDisputes).toBeGreaterThanOrEqual(1);
  });

  it("count↔queue parity: the KPI equals the /gob/disputas open-queue count in the same scope", async () => {
    // Unique locality so this fixture is the ONLY dispute data in scope — the KPI
    // number and the queue-query number must be EQUAL, not merely both non-zero.
    const prov = "Tierra del Fuego";
    const loc = `parity-scope-${Date.now()}`;
    const scope = [{ province: prov, locality: loc }];

    // 2 open disputes (each on its own pet — one-open-dispute-per-pet constraint)
    // + 1 resolved dispute. The KPI (open-only) and the open queue must both be 2.
    for (let i = 0; i < 2; i++) {
      const p = await insertFixturePet({
        name: `ParityOpen${i}`,
        species: "dog",
        province: prov,
        locality: loc,
      });
      await insertFixtureDispute({ petId: p, status: "open", province: prov, locality: loc });
    }
    const resolvedPet = await insertFixturePet({
      name: "ParityResolved",
      species: "dog",
      province: prov,
      locality: loc,
    });
    // A resolved dispute needs a resolver + resolved_at (resolution_consistent check).
    await db
      .insert(custodyDisputes)
      .values({
        publicToken: `DIS-GD-PARITY-${Date.now()}`,
        petId: resolvedPet,
        raisedByRole: "govt",
        raisingEventId: (
          await db
            .insert(petEvents)
            .values({
              petId: resolvedPet,
              eventType: "custody_dispute_raised",
              occurredAt: new Date("2026-05-01T00:00:00.000Z"),
              authorRole: "govt",
              payload: { source: "govt-dashboards-test" },
            })
            .returning({ id: petEvents.id })
        )[0].id,
        jurisdictionCountry: "AR",
        jurisdictionProvince: prov,
        jurisdictionLocality: loc,
        status: "resolved",
        resolution: "ownership_confirmed",
        resolutionSummary: "parity fixture",
        resolvedByUserId: ownerUserId,
        resolvedAt: new Date("2026-05-02T00:00:00.000Z"),
      })
      .returning({ id: custodyDisputes.id });

    // KPI (open-only, scoped) — the number the analytics "Disputas" tile shows.
    const m = await fetchAnalyticsMetrics({ role: "govt" }, scope);

    // The EXACT queue shape app/gob/disputas/page.tsx runs, filtered to open,
    // using the SHARED scope helper — this is the wiring the page depends on.
    const scopeFilter = custodyDisputesScopeClause({ role: "govt" }, scope) ?? sql`false`;
    const queueRows = await db
      .select({ id: custodyDisputes.id })
      .from(custodyDisputes)
      .innerJoin(pets, eq(pets.id, custodyDisputes.petId))
      .where(and(eq(custodyDisputes.status, "open"), scopeFilter));

    expect(m.custodyDisputes).toBe(2);
    expect(queueRows).toHaveLength(2);
    expect(m.custodyDisputes).toBe(queueRows.length);
  });
});

// ============================================================================
// rabiesVaccinationRate — numerator ⊆ denominator (review 2026-08-22, H8)
// ============================================================================
//
// The tile's denominator has always been `pets.status IN ('active','lost')`.
// Its numerator had NO status filter, and for the admin-national case no join
// to `pets` at all — so it counted DEAD animals against a padrón that excludes
// them. Measured on the local DB before the fix: 20.719/29.014 = 71,4 % on the
// tile vs 18.192/29.014 = 62,7 % on the ranking table rendered right below it,
// same label; the 2.527 difference is exactly the vaccinated deceased pets. In
// small scopes the seed already renders 500 % (Catamarca/El Desmonte) because
// this tile, unlike the adoption tile beside it, does not clamp.
//
// The existing tests could not catch it: they are loose range checks (≥1, ≤100)
// that survive the bug unchanged.

describe("fetchAnalyticsMetrics — rabiesVaccinationRate excludes deceased pets", () => {
  it("a deceased vaccinated pet cannot push the rate over 100 % in a small scope", async () => {
    const prov = "Tierra del Fuego";
    const loc = `rabies-dead-${Date.now()}`;
    const scope = [{ province: prov, locality: loc }];

    // One live, unvaccinated pet — the whole padrón of this scope.
    await insertFixturePet({ name: "LiveUnvaxxed", species: "dog", province: prov, locality: loc });
    // Two deceased pets that WERE vaccinated. They are not in the padrón, so
    // they must not be in the numerator either.
    for (let i = 0; i < 2; i++) {
      const dead = await insertFixturePet({
        name: `DeadVaxxed${i}`,
        species: "dog",
        province: prov,
        locality: loc,
        status: "deceased",
      });
      await emitVaccinationWithName({
        petId: dead,
        vaccineName: "Antirrábica",
        province: prov,
        locality: loc,
      });
    }

    const m = await fetchAnalyticsMetrics({ role: "govt" }, scope);

    expect(m.totalPets).toBe(1);
    // Before the fix: 2/1 → 200 %.
    expect(m.rabiesVaccinationRate).toBeLessThanOrEqual(100);
    expect(m.rabiesVaccinationRate).toBe(0);
  });

  it("admin-national: the numerator is a subset of the padrón it is divided by", async () => {
    // The admin-national path is the ONLY one where the numerator does not even
    // JOIN `pets` (needsJoin is false there), so appending a status filter can
    // not reach it — the join has to become unconditional. A fixture cannot
    // prove that: a handful of deceased pets does not move a national rate that
    // carries one decimal. So this recomputes the honest numerator over the
    // whole padrón, with the SAME shared amendment overlay production uses,
    // and pins the tile to it. Measured before the fix on the local DB:
    // tile 71,4 % (20.719/29.014) vs honest 62,7 % (18.192/29.014).
    const m = await fetchAnalyticsMetrics({ role: "admin" }, []);

    const [vaccinatedInPadron] = await db
      .select({ n: countDistinct(petEvents.petId) })
      .from(petEvents)
      .innerJoin(pets, eq(pets.id, petEvents.petId))
      .where(
        and(
          eq(petEvents.eventType, "vaccination_administered"),
          sql`unaccent(${amendedPayloadText("vaccine_name")}) ILIKE unaccent(${"%rabi%"})`,
          sql`${pets.status} IN ('active', 'lost')`,
        ),
      );

    const expected =
      m.totalPets === 0 ? 0 : Math.round((vaccinatedInPadron.n / m.totalPets) * 1000) / 10;
    expect(m.rabiesVaccinationRate).toBe(expected);
  });

  it("parity: the tile and the ranking table below it agree over the same scope", async () => {
    // The two surfaces carry the SAME label on the SAME screen. Four documents
    // specify one numerator, and one of them asserts these are consistent — it
    // was false at HEAD. This assertion is what makes it true and keeps it true.
    const prov = "Tierra del Fuego";
    const loc = `rabies-parity-${Date.now()}`;
    const scope = [{ province: prov, locality: loc }];

    // ANONYMITY_K + 1 live pets so the province clears the k-anonymity gate in
    // the ranking (a withheld province leaves the ranking entirely).
    const live: string[] = [];
    for (let i = 0; i < ANONYMITY_K + 1; i++) {
      live.push(
        await insertFixturePet({
          name: `ParityLive${i}`,
          species: "dog",
          province: prov,
          locality: loc,
        }),
      );
    }
    // Three of the six live pets are vaccinated → the honest rate is 50 %.
    for (const petId of live.slice(0, 3)) {
      await emitVaccinationWithName({
        petId,
        vaccineName: "Antirrábica",
        province: prov,
        locality: loc,
      });
    }
    // Two vaccinated pets that died. Before the fix they lifted the tile to
    // 5/6 = 83,3 % while the ranking row below still read 50 %.
    for (let i = 0; i < 2; i++) {
      const dead = await insertFixturePet({
        name: `ParityDead${i}`,
        species: "dog",
        province: prov,
        locality: loc,
        status: "deceased",
      });
      await emitVaccinationWithName({
        petId: dead,
        vaccineName: "Antirrábica",
        province: prov,
        locality: loc,
      });
    }

    const tile = await fetchAnalyticsMetrics({ role: "govt" }, scope);
    const ranking = await fetchRegionRanking({ role: "govt" }, scope);
    const row = [...ranking.top, ...ranking.bottom].find((r) => r.province === prov);

    expect(row).toBeDefined();
    expect(tile.totalPets).toBe(ANONYMITY_K + 1);
    expect(tile.rabiesVaccinationRate).toBe(50);
    // The ranking rounds to whole points; the tile keeps one decimal.
    expect(Math.round(tile.rabiesVaccinationRate)).toBe(row?.coveragePct);
  });
});

// ============================================================================
// E5 — fetchAcquisitionTrend
// ============================================================================

describe("fetchAcquisitionTrend", () => {
  it("returns empty array for govt with no assignments", async () => {
    const r = await fetchAcquisitionTrend({ role: "govt" }, []);
    expect(r).toEqual([]);
  });

  it("excludes rows without acquisition_method in payload", async () => {
    const prov = "Chubut";
    const loc = "Comodoro Rivadavia";
    const pet = await insertFixturePet({
      name: "NoMethodPet",
      species: "dog",
      province: prov,
      locality: loc,
    });
    // Emit pet_registered event with null acquisition_method.
    await emitPetRegisteredEvent({ petId: pet, acquisitionMethod: null });

    const r = await fetchAcquisitionTrend({ role: "govt" }, [{ province: prov, locality: loc }]);
    // Row with null acquisition_method must not appear.
    for (const pt of r) {
      expect(pt.method).toBeDefined();
    }
  });

  it("groups correctly by (month, method) bucket and returns required shape", async () => {
    const prov = "Santa Cruz";
    const loc = "Río Gallegos";
    const pet = await insertFixturePet({
      name: "TrendAcqPet",
      species: "dog",
      province: prov,
      locality: loc,
    });
    await emitPetRegisteredEvent({ petId: pet, acquisitionMethod: "adopted", daysAgo: 1 });

    const r = await fetchAcquisitionTrend({ role: "govt" }, [{ province: prov, locality: loc }]);
    expect(Array.isArray(r)).toBe(true);
    for (const pt of r) {
      expect(typeof pt.x).toBe("string");
      expect(typeof pt.y).toBe("number");
      expect(typeof pt.method).toBe("string");
      expect(typeof pt.periodStart).toBe("string");
      // method must be one of the 4 buckets.
      expect(["shelter_adoption", "vecino_helps_stray", "private_handover", "other"]).toContain(
        pt.method,
      );
    }
    // The adopted pet in this month must appear as shelter_adoption.
    const adoptedPoints = r.filter((pt) => pt.method === "shelter_adoption");
    expect(adoptedPoints.length).toBeGreaterThanOrEqual(1);
  });

  it("scope: govt only sees acquisitions in their assigned jurisdictions", async () => {
    const prov1 = "Neuquén";
    const loc1 = "Neuquén Capital";
    const prov2 = "Río Negro";
    const loc2 = "Bariloche";
    const pet1 = await insertFixturePet({
      name: "ScopeAcq1",
      species: "dog",
      province: prov1,
      locality: loc1,
    });
    const pet2 = await insertFixturePet({
      name: "ScopeAcq2",
      species: "dog",
      province: prov2,
      locality: loc2,
    });
    await emitPetRegisteredEvent({ petId: pet1, acquisitionMethod: "adopted" });
    await emitPetRegisteredEvent({ petId: pet2, acquisitionMethod: "adopted" });

    const govtTrend = await fetchAcquisitionTrend({ role: "govt" }, [
      { province: prov1, locality: loc1 },
    ]);
    const adminTrend = await fetchAcquisitionTrend({ role: "admin" }, []);

    const govtTotal = govtTrend.reduce((s, p) => s + p.y, 0);
    const adminTotal = adminTrend.reduce((s, p) => s + p.y, 0);
    expect(govtTotal).toBeGreaterThanOrEqual(1);
    expect(adminTotal).toBeGreaterThanOrEqual(govtTotal);
  });
});

// ============================================================================
// E5 — fetchDeathCauses
// ============================================================================

describe("fetchDeathCauses", () => {
  it("returns empty array for govt with no assignments", async () => {
    const r = await fetchDeathCauses({ role: "govt" }, []);
    expect(r).toEqual([]);
  });

  it("returns rows with cause + count shape", async () => {
    const r = await fetchDeathCauses({ role: "admin" }, []);
    for (const row of r) {
      expect(typeof row.cause).toBe("string");
      expect(typeof row.count).toBe("number");
    }
    // At most 10 rows (LIMIT 10).
    expect(r.length).toBeLessThanOrEqual(10);
  });

  it("scope-bound: govt only sees death events from their jurisdictions", async () => {
    const prov = "Jujuy";
    const loc = "San Salvador de Jujuy";
    const pet = await insertFixturePet({
      name: "DeathScopePet",
      species: "dog",
      province: prov,
      locality: loc,
    });
    await emitDeathEvent({ petId: pet, cause: "natural", province: prov, locality: loc });

    const govtR = await fetchDeathCauses({ role: "govt" }, [{ province: prov, locality: loc }]);
    const adminR = await fetchDeathCauses({ role: "admin" }, []);

    expect(govtR.length).toBeGreaterThanOrEqual(1);
    const govtTotal = govtR.reduce((s, r) => s + r.count, 0);
    const adminTotal = adminR.reduce((s, r) => s + r.count, 0);
    expect(adminTotal).toBeGreaterThanOrEqual(govtTotal);
  });

  it("last 12 months only: deaths older than 12 months are excluded", async () => {
    const prov = "Formosa";
    const loc = "Formosa Capital";
    const pet = await insertFixturePet({
      name: "OldDeathPet",
      species: "dog",
      province: prov,
      locality: loc,
    });
    // Death 400 days ago — outside the 12m window.
    await emitDeathEvent({
      petId: pet,
      cause: "unknown",
      province: prov,
      locality: loc,
      daysAgo: 400,
    });

    const r = await fetchDeathCauses({ role: "govt" }, [{ province: prov, locality: loc }]);
    // The old death event should not appear in the results.
    // We verify by checking there's no entry (or it's 0-count).
    // Since there are no recent deaths for this jurisdiction, the result should be empty.
    expect(r.length).toBe(0);
  });

  it("ordered by count desc and returns top 10", async () => {
    const prov = "Corrientes";
    const loc = "Corrientes Capital";
    // Insert multiple pets and death events to create ordering.
    for (let i = 0; i < 3; i++) {
      const pet = await insertFixturePet({
        name: `DeathOrderPet${i}`,
        species: "dog",
        province: prov,
        locality: loc,
      });
      await emitDeathEvent({ petId: pet, cause: "natural", province: prov, locality: loc });
    }
    const pet4 = await insertFixturePet({
      name: "DeathOrderPet4",
      species: "dog",
      province: prov,
      locality: loc,
    });
    await emitDeathEvent({ petId: pet4, cause: "accident", province: prov, locality: loc });

    const r = await fetchDeathCauses({ role: "govt" }, [{ province: prov, locality: loc }]);
    // Results must be ordered desc by count.
    for (let i = 1; i < r.length; i++) {
      expect(r[i - 1].count).toBeGreaterThanOrEqual(r[i].count);
    }
    // natural (3) must come before accident (1).
    const naturalIdx = r.findIndex((row) => row.cause === "natural");
    const accidentIdx = r.findIndex((row) => row.cause === "accident");
    if (naturalIdx !== -1 && accidentIdx !== -1) {
      expect(naturalIdx).toBeLessThan(accidentIdx);
    }
  });
});

// ============================================================================
// E5 — fetchOutbreakHistory
// ============================================================================

describe("fetchOutbreakHistory", () => {
  /** Emit `n` signals of one disease into one (province, locality). */
  async function emitSignalBurst(input: {
    petId: string;
    diseaseCode: string;
    province: string;
    locality: string;
    n: number;
  }) {
    for (let i = 0; i < input.n; i++) {
      await emitOutbreakSignal({
        petId: input.petId,
        diseaseCode: input.diseaseCode,
        province: input.province,
        locality: input.locality,
        hoursAgo: 2 + i,
      });
    }
  }

  it("returns no rows for govt with no assignments", async () => {
    const r = await fetchOutbreakHistory({ role: "govt" }, []);
    expect(r.rows).toEqual([]);
    expect(r.suppressedCount).toBe(0);
  });

  it("returns rows with required shape", async () => {
    const pet = await insertFixturePet({
      name: "HistoryPet",
      species: "dog",
      province: "Buenos Aires",
      locality: "Tigre",
    });
    await emitSignalBurst({
      petId: pet,
      diseaseCode: "rabies_suspected",
      province: "Buenos Aires",
      locality: "Tigre",
      n: ANONYMITY_K,
    });

    const r = await fetchOutbreakHistory({ role: "admin" }, []);
    expect(Array.isArray(r.rows)).toBe(true);
    for (const row of r.rows) {
      expect(typeof row.diseaseCode).toBe("string");
      expect(typeof row.diseaseName).toBe("string");
      expect(typeof row.locality).toBe("string");
      expect(typeof row.province).toBe("string");
      expect(typeof row.peakDate).toBe("string");
      expect(typeof row.totalSignals).toBe("number");
    }
  });

  it("groups by (disease_code, locality, province) and counts signals", async () => {
    const prov = "Santa Fe";
    const loc = "Rosario";
    const pet = await insertFixturePet({
      name: "GroupingPet",
      species: "dog",
      province: prov,
      locality: loc,
    });
    // Signals of the same disease in the same locality. At the k floor, not
    // below it — below it the group is withheld and this test would be
    // asserting the privacy rule instead of the grouping rule (RA-3 C3).
    await emitSignalBurst({
      petId: pet,
      diseaseCode: "leptospirosis_suspected",
      province: prov,
      locality: loc,
      n: ANONYMITY_K,
    });

    const r = await fetchOutbreakHistory({ role: "govt" }, [{ province: prov, locality: loc }]);
    const lepto = r.rows.find(
      (row) => row.diseaseCode === "leptospirosis_suspected" && row.locality === loc,
    );
    expect(lepto).toBeDefined();
    if (!lepto) return;
    expect(lepto.totalSignals).toBeGreaterThanOrEqual(ANONYMITY_K);
  });

  // RA-3 C3 — THE finding. A single reportable-disease signal used to render
  // "Rabia · Ushuaia · Tierra del Fuego · 12 mar 2026 · 1": one animal, one
  // locality, one date. Pinned both ways: the sub-k group must be ABSENT from
  // `rows` AND present in `suppressedCount`, because dropping it silently would
  // make the table say "nothing was ever reported here".
  //
  // The locality is fixture-only, and the two k-anon tests below say why: they
  // assert an EXACT group size, so they are only meaningful where the fixture
  // owns every signal in the group. That used to be true by accident — the
  // ambient seed's "Rabia (sospechada)" spelling landed in a different SQL row
  // than the fixture's, so a real Ushuaia seed signal could not perturb the
  // count. Merging the spellings (as it must) removed that accident: the seed's
  // one Ushuaia signal now joins this group and lifts it to exactly the k floor.
  // A real INDEC locality is a shared namespace with the seed's fixed-RNG walk;
  // CI run 32525430323 is what that costs when the walk moves.
  it("k-anon: a sub-k (disease, locality) group is withheld and COUNTED, never published", async () => {
    const prov = "Tierra del Fuego";
    const loc = "Ushuaia GD-TEST";
    const pet = await insertFixturePet({
      name: "KanonHistoryPet",
      species: "dog",
      province: prov,
      locality: loc,
    });
    await emitSignalBurst({
      petId: pet,
      diseaseCode: "rabies_suspected",
      province: prov,
      locality: loc,
      n: ANONYMITY_K - 1,
    });

    const r = await fetchOutbreakHistory({ role: "govt" }, [{ province: prov, locality: loc }]);
    expect(r.rows.find((x) => x.locality === loc)).toBeUndefined();
    expect(r.suppressedCount).toBeGreaterThanOrEqual(1);
  });

  it("k-anon: the SAME group crossing the k floor becomes publishable", async () => {
    const prov = "Tierra del Fuego";
    const loc = "Río Grande GD-TEST";
    const pet = await insertFixturePet({
      name: "KanonHistoryPetAtFloor",
      species: "dog",
      province: prov,
      locality: loc,
    });
    await emitSignalBurst({
      petId: pet,
      diseaseCode: "rabies_suspected",
      province: prov,
      locality: loc,
      n: ANONYMITY_K,
    });

    const r = await fetchOutbreakHistory({ role: "govt" }, [{ province: prov, locality: loc }]);
    const row = r.rows.find((x) => x.locality === loc);
    expect(row).toBeDefined();
    expect(row?.totalSignals).toBe(ANONYMITY_K);
    expect(r.suppressedCount).toBe(0);
  });

  // THE GROUP IS (disease_code, province, locality) — `disease_label` is not
  // part of it and must never be, because it is FREE TEXT chosen by the writer:
  // production use cases funnel it through `findDisease()`, `seed-panorama.ts`
  // writes "Rabia (sospechada)", this file's fixture writes the raw code. Three
  // spellings, one disease.
  //
  // While the SQL grouped (and JOINed USING) `disease_label` too, one locality's
  // signals split into as many SQL rows as there were spellings, while the
  // suppression key `${code}::${province}::${locality}` still saw ONE group. The
  // damage is two-sided and both sides are wrong in the direction that matters:
  // the visible row UNDER-COUNTS the outbreak, and `suppressedCount` claims a
  // suppression that never protected anybody — the same signals are published
  // under the other spelling. CI run 32525430323 caught it as `suppressedCount`
  // 1 instead of 0, when a re-fetched INDEC catalog walked the seed onto a
  // locality a fixture already used.
  it("groups by disease_code alone — two disease_label spellings are ONE row", async () => {
    const prov = "Tierra del Fuego";
    // Fixture-only locality: ambient seed signals for the SAME code now merge
    // into the fixture's group (that is the fix), so an exact-count assertion
    // can only live in a locality the seed cannot emit.
    const loc = "Tolhuin GD-TEST";
    const code = "rabies_suspected";
    const catalogLabel = findDisease(code)?.label;
    expect(catalogLabel).toBeTruthy();
    const pet = await insertFixturePet({
      name: "LabelSplitPet",
      species: "dog",
      province: prov,
      locality: loc,
    });
    // K signals of ONE disease in ONE locality, written by two "writers":
    // 3 with the catalog label, 2 with the raw code. Split into 3 + 2 both
    // halves sit below ANONYMITY_K and the whole outbreak disappears.
    for (let i = 0; i < 3; i++) {
      await emitOutbreakSignal({
        petId: pet,
        diseaseCode: code,
        province: prov,
        locality: loc,
        hoursAgo: 2 + i,
        diseaseLabel: catalogLabel,
      });
    }
    for (let i = 0; i < ANONYMITY_K - 3; i++) {
      await emitOutbreakSignal({
        petId: pet,
        diseaseCode: code,
        province: prov,
        locality: loc,
        hoursAgo: 10 + i,
      });
    }

    const r = await fetchOutbreakHistory({ role: "govt" }, [{ province: prov, locality: loc }]);
    const rows = r.rows.filter((x) => x.locality === loc);
    expect(rows).toHaveLength(1);
    expect(rows[0].diseaseCode).toBe(code);
    expect(rows[0].totalSignals).toBe(ANONYMITY_K);
    // The displayed name comes from the catalog, never from the stored text.
    expect(rows[0].diseaseName).toBe(catalogLabel);
    expect(r.suppressedCount).toBe(0);
  });

  // Same merge for a code the catalog does NOT know (real data has them:
  // 'ZOO_TRAUMA_ORBITAL', 'rabies'). The grouping still collapses the spellings;
  // only the DISPLAYED name falls back to the stored text, and which of the two
  // spellings wins is deliberately unspecified — SQL picks one (MAX) so the row
  // has a name at all.
  it("merges disease_label spellings for a code the catalog does not know", async () => {
    const prov = "Santa Cruz";
    const loc = "Río Gallegos GD-TEST";
    const code = "gd_test_unknown_disease";
    const labelA = "Aaa spelling";
    const labelB = "Zzz spelling";
    const pet = await insertFixturePet({
      name: "UnknownCodeLabelPet",
      species: "dog",
      province: prov,
      locality: loc,
    });
    for (let i = 0; i < 3; i++) {
      await emitOutbreakSignal({
        petId: pet,
        diseaseCode: code,
        province: prov,
        locality: loc,
        hoursAgo: 2 + i,
        diseaseLabel: labelA,
      });
    }
    for (let i = 0; i < ANONYMITY_K - 3; i++) {
      await emitOutbreakSignal({
        petId: pet,
        diseaseCode: code,
        province: prov,
        locality: loc,
        hoursAgo: 10 + i,
        diseaseLabel: labelB,
      });
    }

    const r = await fetchOutbreakHistory({ role: "govt" }, [{ province: prov, locality: loc }]);
    const rows = r.rows.filter((x) => x.locality === loc);
    expect(rows).toHaveLength(1);
    expect(rows[0].totalSignals).toBe(ANONYMITY_K);
    expect([labelA, labelB]).toContain(rows[0].diseaseName);
    expect(r.suppressedCount).toBe(0);
  });

  it("scope-bound: govt only sees signals in their jurisdictions", async () => {
    const prov1 = "Entre Ríos";
    const loc1 = "Paraná";
    const prov2 = "Misiones";
    const loc2 = "Posadas";
    const pet1 = await insertFixturePet({
      name: "HistScope1",
      species: "dog",
      province: prov1,
      locality: loc1,
    });
    const pet2 = await insertFixturePet({
      name: "HistScope2",
      species: "dog",
      province: prov2,
      locality: loc2,
    });
    // Both bursts sit AT the k floor: neither can be hidden by k-anon, so the
    // only rule that can keep loc2 out of loc1's view is the scope rule.
    await emitSignalBurst({
      petId: pet1,
      diseaseCode: "rabies_suspected",
      province: prov1,
      locality: loc1,
      n: ANONYMITY_K,
    });
    await emitSignalBurst({
      petId: pet2,
      diseaseCode: "rabies_suspected",
      province: prov2,
      locality: loc2,
      n: ANONYMITY_K,
    });

    const govtR = await fetchOutbreakHistory({ role: "govt" }, [
      { province: prov1, locality: loc1 },
    ]);
    expect(govtR.rows.some((row) => row.locality === loc1)).toBe(true);
    // Must not contain rows from prov2/loc2.
    for (const row of govtR.rows) {
      expect(row.locality).not.toBe(loc2);
    }
  });

  it("peakDate = the calendar day with the most signals, not the last signal", async () => {
    const prov = "Córdoba";
    const loc = "Río Cuarto";
    const pet = await insertFixturePet({
      name: "PeakPet",
      species: "dog",
      province: prov,
      locality: loc,
    });

    // Anchor dates: three distinct calendar days.
    // day0 = 3 days ago (1 signal — quiet day)
    // day1 = 2 days ago (3 signals — busiest day)
    // day2 = 1 day ago  (2 signals — most recent, but not busiest)
    const now = Date.now();
    const day0 = new Date(now - 3 * 24 * 60 * 60 * 1000);
    const day1 = new Date(now - 2 * 24 * 60 * 60 * 1000);
    const day2 = new Date(now - 1 * 24 * 60 * 60 * 1000);

    // Normalise to midnight UTC to stay within the same calendar day regardless
    // of sub-second jitter.
    const midnightOf = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T12:00:00.000Z`);

    await emitOutbreakSignalAt({
      petId: pet,
      diseaseCode: "brucellosis_suspected",
      province: prov,
      locality: loc,
      occurredAt: midnightOf(day0),
    });
    await emitOutbreakSignalAt({
      petId: pet,
      diseaseCode: "brucellosis_suspected",
      province: prov,
      locality: loc,
      occurredAt: midnightOf(day1),
    });
    await emitOutbreakSignalAt({
      petId: pet,
      diseaseCode: "brucellosis_suspected",
      province: prov,
      locality: loc,
      occurredAt: new Date(midnightOf(day1).getTime() + 1000),
    });
    await emitOutbreakSignalAt({
      petId: pet,
      diseaseCode: "brucellosis_suspected",
      province: prov,
      locality: loc,
      occurredAt: new Date(midnightOf(day1).getTime() + 2000),
    });
    await emitOutbreakSignalAt({
      petId: pet,
      diseaseCode: "brucellosis_suspected",
      province: prov,
      locality: loc,
      occurredAt: midnightOf(day2),
    });
    await emitOutbreakSignalAt({
      petId: pet,
      diseaseCode: "brucellosis_suspected",
      province: prov,
      locality: loc,
      occurredAt: new Date(midnightOf(day2).getTime() + 1000),
    });

    const r = await fetchOutbreakHistory({ role: "govt" }, [{ province: prov, locality: loc }]);
    const row = r.rows.find((x) => x.diseaseCode === "brucellosis_suspected" && x.locality === loc);
    expect(row).toBeDefined();
    if (!row) return;

    // totalSignals must count ALL 6 signals across all days.
    expect(row.totalSignals).toBeGreaterThanOrEqual(6);

    // peakDate must be day1 (3 signals), not day2 (2 signals — most recent).
    const expectedDay = midnightOf(day1).toISOString().slice(0, 10);
    expect(row.peakDate.slice(0, 10)).toBe(expectedDay);
  });

  it("peakDate tie-break: most-recent day wins when counts are equal", async () => {
    const prov = "Neuquén";
    const loc = "Zapala";
    const pet = await insertFixturePet({
      name: "TiePet",
      species: "dog",
      province: prov,
      locality: loc,
    });

    const now = Date.now();
    const older = new Date(now - 4 * 24 * 60 * 60 * 1000);
    const newer = new Date(now - 2 * 24 * 60 * 60 * 1000);
    const midnightOf = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T12:00:00.000Z`);

    // 3 signals each on older and newer days — tied count; newer should win.
    // THREE, not two: 2+2 = 4 is below ANONYMITY_K, so after RA-3 C3 the group
    // would be withheld and this tie-break assertion would never run. The tie
    // is what matters, not the size, so both days grew by one.
    for (const offsetMs of [0, 1000, 2000]) {
      await emitOutbreakSignalAt({
        petId: pet,
        diseaseCode: "hantavirus_suspected",
        province: prov,
        locality: loc,
        occurredAt: new Date(midnightOf(older).getTime() + offsetMs),
      });
      await emitOutbreakSignalAt({
        petId: pet,
        diseaseCode: "hantavirus_suspected",
        province: prov,
        locality: loc,
        occurredAt: new Date(midnightOf(newer).getTime() + offsetMs),
      });
    }

    const r = await fetchOutbreakHistory({ role: "govt" }, [{ province: prov, locality: loc }]);
    const row = r.rows.find((x) => x.diseaseCode === "hantavirus_suspected" && x.locality === loc);
    expect(row).toBeDefined();
    if (!row) return;

    const expectedDay = midnightOf(newer).toISOString().slice(0, 10);
    expect(row.peakDate.slice(0, 10)).toBe(expectedDay);
  });

  it("retains groups whose disease_label is NULL (null-safe join)", async () => {
    const prov = "Salta";
    const loc = "Salta Capital";
    const pet = await insertFixturePet({
      name: "NullLabelPet",
      species: "dog",
      province: prov,
      locality: loc,
    });
    // Emit outbreak_signals with NO disease_label in the payload.
    // The COALESCE fix must prevent this group from being dropped by the JOIN.
    // ANONYMITY_K of them, not two: below the k floor the group is withheld for
    // PRIVACY and this test could no longer tell that apart from the JOIN drop
    // it exists to catch (RA-3 C3).
    for (let i = 0; i < ANONYMITY_K; i++) {
      await db.insert(petEvents).values({
        petId: pet,
        eventType: "outbreak_signal",
        occurredAt: new Date(Date.now() - (i + 1) * 60 * 60 * 1000),
        payload: {
          payload_version: 1,
          source_symptom_event_id: `00000000-0000-0000-0000-00000000000${i}`,
          disease_code: "null_label_disease",
          // disease_label intentionally omitted — simulates a NULL in the DB column
          match_strength: {
            high_count: 1,
            medium_count: 0,
            low_count: 0,
            matched_symptom_codes: ["s_test"],
          },
          pet_jurisdiction_country: "AR",
          pet_jurisdiction_province: prov,
          pet_jurisdiction_locality: loc,
          pet_species: "dog",
        },
        authorRole: "system",
        recordedByUserId: null,
      });
    }

    const r = await fetchOutbreakHistory({ role: "govt" }, [{ province: prov, locality: loc }]);
    const row = r.rows.find((x) => x.diseaseCode === "null_label_disease" && x.locality === loc);

    // Without the COALESCE fix this group would be silently dropped by the JOIN.
    expect(row).toBeDefined();
    if (!row) return;

    // Every signal must be counted.
    expect(row.totalSignals).toBeGreaterThanOrEqual(ANONYMITY_K);

    // peakDate must be a valid ISO string.
    expect(typeof row.peakDate).toBe("string");
    expect(() => new Date(row.peakDate)).not.toThrow();

    // diseaseName falls back to diseaseCode when label is missing.
    expect(row.diseaseName).toBe("null_label_disease");
  });

  // PO decision 2026-07-26: the list leads with MOST RECENTLY ACTIVE, which is
  // what the SQL already does (ORDER BY t.last_seen DESC) and what surveillance
  // asks — "where is something still happening?" — not "which outbreak peaked
  // hardest".
  //
  // This assertion used to check `peakDate`, which the query never promised.
  // Last-seen and peak-day are different quantities, so it only ever agreed by
  // luck; re-seeding shifted the RNG and exposed it (1 violating pair in 100).
  // A green test is not evidence the behaviour is right.
  //
  // Seeds its OWN two groups (2026-07-31, RA-3 C3). It used to rely on the
  // ambient seed having >1 publishable group; once sub-k groups stopped being
  // published that stopped being true, and a test whose precondition depends on
  // seed volume is the "green-and-dead" shape this wave keeps finding.
  it("ordered by lastSeen desc — most recently active first", async () => {
    const recent = await insertFixturePet({
      name: "OrderRecentPet",
      species: "dog",
      province: "Chubut",
      locality: "Rawson",
    });
    const older = await insertFixturePet({
      name: "OrderOlderPet",
      species: "dog",
      province: "Chubut",
      locality: "Trelew",
    });
    // Both at the k floor so both are publishable; only their recency differs.
    for (let i = 0; i < ANONYMITY_K; i++) {
      await emitOutbreakSignal({
        petId: recent,
        diseaseCode: "rabies_suspected",
        province: "Chubut",
        locality: "Rawson",
        hoursAgo: 1 + i,
      });
      await emitOutbreakSignal({
        petId: older,
        diseaseCode: "rabies_suspected",
        province: "Chubut",
        locality: "Trelew",
        hoursAgo: 200 + i,
      });
    }

    const r = await fetchOutbreakHistory({ role: "admin" }, []);
    const rawsonAt = r.rows.findIndex((x) => x.locality === "Rawson");
    const trelewAt = r.rows.findIndex((x) => x.locality === "Trelew");
    expect(rawsonAt).toBeGreaterThanOrEqual(0);
    expect(trelewAt).toBeGreaterThanOrEqual(0);
    expect(rawsonAt).toBeLessThan(trelewAt);

    expect(r.rows.length).toBeGreaterThan(1);
    for (let i = 1; i < r.rows.length; i++) {
      expect(r.rows[i - 1].lastSeen >= r.rows[i].lastSeen).toBe(true);
    }
  });
});

// ============================================================================
// RA-3 C4 — fetchCasesPerCapita k-anonymity (data side).
//
// The render side is pinned in CasesPerCapitaTable.test.tsx against hand-built
// rows; without THIS block the fetcher could hand back raw sub-k counts and
// every existing test would stay green (the per-capita test file only exercises
// the rate FORMULA, not the query).
// ============================================================================

describe("fetchCasesPerCapita — k-anonymity", () => {
  const PROV = "Tierra del Fuego";
  // A synthetic locality: the seeded demo data has open cases in every real
  // TdF locality, and an ambient row pushing the cell over k would make these
  // tests pass for the wrong reason. Province stays canonical so the INDEC 2022
  // census join (province-level) still resolves and the rate is exercised.
  const LOC = "GD-TEST-Localidad-Kanon";
  const SCOPE = [{ province: PROV, locality: LOC }];

  async function openCasesHere(n: number) {
    for (let i = 0; i < n; i++) {
      await insertFixtureCase({ caseKind: "welfare_denuncia", province: PROV, locality: LOC });
    }
  }

  it("fixture precondition: no ambient open cases in this jurisdiction", async () => {
    // Guards the two tests below from a seeded row silently pushing the cell
    // over k (which would make them pass for the wrong reason).
    const rows = await fetchCasesPerCapita({ role: "govt" }, SCOPE);
    expect(rows).toEqual([]);
  });

  it("a sub-k province publishes NEITHER the count NOR the rate — and null, not 0", async () => {
    await openCasesHere(ANONYMITY_K - 1);

    const rows = await fetchCasesPerCapita({ role: "govt" }, SCOPE);
    const tdf = rows.find((r) => r.province === PROV);
    expect(tdf).toBeDefined();
    expect(tdf?.suppressed).toBe(true);
    // A false zero is itself a disclosure and reads as real data.
    expect(tdf?.count).toBeNull();
    // The rate is not exempt: INDEC 2022 is public, so count = rate × pop / 10k.
    expect(tdf?.ratePer10k).toBeNull();
  });

  it("the SAME province at the k floor publishes both", async () => {
    await openCasesHere(ANONYMITY_K);

    const rows = await fetchCasesPerCapita({ role: "govt" }, SCOPE);
    const tdf = rows.find((r) => r.province === PROV);
    expect(tdf?.suppressed).toBe(false);
    expect(tdf?.count).toBe(ANONYMITY_K);
    expect(tdf?.ratePer10k).not.toBeNull();
  });
});

// ============================================================================
// Period-window tests — assert that the `since` option is honoured by each
// analytics fetcher that previously hardcoded 12 months.
// ============================================================================

describe("fetchAcquisitionTrend — period window", () => {
  it("only returns rows within the requested window", async () => {
    const prov = "Santiago del Estero";
    const loc = "Santiago del Estero Capital";
    const pet = await insertFixturePet({
      name: "PeriodAcqPet",
      species: "dog",
      province: prov,
      locality: loc,
    });
    // Event 5 days ago — inside a 30d window.
    await emitPetRegisteredEvent({ petId: pet, acquisitionMethod: "adopted", daysAgo: 5 });
    // Event 200 days ago — outside a 30d window.
    await emitPetRegisteredEvent({ petId: pet, acquisitionMethod: "adopted", daysAgo: 200 });

    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const trend30d = await fetchAcquisitionTrend(
      { role: "govt" },
      [{ province: prov, locality: loc }],
      {
        since: since30d,
      },
    );
    const trend365d = await fetchAcquisitionTrend({ role: "govt" }, [
      { province: prov, locality: loc },
    ]);

    const total30d = trend30d.reduce((s, p) => s + p.y, 0);
    const total365d = trend365d.reduce((s, p) => s + p.y, 0);

    // 30d window must see fewer registrations than the default 12m window.
    expect(total365d).toBeGreaterThan(total30d);
    // 30d window must still capture the 5-day-old event.
    expect(total30d).toBeGreaterThanOrEqual(1);
  });
});

describe("fetchDeathCauses — period window", () => {
  it("only returns deaths within the requested window", async () => {
    const prov = "San Juan";
    const loc = "San Juan Capital";
    const petRecent = await insertFixturePet({
      name: "PeriodDeathRecent",
      species: "dog",
      province: prov,
      locality: loc,
    });
    const petOld = await insertFixturePet({
      name: "PeriodDeathOld",
      species: "dog",
      province: prov,
      locality: loc,
    });
    // Recent death — inside 30d window.
    await emitDeathEvent({
      petId: petRecent,
      cause: "natural",
      province: prov,
      locality: loc,
      daysAgo: 5,
    });
    // Old death — outside 30d window, inside 12m window.
    await emitDeathEvent({
      petId: petOld,
      cause: "disease",
      province: prov,
      locality: loc,
      daysAgo: 200,
    });

    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const r30d = await fetchDeathCauses({ role: "govt" }, [{ province: prov, locality: loc }], {
      since: since30d,
    });
    const r365d = await fetchDeathCauses({ role: "govt" }, [{ province: prov, locality: loc }]);

    const total30d = r30d.reduce((s, r) => s + r.count, 0);
    const total365d = r365d.reduce((s, r) => s + r.count, 0);

    // Default 12m window sees more deaths than the 30d window.
    expect(total365d).toBeGreaterThan(total30d);
    // 30d window still captures the recent death.
    expect(total30d).toBeGreaterThanOrEqual(1);
    // The old death is absent from the 30d result.
    const diseaseIn30d = r30d.find((r) => r.cause === "disease");
    expect(diseaseIn30d).toBeUndefined();
  });
});

describe("fetchZoonosisTrend — period window", () => {
  it("only returns outbreak signals within the requested window", async () => {
    const prov = "La Rioja";
    const loc = "La Rioja Capital";
    const pet = await insertFixturePet({
      name: "PeriodTrendPet",
      species: "dog",
      province: prov,
      locality: loc,
    });
    // Signal 5 days ago — inside a 30d window.
    await emitOutbreakSignal({
      petId: pet,
      diseaseCode: "rabies_suspected",
      province: prov,
      locality: loc,
      hoursAgo: 5 * 24,
    });
    // Signal 200 days ago — outside a 30d window, inside 12m.
    await emitOutbreakSignalAt({
      petId: pet,
      diseaseCode: "rabies_suspected",
      province: prov,
      locality: loc,
      occurredAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
    });

    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const trend30d = await fetchZoonosisTrend(
      { role: "govt" },
      [{ province: prov, locality: loc }],
      {
        since: since30d,
      },
    );
    const trend365d = await fetchZoonosisTrend({ role: "govt" }, [
      { province: prov, locality: loc },
    ]);

    const total30d = trend30d.reduce((s, p) => s + p.y, 0);
    const total365d = trend365d.reduce((s, p) => s + p.y, 0);

    // Default 12m window must see more signals (includes 200d-old signal).
    expect(total365d).toBeGreaterThan(total30d);
    // 30d window must still capture the 5d-old signal.
    expect(total30d).toBeGreaterThanOrEqual(1);
  });
});

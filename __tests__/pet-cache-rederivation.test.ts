// Fitness + non-vacuity tests for the pet-cache re-derivation harness (ARCH-I).
//
// THREE layers of assurance:
//
//  1. FITNESS SWEEP — for every pet currently in the test DB, assert that every
//     derivable cache column equals its re-derived value. Because all
//     integration tests create pets through the REAL writers, this sweep
//     catches any future writer that forgets the cache half of a dual-write
//     (the column would drift from the events and this test would go red).
//
//  2. WRITER ROUND-TRIP — drive real writers (weight, pregnancy, tattoo,
//     custody dispute) against a fresh pet and assert rederivePetCache reports
//     all-match. This proves the derivation rules agree with the writers.
//
//  3. NON-VACUITY — deliberately skew a cache column via raw SQL and assert the
//     harness DETECTS the mismatch. Without this, a harness that always returns
//     "matches: true" would pass layers 1 and 2 silently.
//
// THE OTHER HALF OF THE FITNESS SUITE lives in
// __tests__/rederive-pet-ownerships.test.ts (custodia-temporal). It applies the
// same three layers to `ownerships(role='caretaker')` rows, which
// rederivePetCache does not and cannot cover: it compares COLUMNS on one `pets`
// row, and an arrangement is a set of rows with a lifecycle. Kept as a separate
// file rather than folded in here so the expensive corpus sweep is not run
// twice — but it IS part of this suite, and a reader who finds only this file
// will conclude ownership rows are covered when they were not covered at all
// until that one existed.
//
// STILL UNCOVERED, on purpose: `owner`, `foster` and `shelter_custody` rows have
// NO drift detection. See that file's header for why replaying them is a
// separate change.

import { createClient } from "@supabase/supabase-js";
import { and, countDistinct, eq, like, ne } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  custodyDisputes,
  db,
  notifications,
  ownerships,
  petEvents,
  petIdentifications,
  pets,
  profiles,
} from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import {
  CHECKED_COLUMN_NAMES,
  hasDrift,
  rederivePetCache,
  sameObservationStatus,
} from "@/lib/infra/rederive-pet-cache";
import { replayPetStatus } from "@/lib/projections/pet-status";
import type { ProjectionEvent } from "@/lib/projections/types";
import { recordPregnancyStartedWriter } from "@/src/modules/pets/application/pregnancy/record-pregnancy-started";
import { createTattooForUser } from "@/src/modules/pets/application/tattoo/create-tattoo";
import { sql } from "drizzle-orm";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const OWNER_EMAIL = "rederive-owner@dim-test.local";
const PASS = "Rederive_2026!";
let ownerUserId: string;
const insertedPetIds: string[] = [];

const ownerAuthorship = {
  authorRole: "owner" as const,
  authorOrganizationId: null,
  authorVerified: false,
};

async function purgeUserByEmail(email: string) {
  const { data } = await supabase.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === email);
  const displayName = email.split("@")[0];
  const orphans = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));
  const ids = [
    ...(found ? [found.id] : []),
    ...orphans.map((o) => o.id).filter((id) => id !== found?.id),
  ];
  await withMutationOverride(async (tx) => {
    for (const uid of ids) {
      await tx.delete(notifications).where(eq(notifications.userId, uid));
      await tx.delete(profiles).where(eq(profiles.id, uid));
    }
  });
  if (found) await supabase.auth.admin.deleteUser(found.id);
}

async function insertTestPet(
  suffix: string,
  opts: { sex: "female" | "male"; species: "dog" | "cat" } = { sex: "female", species: "dog" },
) {
  const token = `REDERIVE-${suffix}-${Date.now()}`;
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: `RederivePet${suffix}`,
      species: opts.species,
      sex: opts.sex,
      status: "active",
    })
    .returning();
  await db.insert(ownerships).values({ petId: pet.id, ownerUserId, role: "owner" });
  insertedPetIds.push(pet.id);
  return pet;
}

beforeAll(async () => {
  await purgeUserByEmail(OWNER_EMAIL);
  const o = await createFreshTestUser(supabase, {
    email: OWNER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (o.error || !o.data.user) throw new Error(`createUser owner: ${o.error?.message}`);
  ownerUserId = o.data.user.id;
});

afterAll(async () => {
  for (const petId of insertedPetIds) {
    await withMutationOverride(async (tx) => {
      // custody_dispute_parties cascade-delete when their dispute row is deleted.
      await tx.delete(custodyDisputes).where(eq(custodyDisputes.petId, petId));
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }
  await db.delete(notifications).where(eq(notifications.userId, ownerUserId));
  await purgeUserByEmail(OWNER_EMAIL);
});

// ---------------------------------------------------------------------------
// Layer 1 — fitness sweep scoped to known-good seed pets
// ---------------------------------------------------------------------------
//
// WHY SCOPED (not whole-DB):
// A whole-DB sweep is state-dependent: leftover pets from other test files
// that run before this one (fileParallelism:false, serial order) can have
// cache columns in an intermediate write state or use synthetic tokens that
// hit edge-cases not covered by the harness (e.g. a microchip inserted via
// raw SQL without a matching pet_identifications row). This makes the sweep
// an intermittent flake rather than a reliable fitness signal.
//
// The scoped approach sweeps every pet whose publicToken was created by the
// canonical seed script (generatePublicToken() → "DIM-XXXX-XXXX" format).
// Seed pets go through the REAL writers (same as integration tests), so the
// fitness signal is preserved: if a writer forgets the cache dual-write, the
// seed pet's cache will drift and this test will go red.
//
// Writer round-trip tests (Layer 2) create their own pets and assert drift=false
// immediately, providing fine-grained coverage for each writer. Layer 1 is the
// safety net for writers that the round-trip layer does not explicitly cover.

describe("pet-cache fitness sweep", () => {
  it("every seed pet (DIM-* token) has a cache that matches its re-derived value", async () => {
    // Only sweep pets with canonical publicToken format from generatePublicToken().
    // This excludes raw-SQL test pets from other test files that may have
    // synthetic token formats or partial state from interrupted runs.
    const seedPets = await db
      .select({ id: pets.id, publicToken: pets.publicToken })
      .from(pets)
      .where(like(pets.publicToken, "DIM-%"));

    // The test DB is small but non-empty after bootstrap; if it were empty the
    // sweep would be vacuous (bootstrap creates at least 3 seed pets).
    expect(seedPets.length).toBeGreaterThan(0);

    const drifted: Array<{ token: string; columns: string[] }> = [];
    for (const p of seedPets) {
      const report = await rederivePetCache(p.id);
      if (hasDrift(report)) {
        drifted.push({
          token: p.publicToken,
          columns: Object.entries(report)
            .filter(([, r]) => !r.matches)
            .map(
              ([c, r]) =>
                `${c}(stored=${JSON.stringify(r.stored)} derived=${JSON.stringify(r.derived)})`,
            ),
        });
      }
    }

    // A failure here means a writer dual-write is broken OR a derivation rule
    // is wrong for seed-created pets. The message names the exact pets + columns.
    expect(drifted, JSON.stringify(drifted, null, 2)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Whole-corpus invariant (added 2026-08-10)
  // ---------------------------------------------------------------------------
  //
  // The sweep above deliberately narrows to `DIM-%` tokens, and the reason it
  // gives is sound — raw-SQL pets from other test files carry synthetic tokens
  // and half-written state. But the effect was that it watched 43 pets out of
  // 32.430, and the excluded class is exactly the one that drifted: the
  // `PANO-*` seed corpus had 2.733 pets (8,4% of the padrón) holding a
  // `death_recorded` event in the append-only spine with `status='active'` in
  // the cache.
  //
  // That mismatch is not cosmetic. repository-choropleth.ts counts mortality as
  // `status='deceased'` while repository-history.ts counts `death_recorded`
  // events, so one government screen showed 352 on the map and 3.946 in the
  // timeline below it — a factor of ten under a single label.
  //
  // So: keep the expensive full re-derivation on the narrow, trustworthy set,
  // and add ONE cheap invariant over the WHOLE table for the terminal fact that
  // matters most. Death is terminal per lib/projections/pet-status.ts, and the
  // catalog declares no reversal or correction event for it, so there is no
  // legitimate way to hold the event and not the status.
  it("no pet in the WHOLE padrón holds death_recorded while its cache says otherwise", async () => {
    const rows = await db
      .select({ id: pets.id, publicToken: pets.publicToken, status: pets.status })
      .from(pets)
      .innerJoin(petEvents, eq(petEvents.petId, pets.id))
      .where(and(eq(petEvents.eventType, "death_recorded"), ne(pets.status, "deceased")))
      .limit(50);

    // Non-vacuous: the corpus must actually contain deaths, or this passes by
    // scanning nothing — the failure mode three fences hit this same week.
    const [deaths] = await db
      .select({ n: countDistinct(petEvents.petId) })
      .from(petEvents)
      .where(eq(petEvents.eventType, "death_recorded"));
    expect(Number(deaths?.n ?? 0)).toBeGreaterThan(0);

    expect(
      rows.map((r) => `${r.publicToken} (status=${r.status})`),
      "Pets with death_recorded in the spine and a cache that disagrees. The spine is the fact; the column is the cache. Fix the writer that skipped the dual-write — see the reconciliation pass at the end of scripts/seed-panorama.ts for the shape.",
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The DERIVATION rule itself, pinned (2026-08-17 audit)
  // -------------------------------------------------------------------------
  //
  // WHY THIS IS SEPARATE FROM THE SWEEP ABOVE. A mutation forcing the status
  // derivation to return "active" unconditionally WAS caught — but only because
  // the local seed happens to hold pets that are not active. The catch was a
  // property of the DATA, not of the test: bootstrap a database whose every pet
  // is active (an empty corpus, a fresh install, a future seed that stops
  // emitting deaths) and the same mutation ships green. The `deaths > 0` guard
  // above protects against a vacuous corpus, but it protects the CACHE-DRIFT
  // query, not the derivation rule — that query finds nothing when the rule is
  // broken in the direction that makes stored and derived agree on "active".
  //
  // So: pin the rule directly, on an event list built here. No seed, no
  // database, no way for tomorrow's fixtures to decide whether this test has
  // teeth.
  it("the STATUS RULE itself: an event list carrying death_recorded derives 'deceased'", () => {
    const occurredAt = new Date("2026-03-04T10:00:00Z");
    const events: ProjectionEvent[] = [
      { id: "e1", eventType: "pet_registered", occurredAt, recordedAt: occurredAt, payload: {} },
      {
        id: "e2",
        eventType: "death_recorded",
        occurredAt,
        recordedAt: occurredAt,
        payload: { cause: "natural" },
      },
    ];

    const projected = replayPetStatus(events);
    expect(projected.status).toBe("deceased");
    expect(projected.deceasedAt?.toISOString()).toBe(occurredAt.toISOString());

    // Death is TERMINAL (lib/projections/pet-status.ts): a later status_changed
    // must not resurrect the pet. Without this line a mutation that simply
    // reorders the two rules still passes the assertion above.
    const withLaterStatusChange: ProjectionEvent[] = [
      ...events,
      {
        id: "e3",
        eventType: "status_changed",
        occurredAt: new Date("2026-05-01T10:00:00Z"),
        recordedAt: new Date("2026-05-01T10:00:00Z"),
        payload: { to_status: "active" },
      },
    ];
    expect(replayPetStatus(withLaterStatusChange).status).toBe("deceased");

    // Non-vacuity in the other direction: the rule must not answer "deceased"
    // to everything. A constant-return mutation has to fail SOMETHING here.
    expect(replayPetStatus([events[0]]).status).toBe("active");
    expect(replayPetStatus([]).status).toBe("active");
  });

  // The rule above is pure; this proves the HARNESS is wired to it, so a
  // regression in rederivePetCache's status column cannot hide behind a
  // correct projection. Builds its own pet — independent of any seed.
  it("the HARNESS reads that rule: a pet with death_recorded re-derives 'deceased' against an 'active' cache", async () => {
    const pet = await insertTestPet("SKEW-DEATH");
    const now = new Date();
    await db.insert(petEvents).values({
      petId: pet.id,
      eventType: "death_recorded",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: ownerUserId,
      ...ownerAuthorship,
      payload: validateEventPayload("death_recorded", {
        cause: "natural",
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
      }),
    });

    // insertTestPet leaves the cache at status='active' — the exact drift the
    // PANO-* corpus carried across 2.733 pets.
    const report = await rederivePetCache(pet.id);
    expect(report.status.stored).toBe("active");
    expect(report.status.derived).toBe("deceased");
    expect(report.status.matches).toBe(false);
    expect(hasDrift(report)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — writer round-trips
// ---------------------------------------------------------------------------

describe("pet-cache writer round-trips", () => {
  it("a freshly registered pet (no events) re-derives with no drift", async () => {
    const pet = await insertTestPet("FRESH");
    const report = await rederivePetCache(pet.id);
    expect(hasDrift(report)).toBe(false);
    // Sanity: a fresh pet's derivable columns are all the empty/default value.
    expect(report.status.derived).toBe("active");
    expect(report.pregnancyStatus.derived).toBeNull();
    expect(report.inCustodyDispute.derived).toBe(false);
  });

  it("checks every documented column (no silently-missing column)", async () => {
    const pet = await insertTestPet("COLS");
    const report = await rederivePetCache(pet.id);
    expect(Object.keys(report).sort()).toEqual([...CHECKED_COLUMN_NAMES].sort());
  });

  it("weight_recorded dual-write re-derives with no drift", async () => {
    const pet = await insertTestPet("WEIGHT");
    const now = new Date();
    // Drive the real dual-write seam: insert the event AND the cache column.
    await db.transaction(async (tx) => {
      await tx.insert(petEvents).values({
        petId: pet.id,
        eventType: "weight_recorded",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: ownerUserId,
        ...ownerAuthorship,
        payload: validateEventPayload("weight_recorded", { kg: "8.50" }),
      });
      await tx
        .update(pets)
        .set({ estimatedWeightKg: "8.50", updatedAt: now })
        .where(eq(pets.id, pet.id));
    });

    const report = await rederivePetCache(pet.id);
    expect(hasDrift(report)).toBe(false);
    expect(report.estimatedWeightKg.matches).toBe(true);
  });

  // Review 2026-08-22 (M1). A corrected weight is NOT drift. The amendment
  // refresher writes the AMENDED value into the cache inside the amendment's own
  // transaction, while this harness replayed the RAW event stream — so every
  // corrected pet read as permanently inconsistent, and `pnpm rebuild:projections
  // --apply` (the repair path the repo's own runbook points operators at) wrote
  // the pre-correction number back with no audit trail and no new event.
  // The defect got WORSE over time: before the refresher existed both sides read
  // the stale value and AGREED. Fixing one side alone made the detector lie.
  it("an AMENDED weight is not drift: the cache holds the corrected value", async () => {
    const pet = await insertTestPet("AMEND-WEIGHT");
    const now = new Date();
    await db.transaction(async (tx) => {
      const [original] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "weight_recorded",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: ownerUserId,
          ...ownerAuthorship,
          payload: validateEventPayload("weight_recorded", { kg: "10.00" }),
        })
        .returning({ id: petEvents.id });
      await tx.update(pets).set({ estimatedWeightKg: "10.00" }).where(eq(pets.id, pet.id));

      // The vet corrects 10 kg to 12 kg. amend-event.ts appends the correction
      // and refresh-pet-cache-after-amendment.ts updates the cache column in the
      // same transaction — both halves reproduced here.
      await tx.insert(petEvents).values({
        petId: pet.id,
        eventType: "event_amended",
        occurredAt: new Date(now.getTime() + 1000),
        recordedAt: new Date(now.getTime() + 1000),
        recordedByUserId: ownerUserId,
        ...ownerAuthorship,
        payload: validateEventPayload("event_amended", {
          target_event_id: original.id,
          reason: "peso mal tipeado",
          changes: [{ field: "kg", old: "10.00", new: "12.00" }],
          actor_role: "owner",
          actor_user_id: ownerUserId,
        }),
      });
      await tx.update(pets).set({ estimatedWeightKg: "12.00" }).where(eq(pets.id, pet.id));
    });

    const report = await rederivePetCache(pet.id);
    expect(report.estimatedWeightKg.stored).toBe("12.00");
    expect(report.estimatedWeightKg.derived).toBe("12.00");
    expect(report.estimatedWeightKg.matches).toBe(true);
    expect(hasDrift(report)).toBe(false);
  });

  it("pregnancy writer flips the cache and re-derives with no drift", async () => {
    const pet = await insertTestPet("PREG", { sex: "female", species: "dog" });
    const result = await recordPregnancyStartedWriter({
      pet,
      recordedByUserId: ownerUserId,
      eventAuthorship: ownerAuthorship,
      occurredAt: new Date(),
      weeksAtDiagnosis: null,
      vetConsulted: null,
      notes: null,
    });
    expect(result.ok).toBe(true);

    const report = await rederivePetCache(pet.id);
    expect(hasDrift(report)).toBe(false);
    expect(report.pregnancyStatus.stored).toBe("in_progress");
    expect(report.pregnancyStatus.derived).toBe("in_progress");
  });

  it("tattoo writer dual-write re-derives with no drift", async () => {
    const pet = await insertTestPet("TATTOO");
    const result = await createTattooForUser(pet.id, ownerUserId, ownerAuthorship, {
      code: "DIM-RDV-001",
      location: "inner_ear_left",
      description: "test tattoo",
      recordedAt: new Date("2026-01-15"),
      recordedBy: "Dr. Test",
      uploadedAttachment: { path: "fake/path.jpg", mimeType: "image/jpeg", size: 100 },
    });
    expect("eventId" in result).toBe(true);

    const report = await rederivePetCache(pet.id);
    expect(hasDrift(report)).toBe(false);
    expect(report.tattooCode.stored).toBe("DIM-RDV-001");
    expect(report.tattooCode.derived).toBe("DIM-RDV-001");
    expect(report.tattooRecordedAt.matches).toBe(true);
  });

  it("adoption_eligibility_set dual-write re-derives with no drift", async () => {
    const pet = await insertTestPet("ADOPT-ELIG");
    const now = new Date();
    // Drive the dual-write seam: append the event AND fold it into the cache
    // (adoptionEligible + adoptionEligibilitySetAt = event.recordedAt, mirroring
    // replayPetAdoptionEligibility). Capture the DB-assigned recordedAt so the
    // instant comparison is exact.
    let recordedAt: Date | undefined;
    await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "adoption_eligibility_set",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: ownerUserId,
          ...ownerAuthorship,
          payload: validateEventPayload("adoption_eligibility_set", {
            eligible: true,
            ineligible_reason: null,
            ineligible_reason_notes: null,
            ineligible_until: null,
          }),
        })
        .returning({ recordedAt: petEvents.recordedAt });
      recordedAt = inserted.recordedAt;
      await tx
        .update(pets)
        .set({ adoptionEligible: true, adoptionEligibilitySetAt: inserted.recordedAt })
        .where(eq(pets.id, pet.id));
    });

    const report = await rederivePetCache(pet.id);
    expect(hasDrift(report)).toBe(false);
    expect(report.adoptionEligible.stored).toBe(true);
    expect(report.adoptionEligible.derived).toBe(true);
    expect(report.adoptionEligibilitySetAt.matches).toBe(true);
    // The setAt witness must equal the event's recordedAt instant.
    expect(new Date(report.adoptionEligibilitySetAt.derived as string).getTime()).toBe(
      recordedAt?.getTime(),
    );
  });

  it("custody dispute (table-sourced) re-derives true while open, false after close", async () => {
    const pet = await insertTestPet("DISPUTE");
    const now = new Date();

    // Emit a raising event + open dispute row + flip the cache flag — mirrors
    // openDisputeFromEvent's dual-write (event spine + custody_disputes table).
    await db.transaction(async (tx) => {
      const [raisingEvent] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "custody_dispute_raised",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: ownerUserId,
          authorRole: "govt",
          authorOrganizationId: null,
          authorVerified: true,
          payload: validateEventPayload("custody_dispute_raised", {
            raised_by_role: "govt",
            raised_by_user_id: ownerUserId,
            external_proceeding_reference: null,
            reason: "Test dispute for re-derivation harness coverage.",
          }),
        })
        .returning({ id: petEvents.id });

      await tx.insert(custodyDisputes).values({
        publicToken: `DIS-RDV-${Date.now()}`,
        petId: pet.id,
        raisedByUserId: ownerUserId,
        raisedByRole: "govt",
        raisingEventId: raisingEvent.id,
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "La Plata",
      });

      await tx
        .update(pets)
        .set({ inCustodyDispute: true, updatedAt: now })
        .where(eq(pets.id, pet.id));
    });

    const openReport = await rederivePetCache(pet.id);
    expect(openReport.inCustodyDispute.stored).toBe(true);
    expect(openReport.inCustodyDispute.derived).toBe(true);
    expect(openReport.inCustodyDispute.matches).toBe(true);

    // Resolve the dispute + flip the flag back (resolveDisputeAction's seam).
    const resolvedAt = new Date();
    await db
      .update(custodyDisputes)
      .set({
        status: "resolved",
        resolution: "ownership_confirmed",
        resolutionSummary: "x".repeat(120),
        resolvedByUserId: ownerUserId,
        resolvedAt,
        updatedAt: resolvedAt,
      })
      .where(and(eq(custodyDisputes.petId, pet.id), eq(custodyDisputes.status, "open")));
    await db
      .update(pets)
      .set({ inCustodyDispute: false, updatedAt: resolvedAt })
      .where(eq(pets.id, pet.id));

    const closedReport = await rederivePetCache(pet.id);
    expect(closedReport.inCustodyDispute.derived).toBe(false);
    expect(closedReport.inCustodyDispute.matches).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — non-vacuity: the harness must DETECT a deliberate skew
// ---------------------------------------------------------------------------

describe("pet-cache non-vacuity (harness detects skew)", () => {
  it("detects a skewed pregnancyStatus cache (events say in_progress, cache forced null)", async () => {
    const pet = await insertTestPet("SKEW-PREG", { sex: "female", species: "dog" });
    const ok = await recordPregnancyStartedWriter({
      pet,
      recordedByUserId: ownerUserId,
      eventAuthorship: ownerAuthorship,
      occurredAt: new Date(),
      weeksAtDiagnosis: null,
      vetConsulted: null,
      notes: null,
    });
    expect(ok.ok).toBe(true);

    // Pre-skew: clean.
    expect(hasDrift(await rederivePetCache(pet.id))).toBe(false);

    // SKEW the cache directly (simulates a writer that forgot the cache half).
    await db.update(pets).set({ pregnancyStatus: null }).where(eq(pets.id, pet.id));

    const report = await rederivePetCache(pet.id);
    expect(hasDrift(report)).toBe(true);
    expect(report.pregnancyStatus.matches).toBe(false);
    expect(report.pregnancyStatus.stored).toBeNull();
    expect(report.pregnancyStatus.derived).toBe("in_progress");
  });

  it("detects a skewed estimatedWeightKg cache", async () => {
    const pet = await insertTestPet("SKEW-WEIGHT");
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.insert(petEvents).values({
        petId: pet.id,
        eventType: "weight_recorded",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: ownerUserId,
        ...ownerAuthorship,
        payload: validateEventPayload("weight_recorded", { kg: "5.00" }),
      });
      await tx.update(pets).set({ estimatedWeightKg: "5.00" }).where(eq(pets.id, pet.id));
    });
    expect(hasDrift(await rederivePetCache(pet.id))).toBe(false);

    // Skew to a different number — numeric compare must flag it.
    await db.update(pets).set({ estimatedWeightKg: "9.90" }).where(eq(pets.id, pet.id));
    const report = await rederivePetCache(pet.id);
    expect(report.estimatedWeightKg.matches).toBe(false);
  });

  // The non-vacuity twin of the amended-weight round-trip above (M1). A harness
  // that simply ignored amendments on BOTH sides would pass that test; this one
  // pins that the overlay reads the CORRECTED value, so a cache left on the
  // pre-correction number is still reported as drift.
  it("detects a cache stuck on the PRE-amendment weight", async () => {
    const pet = await insertTestPet("SKEW-AMEND-WEIGHT");
    const now = new Date();
    await db.transaction(async (tx) => {
      const [original] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "weight_recorded",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: ownerUserId,
          ...ownerAuthorship,
          payload: validateEventPayload("weight_recorded", { kg: "10.00" }),
        })
        .returning({ id: petEvents.id });
      await tx.insert(petEvents).values({
        petId: pet.id,
        eventType: "event_amended",
        occurredAt: new Date(now.getTime() + 1000),
        recordedAt: new Date(now.getTime() + 1000),
        recordedByUserId: ownerUserId,
        ...ownerAuthorship,
        payload: validateEventPayload("event_amended", {
          target_event_id: original.id,
          reason: "peso mal tipeado",
          changes: [{ field: "kg", old: "10.00", new: "12.00" }],
          actor_role: "owner",
          actor_user_id: ownerUserId,
        }),
      });
      // The cache half of the amendment never landed — it still holds the raw
      // value. That IS drift, and the harness has to keep saying so.
      await tx.update(pets).set({ estimatedWeightKg: "10.00" }).where(eq(pets.id, pet.id));
    });

    const report = await rederivePetCache(pet.id);
    expect(report.estimatedWeightKg.stored).toBe("10.00");
    expect(report.estimatedWeightKg.derived).toBe("12.00");
    expect(report.estimatedWeightKg.matches).toBe(false);
  });

  it("detects a skewed adoptionEligible cache (event says true, cache forced null)", async () => {
    const pet = await insertTestPet("SKEW-ADOPT-ELIG");
    const now = new Date();
    await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "adoption_eligibility_set",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: ownerUserId,
          ...ownerAuthorship,
          payload: validateEventPayload("adoption_eligibility_set", {
            eligible: true,
            ineligible_reason: null,
            ineligible_reason_notes: null,
            ineligible_until: null,
          }),
        })
        .returning({ recordedAt: petEvents.recordedAt });
      await tx
        .update(pets)
        .set({ adoptionEligible: true, adoptionEligibilitySetAt: inserted.recordedAt })
        .where(eq(pets.id, pet.id));
    });
    expect(hasDrift(await rederivePetCache(pet.id))).toBe(false);

    // SKEW: force both cache columns null (simulates a seed/writer that emitted
    // the event but forgot the cache dual-write — the exact DIM-S009/S012 drift).
    await db
      .update(pets)
      .set({ adoptionEligible: null, adoptionEligibilitySetAt: null })
      .where(eq(pets.id, pet.id));

    const report = await rederivePetCache(pet.id);
    expect(report.adoptionEligible.matches).toBe(false);
    expect(report.adoptionEligible.stored).toBeNull();
    expect(report.adoptionEligible.derived).toBe(true);
    expect(report.adoptionEligibilitySetAt.matches).toBe(false);
  });

  it("detects a skewed inCustodyDispute flag (no open dispute but flag true)", async () => {
    const pet = await insertTestPet("SKEW-DISPUTE");
    // No dispute row exists → derived false. Force the cache flag true.
    await db.update(pets).set({ inCustodyDispute: true }).where(eq(pets.id, pet.id));
    const report = await rederivePetCache(pet.id);
    expect(report.inCustodyDispute.stored).toBe(true);
    expect(report.inCustodyDispute.derived).toBe(false);
    expect(report.inCustodyDispute.matches).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Backfill-sentinel contract tests (ARCH-Q / migration 0083)
  //
  // The harness suppresses false positives for backfill-labeled canonical rows
  // because the backfill approximates some dates from created_at/current_date.
  // These tests document that contract explicitly:
  //
  //  A. A non-backfill chip row whose microchipId is directly skewed DOES get
  //     detected (proves the harness isn't universally suppressing chip checks).
  //
  //  B. A backfill-labeled row with a deliberately divergent recordedAt is
  //     SKIPPED (the "backfill sentinel suppresses date comparison" contract).
  // -------------------------------------------------------------------------

  it("detects skew on a non-backfill canonical chip row (sentinel does not suppress real drift)", async () => {
    const pet = await insertTestPet("SKEW-CHIP-REAL");
    const now = new Date();

    // Dual-write: emit the event AND insert the canonical row so both the
    // projection (event-derived) and the stored side (canonical row) agree
    // on the chip code before any skew is introduced.
    await withMutationOverride(async (tx) => {
      await tx.insert(petEvents).values({
        petId: pet.id,
        eventType: "microchip_implanted",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: ownerUserId,
        ...ownerAuthorship,
        payload: validateEventPayload("microchip_implanted", {
          chip_number: "100000000000001",
          country_code: "100",
          implant_date_known: false,
          implanted_by: null,
          location_on_body: null,
        }),
      });
      await tx.insert(petIdentifications).values({
        petId: pet.id,
        kind: "microchip_iso" as const,
        status: "active" as const,
        code: "100000000000001",
        isoCountryCode: "100",
        isoManufacturerCode: "0000",
        isoNationalId: "00000001",
        isoCompliant: true,
        recordedAt: now.toISOString().slice(0, 10),
        recordedByLabel: "dr-real-vet",
      });
      // ARCH-S: pets.microchipId dropped — canonical row above is the sole source.
    });

    // Pre-skew: microchipId must match (canonical=event-derived=same code).
    const cleanReport = await rederivePetCache(pet.id);
    expect(cleanReport.microchipId.matches).toBe(true);

    // Skew the canonical row's code — simulates canonical drift.
    await db.execute(
      sql`UPDATE pet_identifications SET code = '999999999999999'
              WHERE pet_id = ${pet.id} AND kind = 'microchip_iso' AND status = 'active'`,
    );

    const skewedReport = await rederivePetCache(pet.id);
    // stored='999999999999999' (canonical), derived='100000000000001' (event) → detected.
    expect(skewedReport.microchipId.matches).toBe(false);
    expect(skewedReport.microchipId.stored).toBe("999999999999999");
  });

  it("backfill-labeled canonical row: recordedAt mismatch is SKIPPED (sentinel suppresses date)", async () => {
    const pet = await insertTestPet("SKEW-CHIP-BACKFILL");

    // A backfill-labeled row represents a legacy pet with no microchip_implanted
    // event. The 0082/0083 backfills approximate recordedAt from created_at or
    // current_date, which may differ from any real implant date. The harness
    // suppresses microchipImplantedAt and microchipImplantedBy for backfill rows
    // to avoid false-positive drift alarms.
    //
    // We deliberately set recordedAt="2020-01-15" (a past date that will NOT match
    // the derived null since there's no event) and verify the harness treats the
    // mismatch as irrelevant (by treating stored as derived).
    await withMutationOverride(async (tx) => {
      await tx.insert(petIdentifications).values({
        petId: pet.id,
        kind: "microchip_iso" as const,
        status: "active" as const,
        code: "200000000000002",
        isoCountryCode: "200",
        isoManufacturerCode: "0000",
        isoNationalId: "00000002",
        isoCompliant: true,
        // Intentionally divergent from what a real event would produce (null).
        // 0083 sets current_date when microchip_implanted_at was null.
        recordedAt: "2020-01-15",
        recordedByLabel: "legacy_backfill_0083",
      });
      // ARCH-S: pets.microchipId dropped — canonical row above is the sole source.
    });

    const report = await rederivePetCache(pet.id);
    // microchipImplantedAt: stored is undefined (sentinel → uses derived=null) → matches.
    expect(report.microchipImplantedAt.matches).toBe(true);
    // microchipImplantedBy: stored is null (sentinel) and derived is null (no event) → matches.
    expect(report.microchipImplantedBy.matches).toBe(true);
    // microchipId: stored='200000000000002' (canonical), derived=null (no event).
    // This is intentional: for backfill rows without events, the harness correctly
    // flags microchipId as a drift (the canonical has data but no event backs it).
    // The sentinel ONLY suppresses date/person fields — not the code itself.
    expect(report.microchipId.stored).toBe("200000000000002");
    expect(report.microchipId.derived).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Jurisdiction — the latent risk this column was excluded for (2026-08-12)
// ---------------------------------------------------------------------------
//
// jurisdictionCountry/_Province/_Locality were in NEITHER the checked list nor
// the excluded list until this change: they fell through the gap in silence,
// which is precisely what this module exists to prevent. The write path is safe
// today only because recordMoveAction stamps `occurredAt: new Date()`, so moves
// are always "now" and the last write IS the latest by occurredAt. The day a
// movement form gets an editable date — or a bulk import of historical moves
// lands — an out-of-order move points the cache at the OLD jurisdiction, and
// jurisdiction feeds the PPP gate, the compliance cards and authority routing.
//
// These tests assert the harness would catch that, and that a canonicalized
// move is NOT mistaken for drift.
describe("pet-cache jurisdiction — derived from the spine", () => {
  async function registerWithJurisdiction(pet: { id: string }, province: string, locality: string) {
    await db.insert(petEvents).values({
      petId: pet.id,
      eventType: "pet_registered",
      occurredAt: new Date("2026-01-01T12:00:00Z"),
      recordedAt: new Date("2026-01-01T12:00:00Z"),
      payload: validateEventPayload("pet_registered", {
        name: "RederivePetJuris",
        species: "dog",
        sex: "female",
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
        jurisdiction_province: province,
        jurisdiction_locality: locality,
        potentially_dangerous_breed: false,
        acquisition_method: null,
        has_photo: false,
        has_microchip: false,
      }),
      authorRole: "owner",
      recordedByUserId: ownerUserId,
    });
    await db
      .update(pets)
      .set({ jurisdictionProvince: province, jurisdictionLocality: locality })
      .where(eq(pets.id, pet.id));
  }

  async function recordMove(
    pet: { id: string },
    province: string,
    locality: string,
    occurredAt: Date,
  ) {
    await db.insert(petEvents).values({
      petId: pet.id,
      eventType: "movement_recorded",
      occurredAt,
      recordedAt: new Date(),
      payload: {
        payload_version: 1,
        sub_kind: "jurisdiction_changed",
        from_country: "AR",
        from_province: province === "Salta" ? "CABA" : "Salta",
        from_locality: null,
        to_country: "AR",
        to_province: province,
        to_locality: locality,
      },
      authorRole: "owner",
      recordedByUserId: ownerUserId,
    });
  }

  it("no drift when the cache matches the registration event", async () => {
    const pet = await insertTestPet("JURIS-CLEAN");
    await registerWithJurisdiction(pet, "Salta", "Salta");

    const report = await rederivePetCache(pet.id);

    expect(report.jurisdictionProvince.matches).toBe(true);
    expect(report.jurisdictionProvince.derived).toBe("Salta");
  });

  it("DETECTS a back-dated move that left the cache on the newer destination", async () => {
    // The failure the exclusion was written to describe. Registered in Salta,
    // moved to CABA today (cache = CABA), then a FORGOTTEN older move to
    // Córdoba is recorded. replayPetJurisdiction is latest-by-occurredAt, so the
    // spine still says CABA — but flip the two dates and the blind writer's
    // value and the spine's diverge. Here the cache is deliberately left on the
    // stale destination to prove the harness sees the disagreement at all.
    const pet = await insertTestPet("JURIS-BACKDATED");
    await registerWithJurisdiction(pet, "Salta", "Salta");
    await recordMove(pet, "CABA", "Palermo", new Date("2026-06-01T12:00:00Z"));

    // Cache left where the registration put it — the drift a missing dual-write
    // (or an out-of-order move) produces.
    const report = await rederivePetCache(pet.id);

    expect(report.jurisdictionProvince.matches).toBe(false);
    expect(report.jurisdictionProvince.stored).toBe("Salta");
    expect(report.jurisdictionProvince.derived).toBe("CABA");
  });

  it("latest-by-occurredAt wins: an older move recorded later does NOT win", async () => {
    const pet = await insertTestPet("JURIS-ORDER");
    await registerWithJurisdiction(pet, "Salta", "Salta");
    await recordMove(pet, "CABA", "Palermo", new Date("2026-06-01T12:00:00Z"));
    // Recorded now, but dated BEFORE the CABA move.
    await recordMove(pet, "Salta", "Salta", new Date("2026-03-01T12:00:00Z"));
    await db
      .update(pets)
      .set({ jurisdictionProvince: "CABA", jurisdictionLocality: "Palermo" })
      .where(eq(pets.id, pet.id));

    const report = await rederivePetCache(pet.id);

    // The June move still wins — the cache is correct and must not be flagged.
    expect(report.jurisdictionProvince.derived).toBe("CABA");
    expect(report.jurisdictionProvince.matches).toBe(true);
  });

  it("is skipped, not flagged, when the spine asserts no jurisdiction", async () => {
    // Seed-created pets emit pet_registered without the jurisdiction fields
    // while setting the column directly. That is "nothing to compare", not
    // drift — flagging it would put every seeded pet in the report.
    const pet = await insertTestPet("JURIS-SILENT");
    await db
      .update(pets)
      .set({ jurisdictionProvince: "CABA", jurisdictionLocality: "Palermo" })
      .where(eq(pets.id, pet.id));

    const report = await rederivePetCache(pet.id);

    expect(report.jurisdictionProvince.matches).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fecha de implante: stored y derived tienen que hablar el mismo modelo
// (2a pasada de auditoría, hallazgo #5, 2026-08-12)
// ---------------------------------------------------------------------------
//
// La proyección devuelve `implant_date_known ? formatDate(occurredAt) : null`.
// Los writers escribían `recordedAt` no-nulo en la fila canónica igual, así que
// cada alta de chip generaba deriva: stored=una fecha, derived=null.
//
// No llegaba a ninguna pantalla del usuario (la credencial muestra Sí/No y la
// libreta sólo el código), pero spameaba el detector de deriva con
// falsos positivos — y un detector ruidoso se termina ignorando, que es la forma
// en que un fence muere sin que nadie lo apague.
//
// El test que ya existía armaba exactamente esta combinación y sólo asserteaba
// `microchipId.matches`, nunca `microchipImplantedAt.matches`. Misma forma que
// los tres tests históricos que verdeaban sobre el bug que debían atrapar.
describe("pet-cache — fecha de implante desconocida", () => {
  async function insertChip(
    petIdArg: string,
    opts: { dateKnown: boolean; recordedAt: string | null; code: string },
  ) {
    const when = new Date();
    await withMutationOverride(async (tx) => {
      await tx.insert(petEvents).values({
        petId: petIdArg,
        eventType: "microchip_implanted",
        occurredAt: when,
        recordedAt: when,
        authorRole: "owner",
        recordedByUserId: ownerUserId,
        payload: validateEventPayload("microchip_implanted", {
          chip_number: opts.code,
          country_code: "100",
          implant_date_known: opts.dateKnown,
          implanted_by: null,
          location_on_body: null,
        }),
      });
      await tx.insert(petIdentifications).values({
        petId: petIdArg,
        kind: "microchip_iso" as const,
        status: "active" as const,
        code: opts.code,
        isoCountryCode: "100",
        isoManufacturerCode: "0000",
        isoNationalId: opts.code.slice(7, 15),
        isoCompliant: true,
        recordedAt: opts.recordedAt,
        recordedByLabel: "dr-real-vet",
      });
    });
  }

  it("DETECTA la deriva cuando el caché inventa una fecha que el spine marca desconocida", async () => {
    // El estado que producían los writers antes del arreglo. Que el harness lo
    // vea es lo que hace que el arreglo sea verificable.
    const pet = await insertTestPet("CHIP-DATE-DRIFT");
    await insertChip(pet.id, {
      dateKnown: false,
      recordedAt: new Date().toISOString().slice(0, 10),
      code: "100000000000021",
    });

    const report = await rederivePetCache(pet.id);

    expect(report.microchipImplantedAt.matches).toBe(false);
    expect(report.microchipImplantedAt.derived).toBeNull();
  });

  it("no hay deriva cuando ambos lados dicen 'no sé' (el modelo corregido del intake)", async () => {
    const pet = await insertTestPet("CHIP-DATE-NULL");
    await insertChip(pet.id, { dateKnown: false, recordedAt: null, code: "100000000000022" });

    const report = await rederivePetCache(pet.id);

    expect(report.microchipImplantedAt.matches).toBe(true);
  });

  it("no hay deriva cuando la fecha SÍ se conoce y el caché la guarda (el alta normal de chip)", async () => {
    const pet = await insertTestPet("CHIP-DATE-KNOWN");
    await insertChip(pet.id, {
      dateKnown: true,
      recordedAt: new Date().toISOString().slice(0, 10),
      code: "100000000000023",
    });

    const report = await rederivePetCache(pet.id);

    expect(report.microchipImplantedAt.matches).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rabiesObservationStatus — the ONE forgiven asymmetry (2026-08-17)
//
// The daily sweep refines a stored `in_progress` into `window_expired_unclosed`
// purely because the statutory window elapsed, and writes NO event for it (see
// lib/projections/pet-rabies-observation.ts: the projection stays clockless on
// purpose). The comparator forgives exactly that pair and nothing else — a
// stored `window_expired_unclosed` against a derived `completed_*` is a lost
// professional close, which is real drift.
// ---------------------------------------------------------------------------

describe("sameObservationStatus", () => {
  it("forgives stored window_expired_unclosed vs derived in_progress", () => {
    expect(sameObservationStatus("window_expired_unclosed", "in_progress")).toBe(true);
  });

  it("does NOT forgive the reverse", () => {
    expect(sameObservationStatus("in_progress", "window_expired_unclosed")).toBe(false);
  });

  it("does NOT forgive a lost professional close", () => {
    expect(sameObservationStatus("window_expired_unclosed", "completed_negative")).toBe(false);
    expect(sameObservationStatus("in_progress", "completed_positive_rabies")).toBe(false);
  });

  it("still matches on equality, including null vs undefined", () => {
    expect(sameObservationStatus("completed_dead", "completed_dead")).toBe(true);
    expect(sameObservationStatus(null, undefined)).toBe(true);
  });
});

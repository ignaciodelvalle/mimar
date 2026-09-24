// Integration test — corrections-supersede across control-poblacional KPIs
// (WAVE E3). clinical_info_logged is in AMENDABLE_EVENT_TYPES, so its `outcome`
// and `live_births_count` payload fields are mutable via event_amended. Before
// E3, the natalidad fetchers read the RAW payload, so a corrected reproductive
// outcome never moved the KPI (the original wrong value counted forever). These
// tests assert the amendment overlay (amendedPayloadText) now supersedes the
// original in fetchReproductiveOutcomes, fetchNetGrowth and
// fetchSterilizationNatalidadRatio.
//
// Requires the local Supabase Postgres (127.0.0.1:54322).

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import {
  fetchNetGrowth,
  fetchReproductiveOutcomes,
  fetchSterilizationNatalidadRatio,
} from "@/lib/metrics/population-control";
import { withMutationOverride } from "./_helpers/db-overrides";

// Locality unique to this suite so the scoped aggregate is EXACTLY our fixtures.
const PROVINCE = "Santa Fe";
const LOCALITY = "ReproAmendVille";
const TOKEN_COUNT = "PC-AMEND-COUNT-01"; // exercises live_births_count overlay
const TOKEN_OUTCOME = "PC-AMEND-OUTCOME-01"; // exercises outcome overlay

let countPetId: string;
let outcomePetId: string;
let countEventId: string;
let outcomeEventId: string;

const scopedCtx = () =>
  buildProjectionContext(
    { role: "govt" },
    [{ province: PROVINCE, locality: LOCALITY }],
    windows.trailing12m(),
  );

async function cleanupFixtures() {
  // pet_events is append-only (db/triggers.sql) — deletes require the mutation
  // override. Pets carry an auto-written welcome event, so clear events first.
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`
      DELETE FROM pet_events
      WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token IN (${TOKEN_COUNT}, ${TOKEN_OUTCOME})
      )
    `);
    await tx.execute(sql`
      DELETE FROM pets WHERE public_token IN (${TOKEN_COUNT}, ${TOKEN_OUTCOME})
    `);
  });
}

async function insertPregnancyEnded(
  petId: string,
  outcome: string,
  liveBirthsCount: number | null,
): Promise<string> {
  const [row] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "clinical_info_logged",
      occurredAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      payload: {
        payload_version: 1,
        sub_kind: "pregnancy",
        pregnancy_phase: "ended",
        outcome,
        live_births_count: liveBirthsCount,
        // petEventsScopeClause filters the scoped govt read on these fields.
        pet_jurisdiction_province: PROVINCE,
        pet_jurisdiction_locality: LOCALITY,
      },
      authorRole: "vet",
      recordedByUserId: null,
    })
    .returning({ id: petEvents.id });
  return row.id;
}

// A single amendment always targets the ORIGINAL event and carries the full
// change set (amend-event.ts flatten semantics — latest amendment wins).
async function amend(
  petId: string,
  targetEventId: string,
  changes: Array<{ field: string; old: unknown; new: unknown }>,
  occurredAt: Date = new Date(),
) {
  await db.insert(petEvents).values({
    petId,
    eventType: "event_amended",
    occurredAt,
    payload: {
      payload_version: 1,
      target_event_id: targetEventId,
      reason: "Corrección de datos de parto",
      changes,
    },
    authorRole: "vet",
    recordedByUserId: null,
  });
}

beforeAll(async () => {
  await cleanupFixtures();
  const inserted = await db
    .insert(pets)
    .values(
      [TOKEN_COUNT, TOKEN_OUTCOME].map((token) => ({
        publicToken: token,
        name: `ReproAmendDog-${token.slice(-2)}`,
        species: "dog",
        status: "active" as const,
        jurisdictionProvince: PROVINCE,
        jurisdictionLocality: LOCALITY,
      })),
    )
    .returning({ id: pets.id, publicToken: pets.publicToken });
  countPetId = inserted.find((p) => p.publicToken === TOKEN_COUNT)?.id as string;
  outcomePetId = inserted.find((p) => p.publicToken === TOKEN_OUTCOME)?.id as string;

  // Both start as live births: count pet has 3, outcome pet has 2.
  countEventId = await insertPregnancyEnded(countPetId, "live_birth", 3);
  outcomeEventId = await insertPregnancyEnded(outcomePetId, "live_birth", 2);
});

afterAll(cleanupFixtures);

describe("control-poblacional natalidad — event_amended corrections supersede", () => {
  it("baseline (no corrections): both pregnancies count as live births", async () => {
    const repro = await fetchReproductiveOutcomes(scopedCtx());
    expect(repro.byClinicalOutcome.live_birth).toBe(2);
    expect(repro.byClinicalOutcome.stillbirth).toBe(0);
    expect(repro.registeredBirths).toBe(2);
    // Sum of live_births_count across both live-birth events: 3 + 2 = 5.
    expect(repro.liveBirthsCountSum).toBe(5);

    const growth = await fetchNetGrowth(scopedCtx());
    expect(growth.registeredBirths).toBe(2);
  });

  it("correcting live_births_count (3 → 5) moves liveBirthsCountSum, not the outcome bucket", async () => {
    await amend(countPetId, countEventId, [{ field: "live_births_count", old: 3, new: 5 }]);

    const repro = await fetchReproductiveOutcomes(scopedCtx());
    // Still two live births; the corrected count (5) replaces the original 3.
    expect(repro.byClinicalOutcome.live_birth).toBe(2);
    expect(repro.registeredBirths).toBe(2);
    expect(repro.liveBirthsCountSum).toBe(7); // 5 (corrected) + 2
  });

  it("correcting outcome (live_birth → stillbirth) un-counts a birth across every fetcher", async () => {
    // Strictly later so the "latest amendment wins" ordering is unambiguous.
    await amend(
      outcomePetId,
      outcomeEventId,
      [{ field: "outcome", old: "live_birth", new: "stillbirth" }],
      new Date(Date.now() + 60_000),
    );

    const repro = await fetchReproductiveOutcomes(scopedCtx());
    // The corrected pregnancy now falls in the stillbirth bucket.
    expect(repro.byClinicalOutcome.live_birth).toBe(1);
    expect(repro.byClinicalOutcome.stillbirth).toBe(1);
    expect(repro.registeredBirths).toBe(1);
    // Only the remaining live birth (corrected count pet) contributes: 5.
    expect(repro.liveBirthsCountSum).toBe(5);

    // fetchNetGrowth reads the same corrected outcome.
    const growth = await fetchNetGrowth(scopedCtx());
    expect(growth.registeredBirths).toBe(1);

    // fetchSterilizationNatalidadRatio denominator = corrected births = 1;
    // no sterilizations in scope → 0 / 1 = 0 (a defined, non-null ratio).
    const ratio = await fetchSterilizationNatalidadRatio(scopedCtx());
    expect(ratio).toBe(0);
  });
});

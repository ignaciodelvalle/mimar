// Regression (WARNING 2): the cobertura unit-history k-anon guard must mirror the
// MAP numerator — DOGS with a rabies dose currently valid in the trailing-12m
// window, narrowed to vet-signed doses when `verifiedOnly` is on. The prior guard
// counted ALL rabies doses over the SCRUBBER window, so with "solo firmado" ON a
// department the map suppressed (vet-signed < 5) could clear the guard and be
// re-identified via "Historia de la unidad".
//
// Deterministic: a synthetic locality + 6 dogs, each with a currently-valid rabies
// dose; only 2 are vet-signed. Under verifiedOnly the guard must suppress (2 < 5).
//
// Integration test — local Supabase + Postgres.

import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import type { EventType } from "@/db/schema";
import { validateEventPayload } from "@/lib/events/event-schemas";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";
import { loadUnitHistory } from "../repository";

const PROVINCE = "Santa Fe";
const LOCALITY = "PANO-COB-LOC"; // synthetic — no seed collision
const ADMIN: DashboardActor = { role: "admin" };
const JURS: DashboardJurisdiction[] = [];
const SINCE = new Date(Date.now() - 24 * 60 * 60 * 1000);

const petIds: string[] = [];

async function makeDog(token: string): Promise<string> {
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: token,
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: LOCALITY,
    })
    .returning({ id: pets.id });
  return row.id;
}

async function insertRabiesDose(petId: string, signed: boolean): Promise<void> {
  await db.insert(petEvents).values({
    petId,
    eventType: "vaccination_administered" as EventType,
    occurredAt: new Date(), // within trailing-12m → currently valid (next_due_at null → 12m proxy)
    payload: validateEventPayload("vaccination_administered", {
      vaccine_name: "Antirrábica",
      brand: null,
      batch: null,
      administered_by: null,
      next_due_at: null,
    }) as Record<string, unknown>,
    // Vet-signed dose = author_role 'vet' AND author_verified true (the single
    // definition in rabiesSignedByMatriculaCondition).
    authorRole: signed ? "vet" : "owner",
    authorVerified: signed,
    recordedByUserId: null,
  });
}

const FIXTURE_TOKENS = Array.from({ length: 6 }, (_, i) => `DIM-PANO-COB-${i}`);

// Clear by TOKEN, not by remembered ids: a run killed mid-suite leaves rows the
// in-memory petIds array can't see, and the fixed tokens then collide on the
// next run's inserts (unique pets_public_token). Token-keyed cleanup makes the
// suite self-healing (same idiom as outbreak-investigation).
async function cleanup(): Promise<void> {
  const stale = await db
    .select({ id: pets.id })
    .from(pets)
    .where(inArray(pets.publicToken, FIXTURE_TOKENS));
  const staleIds = stale.map((r) => r.id);
  if (staleIds.length) {
    await withMutationOverride(async (tx) => {
      await tx.delete(petEvents).where(inArray(petEvents.petId, staleIds));
    });
    await db.delete(pets).where(inArray(pets.id, staleIds));
  }
  petIds.length = 0;
}

beforeAll(async () => {
  await cleanup();
  // 6 dogs, each with a currently-valid rabies dose; only 2 vet-signed.
  for (let i = 0; i < 6; i++) {
    const id = await makeDog(`DIM-PANO-COB-${i}`);
    petIds.push(id);
    await insertRabiesDose(id, i < 2); // dogs 0,1 signed; 2..5 owner-recorded
  }
});

afterAll(cleanup);

describe("cobertura unit-history k-anon guard honors verifiedOnly (WARNING 2)", () => {
  it("suppresses when vet-signed dogs < 5 even though total dosed dogs >= 5", async () => {
    const hist = await loadUnitHistory({
      layer: "cobertura",
      province: PROVINCE,
      locality: LOCALITY,
      verifiedOnly: true,
      since: SINCE,
      until: new Date(),
      actor: ADMIN,
      jurisdictions: JURS,
    });
    // Only 2 vet-signed dogs → below k=5 → suppressed (the map suppresses it too).
    expect(hist.suppressed).toBe(true);
    expect(hist.events).toHaveLength(0);
  }, 30_000);

  it("does not suppress on the full (unsigned) numerator when verifiedOnly is off", async () => {
    const hist = await loadUnitHistory({
      layer: "cobertura",
      province: PROVINCE,
      locality: LOCALITY,
      verifiedOnly: false,
      since: SINCE,
      until: new Date(),
      actor: ADMIN,
      jurisdictions: JURS,
    });
    // All 6 dosed dogs count → clears k=5 → history is shown (matches the map).
    expect(hist.suppressed ?? false).toBe(false);
  }, 30_000);
});

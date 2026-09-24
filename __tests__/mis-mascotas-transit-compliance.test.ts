// Regression test — credential-card vs list status parity for TRANSIT/FOSTER-
// role pets (pre-push review, task #9 follow-up, canon-C2 coherence gap).
//
// P5 note (owner-ia-redesign): /inicio folded away and its carousel cards now
// live on the /mis-mascotas index. This test is fetcher-level (it never
// imported the page), so it stays valid — it pins the invariant both the
// index and the profile rely on: fetchComplianceStatesForPets over a
// foster-inclusive pet set resolves the pet's REAL lnPetStatusFromCompliance
// status ("ok"), never the "registered" fallback.
//
// Historical bug (fixed, then superseded): an earlier /inicio computed
// `complianceByPet` over an owner-role-only pet set, so a transit/foster pet
// never got a compliance entry and fell back to "registered" even when fully
// compliant. The current /inicio (fetchLivePetsForCarouselRanking) and
// /mis-mascotas (statusForPet) both compute compliance over every live pet
// with no role filter, so this class of bug can't recur — this test still
// pins that a foster-role pet resolves its REAL "ok" status through
// fetchComplianceStatesForPets, exactly like /mis-mascotas.
//
// This test seeds a real transit-role (foster) pet in local Postgres, fully
// compliant (rabies/sterilization/microchip all vet-verified — species
// "cat" so the PPP obligation never applies), and asserts:
//   1. fetchPetsForOwner (owner-dashboard) includes the pet — confirms the
//      carousel source has no role filter.
//   2. fetchComplianceStatesForPets resolves the pet's REAL status via
//      lnPetStatusFromCompliance to "ok" — the same computation
//      /mis-mascotas' statusForPet performs.

import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petEvents, pets } from "@/db";
import { fetchComplianceStatesForPets, fetchPetsForOwner } from "@/lib/analytics/owner-dashboard";
import { lnPetStatusFromCompliance } from "@/lib/projections/pet-compliance";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const EMAIL = "inicio-carousel-transit@dim-test.local";
const PASS = "InicioCarouselTransit_2026!";
const TOKEN = "TRNS-TEST-0001";

const VET = { authorRole: "vet" as const, authorVerified: true, authorOrganizationId: null };

let userId: string;
let petId: string;

beforeAll(async () => {
  // Remove any stale fixture from a previous interrupted run.
  const { data: list } = await admin.auth.admin.listUsers();
  const existing = list?.users.find((u) => u.email === EMAIL);
  if (existing) {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.publicToken, TOKEN));
    });
    await admin.auth.admin.deleteUser(existing.id);
  }

  const { data, error } = await createFreshTestUser(admin, {
    email: EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  userId = data.user.id;

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: TOKEN,
      name: "Transit Compliance Test Cat",
      species: "cat", // cat is never PPP (lib/projections/pet-compliance.ts) — keeps
      // the fixture to exactly 3 obligations (rabies, sterilization, microchip).
      status: "active",
    })
    .returning({ id: pets.id });
  petId = pet.id;

  // Transit/foster ownership — a role fetchPetsForOwner does NOT filter on
  // (unlike the owner-role-only fetch the historical bug depended on).
  await db.insert(ownerships).values({ petId, ownerUserId: userId, role: "foster" });

  const occurredAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 1 week ago
  const nextDueAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // 60 days out → "upcoming"
  await db.insert(petEvents).values([
    {
      petId,
      eventType: "vaccination_administered",
      occurredAt,
      payload: { vaccine_name: "Antirrábica", next_due_at: nextDueAt.toISOString() },
      ...VET,
    },
    { petId, eventType: "microchip_implanted", occurredAt, payload: {}, ...VET },
    { petId, eventType: "sterilization_performed", occurredAt, payload: {}, ...VET },
  ]);
});

afterAll(async () => {
  if (petId) {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }
  if (userId) {
    await admin.auth.admin.deleteUser(userId);
  }
});

describe("index cards — transit-pet compliance coverage (canon-C2 fix)", () => {
  it("fetchPetsForOwner includes the transit pet (carousel source has no role filter)", async () => {
    const { pets: ownerPets } = await fetchPetsForOwner(userId);
    expect(ownerPets.some((p) => p.id === petId)).toBe(true);
  });

  it("resolves the SAME real 'ok' status /mis-mascotas shows, not the 'registered' fallback", async () => {
    // Mirrors current /inicio and /mis-mascotas: compliance fetched over the
    // full live pet set (no role filter), so this transit pet gets a real
    // complianceByPet entry.
    const carouselPetIds = (await fetchPetsForOwner(userId)).pets
      .filter((p) => p.status !== "deceased")
      .map((p) => p.id);
    expect(carouselPetIds).toContain(petId);

    const complianceStates = await fetchComplianceStatesForPets(userId, carouselPetIds);
    const compliance = complianceStates.get(petId);
    expect(compliance).toBeDefined();
    expect(compliance?.summary.ok).toBe(compliance?.summary.total);

    const status = lnPetStatusFromCompliance(
      { status: "active", pregnancyStatus: null },
      compliance!,
    );
    // Historically (owner-role-only fetch) this pet had NO complianceByPet
    // entry at all, so carouselStatusOf() fell back to "registered" — the
    // exact string a genuinely-pending pet also produces, which is what made
    // the two surfaces silently disagree instead of erroring loudly.
    expect(status).toBe("ok");
  });
});

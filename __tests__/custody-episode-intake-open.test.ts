// Integration test for custody_episode case opening on org intake.
//
// Mirrors the wiring in createIntakeAction: we don't drive the full server
// action (FormData + supabase auth session would require too much mocking).
// Instead we exercise the contract by emulating the action's tx steps:
//   1. Insert pet + ownership (shelter_custody).
//   2. openCase(custody_episode) inside the same transaction.
//   3. INSERT shelter_intake_recorded with caseId = custodyCase.id.
//   4. Assert: case status=open, caseKind=custody_episode, primaryPetId linked.
//   5. Assert: shelter_intake_recorded event carries the caseId.
//   6. Assert: pet_registered event has NO caseId (not a custody_episode event).
//
// All intake reasons (rescue / surrender / seizure / stray_found / other) open
// a case unconditionally — the lifecycle's opensEvents = shelter_intake_recorded
// with no sub-condition. Close transitions are out of scope.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases, db, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { openCase } from "@/lib/infra/case-helpers";
import { withMutationOverride } from "./_helpers/db-overrides";

const PET_TOKEN = "DIM-CE-INTAKE-1";

let petId: string;
let caseId: string;

beforeAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  });
});

afterAll(async () => {
  if (!petId) return;
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}`);
    if (caseId) await tx.execute(sql`DELETE FROM cases WHERE id = ${caseId}`);
    await tx.execute(sql`DELETE FROM pets WHERE id = ${petId}`);
  });
});

describe("custody_episode opens on org intake (shelter_intake_recorded)", () => {
  it("openCase + shelter_intake_recorded with caseId, all atomic", async () => {
    const now = new Date();

    await db.transaction(async (tx) => {
      const [newPet] = await tx
        .insert(pets)
        .values({
          publicToken: PET_TOKEN,
          name: "CustodyEpisodeIntakeTest",
          species: "dog",
          sex: "unknown",
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "La Plata",
          potentiallyDangerousBreed: false,
        })
        .returning();
      petId = newPet.id;

      // Mirrors createIntakeAction: open custody_episode before event inserts.
      const custodyCase = await openCase(
        {
          kind: "custody_episode",
          primarySubjectKind: "registered_pet",
          primaryPetId: newPet.id,
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "La Plata",
          openedReason: { code: "org_intake", intakeReason: "rescue" },
        },
        tx,
      );
      caseId = custodyCase.id;

      // pet_registered — does NOT carry caseId (not a custody_episode event).
      const registeredPayload = validateEventPayload("pet_registered", {
        name: newPet.name,
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
        jurisdiction_province: "Buenos Aires",
        jurisdiction_locality: "La Plata",
        potentially_dangerous_breed: false,
        acquisition_method: null,
        has_photo: false,
        has_microchip: false,
        custody_kind: "shelter_custody_by_org",
      });
      await tx.insert(petEvents).values({
        petId: newPet.id,
        eventType: "pet_registered",
        occurredAt: now,
        recordedAt: now,
        authorRole: "shelter",
        authorVerified: false,
        payload: registeredPayload,
      });

      // shelter_intake_recorded — carries caseId (the lifecycle opener).
      const intakePayload = validateEventPayload("shelter_intake_recorded", {
        intake_reason: "rescue",
        intake_condition: null,
        rescue_jurisdiction: null,
      });
      await tx.insert(petEvents).values({
        petId: newPet.id,
        eventType: "shelter_intake_recorded",
        occurredAt: now,
        recordedAt: now,
        authorRole: "shelter",
        authorVerified: false,
        payload: intakePayload,
        caseId: custodyCase.id,
      });
    });

    // Assert: case row is open and linked to the new pet.
    const [caseRow] = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
    expect(caseRow).toBeDefined();
    expect(caseRow.status).toBe("open");
    expect(caseRow.caseKind).toBe("custody_episode");
    expect(caseRow.primaryPetId).toBe(petId);
    expect(caseRow.primarySubjectKind).toBe("registered_pet");

    // Assert: shelter_intake_recorded event carries caseId.
    const intakeEvents = await db.select().from(petEvents).where(eq(petEvents.petId, petId));

    const intakeEvent = intakeEvents.find((e) => e.eventType === "shelter_intake_recorded");
    expect(intakeEvent).toBeDefined();
    expect(intakeEvent?.caseId).toBe(caseId);

    // Assert: pet_registered event has no caseId (not part of custody_episode lifecycle).
    const registeredEvent = intakeEvents.find((e) => e.eventType === "pet_registered");
    expect(registeredEvent).toBeDefined();
    expect(registeredEvent?.caseId).toBeNull();
  });

  it("case stays open immediately after intake (close transitions are out of scope)", async () => {
    const [caseRow] = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
    expect(caseRow.status).toBe("open");
    expect(caseRow.closedAt).toBeNull();
    expect(caseRow.closedReason).toBeNull();
  });
});

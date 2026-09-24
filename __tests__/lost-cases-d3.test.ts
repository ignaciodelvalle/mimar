// Integration tests for Fase D3 of the cases system — wiring the
// lost/found flow to the cases layer.
//
// We don't drive the full server actions (they pull from auth, etc.).
// We exercise the contract by emulating what the actions do step by
// step inside a transaction and assert the case + linkage.

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases, db, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { closeCase, openCase } from "@/lib/infra/case-helpers";
import { withMutationOverride } from "./_helpers/db-overrides";

const PET_TOKEN = "DIM-D3-PA1";

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

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "LostCaseTest",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = pet.id;
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}`);
    await tx.execute(sql`DELETE FROM cases WHERE id = ${caseId}`);
    await tx.execute(sql`DELETE FROM pets WHERE id = ${petId}`);
  });
});

describe("D3: lost_pet_episode opens with status_changed(to=lost)", () => {
  it("openCase + status_changed event with case_id, all atomic", async () => {
    const occurredAt = new Date();

    await db.transaction(async (tx) => {
      const caseRow = await openCase(
        {
          kind: "lost_pet_episode",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          openedReason: { code: "pet_marked_lost", petPublicToken: "DIM-D3-PA1", ownerNote: null },
        },
        tx,
      );
      caseId = caseRow.id;

      const payload = validateEventPayload("status_changed", {
        from_status: "active",
        to_status: "lost",
        location_description: null,
        reason: "fixture",
        disclosure_prefs_snapshot: {
          first_name: false,
          phone: false,
          email: false,
          last_location: false,
          finder_form: true,
        },
      });
      await tx.insert(petEvents).values({
        petId,
        eventType: "status_changed",
        occurredAt,
        recordedAt: occurredAt,
        authorRole: "owner",
        payload,
        caseId: caseRow.id,
      });
      await tx
        .update(pets)
        .set({ status: "lost", updatedAt: occurredAt })
        .where(eq(pets.id, petId));
    });

    const [row] = await db
      .select({
        status: cases.status,
        caseKind: cases.caseKind,
        primaryPetId: cases.primaryPetId,
      })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(row.status).toBe("open");
    expect(row.caseKind).toBe("lost_pet_episode");
    expect(row.primaryPetId).toBe(petId);

    const events = await db
      .select({ eventType: petEvents.eventType, caseId: petEvents.caseId })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.caseId, caseId)));
    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe("status_changed");
  });
});

describe("D3: setPetFound parity — closeCase mirror", () => {
  it("closes case with closed_reason=resolved when pet flips lost → active", async () => {
    await db.transaction(async (tx) => {
      const payload = validateEventPayload("status_changed", {
        from_status: "lost",
        to_status: "active",
      });
      await tx.insert(petEvents).values({
        petId,
        eventType: "status_changed",
        occurredAt: new Date(),
        recordedAt: new Date(),
        authorRole: "owner",
        payload,
        caseId,
      });
      await tx.update(pets).set({ status: "active" }).where(eq(pets.id, petId));
      await closeCase({ caseId, reason: "resolved" }, tx);
    });

    const [row] = await db
      .select({ status: cases.status, closedReason: cases.closedReason })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(row.status).toBe("closed");
    expect(row.closedReason).toBe("resolved");
  });
});

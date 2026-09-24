// Integration tests for Fase D4 of the cases system — wiring the
// custody-dispute flow to the cases layer.
//
// ARCH-E additions: sequencing correctness tests (raising event carries
// case_id) and FK rejection tests (bogus case_id rejected by the DB).

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases, db, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { closeCase, openCase } from "@/lib/infra/case-helpers";
import { withMutationOverride } from "./_helpers/db-overrides";
import { expectDbError } from "./_helpers/expect-db-error";

const PET_TOKEN = "DIM-D4-PA1";
// Second pet token for ARCH-E sequencing tests (isolated from D4 lifecycle tests).
const PET_TOKEN_E = "DIM-E-SEQ1";

let petId: string;
let petIdE: string;
let caseId: string;

beforeAll(async () => {
  await withMutationOverride(async (tx) => {
    for (const token of [PET_TOKEN, PET_TOKEN_E]) {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token = ${token}
      )`);
      await tx.execute(sql`DELETE FROM custody_disputes WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token = ${token}
      )`);
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
        SELECT id FROM pets WHERE public_token = ${token}
      )`);
      await tx.execute(sql`DELETE FROM pets WHERE public_token = ${token}`);
    }
  });

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "DisputeCaseTest",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = pet.id;

  const [petE] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN_E,
      name: "DisputeSequencingTest",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petIdE = petE.id;
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    // Clean up ARCH-E pet first (events reference cases; delete events before cases).
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petIdE}`);
    await tx.execute(sql`DELETE FROM custody_disputes WHERE pet_id = ${petIdE}`);
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${petIdE}`);
    await tx.execute(sql`DELETE FROM pets WHERE id = ${petIdE}`);

    // Clean up D4 pet.
    if (caseId) await tx.execute(sql`DELETE FROM cases WHERE id = ${caseId}`);
    await tx.execute(sql`DELETE FROM pets WHERE id = ${petId}`);
  });
});

// ---------------------------------------------------------------------------
// D4 — original openCase / closeCase parity tests (unchanged)
// ---------------------------------------------------------------------------

describe("D4: custody_dispute case opens with the dispute flow", () => {
  it("openCase creates a custody_dispute row for the pet", async () => {
    const caseRow = await openCase({
      kind: "custody_dispute",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      openedReason: { code: "custody_dispute_raised", raisedByRole: "owner" },
    });
    caseId = caseRow.id;
    expect(caseRow.status).toBe("open");
    expect(caseRow.caseKind).toBe("custody_dispute");
  });

  it("resolveDisputeAction parity — closeCase('resolved')", async () => {
    const result = await closeCase({ caseId, reason: "resolved" });
    expect(result?.status).toBe("closed");
    expect(result?.closedReason).toBe("resolved");
  });

  it("withdrawDisputeAction parity — opening a 2nd case then closing as cancelled", async () => {
    // The partial unique index on (primary_pet_id, case_kind) only restricts
    // OPEN cases, so we can open a second once the first is closed.
    const second = await openCase({
      kind: "custody_dispute",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      openedReason: { code: "custody_dispute_raised", raisedByRole: "owner" },
    });
    const closed = await closeCase({ caseId: second.id, reason: "cancelled" });
    expect(closed?.status).toBe("closed");
    expect(closed?.closedReason).toBe("cancelled");
    await db.execute(sql`DELETE FROM cases WHERE id = ${second.id}`);
  });
});

// ---------------------------------------------------------------------------
// ARCH-E (a): raising event carries case_id pointing at the created case
// ---------------------------------------------------------------------------

describe("ARCH-E: custody_dispute_raised event carries case_id", () => {
  it("raising event row has case_id equal to the pre-created custody_dispute case", async () => {
    let raisingEventId: string;
    let disputeCaseId: string;

    await db.transaction(async (tx) => {
      // Step 1: open case first (correct ARCH-E sequence).
      const disputeCase = await openCase(
        {
          kind: "custody_dispute",
          primarySubjectKind: "registered_pet",
          primaryPetId: petIdE,
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "La Plata",
          openedReason: { code: "custody_dispute_raised", raisedByRole: "owner" },
        },
        tx,
      );
      disputeCaseId = disputeCase.id;

      // Step 2: insert the raising event WITH case_id.
      const payload = validateEventPayload("custody_dispute_raised", {
        raised_by_role: "govt",
        // Nil UUID (all zeros) is the standard sentinel; no FK on payload field.
        raised_by_user_id: "00000000-0000-0000-0000-000000000000",
        external_proceeding_reference: null,
        reason: "ARCH-E integration test fixture",
      });
      const [evt] = await tx
        .insert(petEvents)
        .values({
          petId: petIdE,
          eventType: "custody_dispute_raised",
          occurredAt: new Date(),
          recordedAt: new Date(),
          authorRole: "govt",
          authorVerified: true,
          payload,
          caseId: disputeCaseId,
        })
        .returning({ id: petEvents.id, caseId: petEvents.caseId });
      raisingEventId = evt.id;

      // Verify case_id is set immediately inside the transaction.
      expect(evt.caseId).toBe(disputeCaseId);
    });

    // Verify from outside the transaction.
    const [row] = await db
      .select({ id: petEvents.id, caseId: petEvents.caseId })
      .from(petEvents)
      .where(eq(petEvents.id, raisingEventId!));
    expect(row.caseId).toBe(disputeCaseId!);

    // Verify the FK points at a real, open custody_dispute case.
    const [linked] = await db
      .select({ id: cases.id, caseKind: cases.caseKind, status: cases.status })
      .from(cases)
      .where(eq(cases.id, disputeCaseId!));
    expect(linked.caseKind).toBe("custody_dispute");
    expect(linked.status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// ARCH-E (b): FK rejects inserting a pet_event with a bogus case_id
// ---------------------------------------------------------------------------

describe("ARCH-E: pet_events.case_id FK rejects bogus case reference", () => {
  it("inserting a pet_event with a non-existent case_id throws a FK violation", async () => {
    const bogusUuid = "00000000-dead-beef-0000-000000000000";

    await expectDbError(
      db.insert(petEvents).values({
        petId: petIdE,
        eventType: "note_added",
        occurredAt: new Date(),
        recordedAt: new Date(),
        authorRole: "owner",
        payload: { category: "otro", text: "bogus case test" },
        caseId: bogusUuid,
      }),
      // 23503 = foreign_key_violation.
      { code: "23503", constraint: /pet_events_case_id_cases_id_fk/ },
    );
  });
});

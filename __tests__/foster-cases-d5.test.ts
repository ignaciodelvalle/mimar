// Integration tests for Fase D5 of the cases system — wiring the
// foster placement flow to the cases layer.
//
// We exercise the case helpers in the same shape assignFosterAction /
// endFosterAction use them (open + close), plus the closed_reason
// mapping for the end_foster_ui_reason → reason transition.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pets } from "@/db";
import { closeCase, openCase } from "@/lib/infra/case-helpers";
import { withMutationOverride } from "./_helpers/db-overrides";

const PET_TOKEN = "DIM-D5-PA1";

let petId: string;
let firstCaseId: string;
const insertedCaseIds: string[] = [];

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
      name: "FosterCaseTest",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = pet.id;
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    for (const id of insertedCaseIds) {
      await tx.execute(sql`DELETE FROM cases WHERE id = ${id}`);
    }
    await tx.execute(sql`DELETE FROM pets WHERE id = ${petId}`);
  });
});

describe("D5: foster_placement opens on assign", () => {
  it("openCase creates a foster_placement row", async () => {
    const caseRow = await openCase({
      kind: "foster_placement",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId,
      openedReason: {
        code: "foster_placement_assigned",
        actorOrgDisplayName: "Test Refugio",
        expectedWeeks: null,
      },
    });
    firstCaseId = caseRow.id;
    insertedCaseIds.push(caseRow.id);
    expect(caseRow.status).toBe("open");
    expect(caseRow.caseKind).toBe("foster_placement");
  });
});

describe("D5: endFosterAction reason → closed_reason mapping", () => {
  it("'returned' → closed_reason='resolved'", async () => {
    const result = await closeCase({ caseId: firstCaseId, reason: "resolved" });
    expect(result?.status).toBe("closed");
    expect(result?.closedReason).toBe("resolved");
  });

  it("'early_return_by_foster' → closed_reason='cancelled' (new case for the mapping)", async () => {
    const caseRow = await openCase({
      kind: "foster_placement",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId,
      openedReason: {
        code: "foster_placement_assigned",
        actorOrgDisplayName: "Test Refugio",
        expectedWeeks: 4,
      },
    });
    insertedCaseIds.push(caseRow.id);
    const result = await closeCase({ caseId: caseRow.id, reason: "cancelled" });
    expect(result?.closedReason).toBe("cancelled");
  });
});

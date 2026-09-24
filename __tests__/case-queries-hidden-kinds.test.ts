// The kind exclusion, on BOTH queries that depend on it.
//
// findOpenCasesForPetWithCodes — kind-exclusion regression (pet-document-
// redesign privacy fix, REQ-1.1/1.3/1.4).
//
// readCases (the owner face's own query, src/modules/pets/application/read/
// owner-pet-detail-queries.ts) joined this file on 2026-09-10, when
// OwnerPetCasesSection stopped being a bare count and started carrying each
// open case's CAS- code. Its `notInArray` is now the SOLE mechanism between the
// subject of a welfare_denuncia and the code of the case against them, and
// until that day nothing anywhere executed it — the only test that reached
// readCases stubbed it with vi.fn(). The fixture below already seeds exactly
// the three cases the assertion needs on one pet, so the second subject costs
// no new fixture and no new file.
//
// Positive case: an open bite_incident (and other non-excluded kinds) for
// the fixture pet MUST appear in the result.
// Negative case (the explicitly required pair): an open welfare_denuncia
// case AND an open lost_pet_episode case for the SAME pet MUST both return
// zero matching rows — the generic badge/list query owns neither kind.

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases as casesTable, db, pets } from "@/db";
import { openCase } from "@/lib/infra/case-helpers";
import { findOpenCasesForPetWithCodes } from "@/lib/infra/case-queries";
import { readCases } from "@/src/modules/pets/application/read/owner-pet-detail-queries";
import { withMutationOverride } from "./_helpers/db-overrides";

const PET_TOKEN = "DIM-PDR-S1-PET1";

let petId: string;
const insertedCaseIds: string[] = [];

beforeAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`
      DELETE FROM cases WHERE primary_pet_id IN (
        SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
      )
    `);
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  });

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "PDR S1 Pet",
      species: "dog",
      sex: "female",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = pet.id;

  const biteCase = await openCase({
    kind: "bite_incident",
    primarySubjectKind: "registered_pet",
    primaryPetId: petId,
    openedReason: { code: "bite_reported_owner", victimKind: "human", severity: "moderate" },
  });
  insertedCaseIds.push(biteCase.id);

  const welfareCase = await openCase({
    kind: "welfare_denuncia",
    primarySubjectKind: "registered_pet",
    primaryPetId: petId,
    openedReason: {
      code: "welfare_report_citizen",
      referenceCode: "DEN-PDR-S1",
      kind: "neglect",
      severity: "medium",
    },
  });
  insertedCaseIds.push(welfareCase.id);

  const lostCase = await openCase({
    kind: "lost_pet_episode",
    primarySubjectKind: "registered_pet",
    primaryPetId: petId,
    openedReason: {
      code: "pet_marked_lost",
      petPublicToken: null,
      ownerNote: "episodio de prueba",
    },
  });
  insertedCaseIds.push(lostCase.id);
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    for (const id of insertedCaseIds) {
      await tx.execute(sql`UPDATE cases SET welfare_report_id = NULL WHERE id = ${id}`);
      await tx.execute(sql`DELETE FROM cases WHERE id = ${id}`);
    }
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  });
});

describe("findOpenCasesForPetWithCodes — kind exclusion", () => {
  it("positive: includes the open bite_incident case", async () => {
    const rows = await findOpenCasesForPetWithCodes(petId);
    const kinds = rows.map((r) => r.caseKind);
    expect(kinds).toContain("bite_incident");
  });

  it("negative: excludes the open welfare_denuncia case for the same pet", async () => {
    const rows = await findOpenCasesForPetWithCodes(petId);
    const hasWelfare = rows.some((r) => r.caseKind === "welfare_denuncia");
    expect(hasWelfare).toBe(false);
  });

  it("negative: excludes the open lost_pet_episode case for the same pet (single rendering path)", async () => {
    const rows = await findOpenCasesForPetWithCodes(petId);
    const hasLost = rows.some((r) => r.caseKind === "lost_pet_episode");
    expect(hasLost).toBe(false);
  });

  it("scenario: pet is BOTH lost AND has a hidden welfare case — generic list shows neither", async () => {
    const rows = await findOpenCasesForPetWithCodes(petId);
    expect(
      rows.every((r) => r.caseKind !== "welfare_denuncia" && r.caseKind !== "lost_pet_episode"),
    ).toBe(true);
  });
});

describe("readCases — the owner face's own copy of the same exclusion", () => {
  it("seeds a REAL welfare_denuncia, so 'excluded' cannot mean 'never inserted'", async () => {
    // The non-vacuity control for the two assertions below. Both of them are
    // satisfied by a fixture that silently failed to write the denuncia, which
    // is the shape of green that a privacy test must never be able to produce.
    const rows = await db
      .select({ caseKind: casesTable.caseKind, publicCode: casesTable.publicCode })
      .from(casesTable)
      .where(eq(casesTable.primaryPetId, petId));
    expect(rows.map((r) => r.caseKind).sort()).toEqual([
      "bite_incident",
      "lost_pet_episode",
      "welfare_denuncia",
    ]);
  });

  it("lists the bite and ONLY the bite, with its code", async () => {
    const read = await readCases(petId);
    expect(read.openCases.map((c) => c.caseKind)).toEqual(["bite_incident"]);
    // The code is the whole reason this list exists — assert it is really a
    // CAS- code and not an empty string the projection would happily ship.
    expect(read.openCases[0]?.publicCode).toMatch(/^CAS-/);
    // And the count IS the list's length, which the reader now guarantees by
    // construction rather than by a second pass that agrees.
    expect(read.openCount).toBe(read.openCases.length);
    expect(read.openCount).toBe(1);
  });

  it("never hands back the denuncia's own code", async () => {
    // Phrased on the CODE and not on the kind, because the kind is exactly what
    // a leak here would disguise: `welfare_denuncia` is absent from
    // OWNER_PET_CASE_KINDS, so the payload clamps it to `other` and the row
    // arrives wearing a generic label. The code is what cannot be disguised.
    const [denuncia] = await db
      .select({ publicCode: casesTable.publicCode })
      .from(casesTable)
      .where(and(eq(casesTable.primaryPetId, petId), eq(casesTable.caseKind, "welfare_denuncia")));
    expect(denuncia?.publicCode).toMatch(/^CAS-/);
    const read = await readCases(petId);
    expect(read.openCases.map((c) => c.publicCode)).not.toContain(denuncia?.publicCode);
  });
});

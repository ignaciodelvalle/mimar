// Integration tests for CasesRepository.
// Layer: Integration (real local Postgres via Drizzle).
// TDD: RED written first — cases-repository.ts does not exist yet.
//
// Parity requirements (from spec):
//   R1 openCase: insert + public_code CAS-XXXX-XXXX + tx support
//   R2 closeCase: idempotency (closed/merged no-op), missing → null
//   R3 escalateCase: idempotent open-only
//   R4 reopenCase: db-only (no tx), already-open → existing, missing → null
//   R5 findOpenCasesForPet: cap 50, status IN (open, escalated)
//   R6 findOpenCaseForPetAndKind: tx-threaded, LIMIT 1
//   R7 findOpenAdoptionApplicationCase
//   R8 findOpenAdoptionListingCase
//   generateUniqueCasePublicCode: CAS-XXXX-XXXX format, uses executor

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withMutationOverride } from "@/__tests__/_helpers/db-overrides";
import { cases, db, pets } from "@/db";
import { CasesRepository } from "@/src/modules/cases/infrastructure/cases-repository";

const PET_TOKEN_REPO = "DIM-CREPO-PA1";
const PET_TOKEN_REPO2 = "DIM-CREPO-PA2";

let petId: string;
let petId2: string;
const repo = new CasesRepository();

beforeAll(async () => {
  // Clean up from any prior run
  await withMutationOverride(async (tx) => {
    for (const token of [PET_TOKEN_REPO, PET_TOKEN_REPO2]) {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token = ${token}
      )`);
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
        SELECT id FROM pets WHERE public_token = ${token}
      )`);
      await tx.execute(sql`DELETE FROM pets WHERE public_token = ${token}`);
    }
  });

  const [pet1] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN_REPO,
      name: "CasesRepoTest1",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = pet1.id;

  const [pet2] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN_REPO2,
      name: "CasesRepoTest2",
      species: "cat",
      sex: "female",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId2 = pet2.id;
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    for (const token of [PET_TOKEN_REPO, PET_TOKEN_REPO2]) {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token = ${token}
      )`);
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
        SELECT id FROM pets WHERE public_token = ${token}
      )`);
      await tx.execute(sql`DELETE FROM pets WHERE public_token = ${token}`);
    }
  });
});

// ---------------------------------------------------------------------------
// R1: openCase
// ---------------------------------------------------------------------------

describe("CasesRepository.openCase", () => {
  it("inserts a case row with status=open and CAS-XXXX-XXXX public_code", async () => {
    const result = await repo.openCase({
      kind: "lost_pet_episode",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId,
      openedReason: {
        code: "pet_marked_lost",
        petPublicToken: null,
        ownerNote: "reportada como perdida",
      },
    });

    expect(result.status).toBe("open");
    expect(result.caseKind).toBe("lost_pet_episode");
    expect(result.primaryPetId).toBe(petId);
    expect(result.publicCode).toMatch(/^CAS-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(result.jurisdictionCountry).toBe("AR"); // default

    // Cleanup
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM cases WHERE id = ${result.id}`);
    });
  });

  it("uses the provided executor (tx) for the insert", async () => {
    let insertedId: string | undefined;

    await db
      .transaction(async (tx) => {
        const result = await repo.openCase(
          {
            kind: "bite_incident",
            primarySubjectKind: "registered_pet",
            primaryPetId: petId,
            openedReason: {
              code: "bite_reported_owner",
              victimKind: "human",
              severity: "moderate",
            },
          },
          tx,
        );
        insertedId = result.id;
        expect(result.caseKind).toBe("bite_incident");
        // Roll back to leave no side effects
        await tx.rollback();
      })
      .catch(() => {
        // Expected rollback
      });

    // After rollback, case should not exist
    if (insertedId) {
      const [row] = await db.select().from(cases).where(eq(cases.id, insertedId)).limit(1);
      expect(row).toBeUndefined();
    }
  });

  it("defaults jurisdictionCountry to AR when not provided", async () => {
    const result = await repo.openCase({
      kind: "welfare_denuncia",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId,
      openedReason: {
        code: "welfare_report_citizen",
        referenceCode: "DEN-TEST-0001",
        kind: "neglect",
        severity: "medium",
      },
    });
    expect(result.jurisdictionCountry).toBe("AR");
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM cases WHERE id = ${result.id}`);
    });
  });
});

// ---------------------------------------------------------------------------
// R2: closeCase (idempotency)
// ---------------------------------------------------------------------------

describe("CasesRepository.closeCase", () => {
  it("closes an open case and returns updated row", async () => {
    const opened = await repo.openCase({
      kind: "lost_pet_episode",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId,
      openedReason: { code: "pet_marked_lost", petPublicToken: null, ownerNote: "closeCase" },
    });

    const closed = await repo.closeCase({
      caseId: opened.id,
      reason: "resolved",
      closedByUserId: null,
    });

    expect(closed).not.toBeNull();
    expect(closed?.status).toBe("closed");
    expect(closed?.closedReason).toBe("resolved");
    expect(closed?.closedAt).toBeInstanceOf(Date);

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM cases WHERE id = ${opened.id}`);
    });
  });

  it("returns existing row unchanged when case is already closed (idempotency)", async () => {
    const opened = await repo.openCase({
      kind: "lost_pet_episode",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId,
      openedReason: { code: "pet_marked_lost", petPublicToken: null, ownerNote: "idempotency" },
    });

    const first = await repo.closeCase({ caseId: opened.id, reason: "cancelled" });
    const second = await repo.closeCase({ caseId: opened.id, reason: "resolved" });

    expect(second?.status).toBe("closed");
    // Idempotency: second call returns the already-closed row, unchanged
    expect(second?.id).toBe(first?.id);
    expect(second?.closedReason).toBe("cancelled"); // not overwritten to 'resolved'

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM cases WHERE id = ${opened.id}`);
    });
  });

  it("returns null for missing case id", async () => {
    const result = await repo.closeCase({
      caseId: "00000000-0000-0000-0000-000000000000",
      reason: "resolved",
    });
    expect(result).toBeNull();
  });

  it("is atomic under concurrent closers: exactly one wins (WAVE D3-#2)", async () => {
    const opened = await repo.openCase({
      kind: "lost_pet_episode",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId,
      openedReason: {
        code: "pet_marked_lost",
        petPublicToken: null,
        ownerNote: "concurrent close race",
      },
    });

    // Two closers hit the same OPEN case at once, each in its own transaction
    // with a distinct reason. Each runs the full closeCase (pre-read sees
    // "open", then the guarded UPDATE). With the status guard folded into the
    // UPDATE, only the first committer's UPDATE matches a row; the loser's
    // UPDATE matches zero rows and re-reads the winner's row. WITHOUT the guard
    // both UPDATEs would fire, each returning ITS OWN reason — so the
    // "exactly one call returns its own reason" invariant is what proves
    // atomicity.
    const [a, b] = await Promise.all([
      db.transaction((tx) =>
        repo.closeCase(
          { caseId: opened.id, reason: "resolved", closedByUserId: null },
          tx as Parameters<typeof repo.closeCase>[1],
        ),
      ),
      db.transaction((tx) =>
        repo.closeCase(
          { caseId: opened.id, reason: "cancelled", closedByUserId: null },
          tx as Parameters<typeof repo.closeCase>[1],
        ),
      ),
    ]);

    const selfReported = [a?.closedReason === "resolved", b?.closedReason === "cancelled"].filter(
      Boolean,
    ).length;
    expect(selfReported).toBe(1);

    // The persisted row reflects a single winner, and both calls agree on it.
    const [persisted] = await db.select().from(cases).where(eq(cases.id, opened.id)).limit(1);
    expect(persisted.status).toBe("closed");
    expect(["resolved", "cancelled"]).toContain(persisted.closedReason);
    expect(a?.closedReason).toBe(persisted.closedReason);
    expect(b?.closedReason).toBe(persisted.closedReason);

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM cases WHERE id = ${opened.id}`);
    });
  });
});

// ---------------------------------------------------------------------------
// R3: escalateCase (idempotent, open-only)
// ---------------------------------------------------------------------------

describe("CasesRepository.escalateCase", () => {
  it("escalates an open case", async () => {
    const opened = await repo.openCase({
      kind: "welfare_denuncia",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId,
      openedReason: {
        code: "welfare_report_citizen",
        referenceCode: "DEN-TEST-ESC",
        kind: "neglect",
        severity: "medium",
      },
    });

    const escalated = await repo.escalateCase(opened.id);
    expect(escalated?.status).toBe("escalated");

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM cases WHERE id = ${opened.id}`);
    });
  });

  it("returns existing row unchanged when already escalated (idempotency)", async () => {
    const opened = await repo.openCase({
      kind: "welfare_denuncia",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId,
      openedReason: {
        code: "welfare_report_citizen",
        referenceCode: "DEN-TEST-DBL",
        kind: "neglect",
        severity: "medium",
      },
    });

    const first = await repo.escalateCase(opened.id);
    const second = await repo.escalateCase(opened.id);
    expect(second?.status).toBe("escalated");
    expect(second?.id).toBe(first?.id);

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM cases WHERE id = ${opened.id}`);
    });
  });

  it("returns null for missing case id", async () => {
    const result = await repo.escalateCase("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R4: reopenCase (db-only, no tx param)
// ---------------------------------------------------------------------------

describe("CasesRepository.reopenCase", () => {
  it("reopens a closed case", async () => {
    const opened = await repo.openCase({
      kind: "adoption_listing",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId,
      openedReason: { code: "adoption_listing_opened" },
    });
    await repo.closeCase({ caseId: opened.id, reason: "resolved" });
    const reopened = await repo.reopenCase(opened.id);

    expect(reopened?.status).toBe("open");
    expect(reopened?.closedReason).toBeNull();
    expect(reopened?.closedAt).toBeNull();

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM cases WHERE id = ${opened.id}`);
    });
  });

  it("returns existing row when already open", async () => {
    const opened = await repo.openCase({
      kind: "adoption_listing",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId,
      openedReason: { code: "adoption_listing_opened" },
    });
    const result = await repo.reopenCase(opened.id);
    expect(result?.status).toBe("open");
    expect(result?.id).toBe(opened.id);

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM cases WHERE id = ${opened.id}`);
    });
  });

  it("returns null for missing case id", async () => {
    const result = await repo.reopenCase("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R5: findOpenCasesForPet
// ---------------------------------------------------------------------------

describe("CasesRepository.findOpenCasesForPet", () => {
  it("returns open and escalated cases for a pet, capped at 50", async () => {
    const opened = await repo.openCase({
      kind: "lost_pet_episode",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId2,
      openedReason: { code: "pet_marked_lost", petPublicToken: null, ownerNote: "findOpenCases" },
    });

    const results = await repo.findOpenCasesForPet(petId2);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.id === opened.id)).toBe(true);
    expect(results.every((r) => r.caseKind !== undefined)).toBe(true);

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM cases WHERE id = ${opened.id}`);
    });
  });

  it("does not return closed cases", async () => {
    const opened = await repo.openCase({
      kind: "bite_incident",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId2,
      openedReason: { code: "bite_reported_owner", victimKind: "human", severity: "moderate" },
    });
    await repo.closeCase({ caseId: opened.id, reason: "resolved" });

    const results = await repo.findOpenCasesForPet(petId2);
    expect(results.some((r) => r.id === opened.id)).toBe(false);

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM cases WHERE id = ${opened.id}`);
    });
  });
});

// ---------------------------------------------------------------------------
// R6: findOpenCaseForPetAndKind
// ---------------------------------------------------------------------------

describe("CasesRepository.findOpenCaseForPetAndKind", () => {
  it("returns the open case for (pet, kind)", async () => {
    const opened = await repo.openCase({
      kind: "welfare_denuncia",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId2,
      openedReason: {
        code: "welfare_report_citizen",
        referenceCode: "DEN-TEST-FIND",
        kind: "neglect",
        severity: "medium",
      },
    });

    const found = await repo.findOpenCaseForPetAndKind(petId2, "welfare_denuncia");
    expect(found).not.toBeNull();
    expect(found?.id).toBe(opened.id);

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM cases WHERE id = ${opened.id}`);
    });
  });

  it("returns null when no open case exists for (pet, kind)", async () => {
    const found = await repo.findOpenCaseForPetAndKind(petId2, "custody_dispute");
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R7: findOpenAdoptionApplicationCase
// ---------------------------------------------------------------------------

describe("CasesRepository.findOpenAdoptionApplicationCase", () => {
  it("returns null when no matching adoption_application case exists", async () => {
    const found = await repo.findOpenAdoptionApplicationCase(
      petId,
      "00000000-0000-0000-0000-000000000001",
    );
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R8: findOpenAdoptionListingCase
// ---------------------------------------------------------------------------

describe("CasesRepository.findOpenAdoptionListingCase", () => {
  it("returns null when no matching adoption_listing case exists", async () => {
    const found = await repo.findOpenAdoptionListingCase(
      petId,
      "00000000-0000-0000-0000-000000000002",
    );
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// generateUniqueCasePublicCode
// ---------------------------------------------------------------------------

describe("CasesRepository.generateUniqueCasePublicCode", () => {
  it("returns a code matching CAS-XXXX-XXXX format", async () => {
    const code = await repo.generateUniqueCasePublicCode();
    expect(code).toMatch(/^CAS-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("returns a different code on subsequent calls (not hardcoded)", async () => {
    const codes = await Promise.all([
      repo.generateUniqueCasePublicCode(),
      repo.generateUniqueCasePublicCode(),
      repo.generateUniqueCasePublicCode(),
    ]);
    // All valid format
    for (const code of codes) {
      expect(code).toMatch(/^CAS-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    }
    // At least 2 distinct values (astronomically unlikely to collide all 3)
    const unique = new Set(codes);
    expect(unique.size).toBeGreaterThanOrEqual(2);
  });
});

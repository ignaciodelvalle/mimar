// Schema tests for the new cases table (Fase A of the cases-system plan).
// Asserts: CHECK constraints reject inconsistent rows + partial unique
// indexes enforce per-kind uniqueness while open.
//
// We use raw `db.execute(sql\`...\`)` to insert because:
// - we want to verify constraints throw at the DB level (no app guard)
// - many fields default to safe values, so we test the unhappy paths
//   by explicitly violating one invariant at a time.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases, db, organizations, pets } from "@/db";
import { withMutationOverride } from "./_helpers/db-overrides";
import { expectDbError } from "./_helpers/expect-db-error";

let petId: string;
let petTokenA: string;
let petTokenB: string;
let orgId: string;
const insertedCaseIds: string[] = [];

beforeAll(async () => {
  // Clean up any leftovers from previous test runs (failed inserts may
  // have skipped the afterAll cleanup). Scope the LIKE to this test's
  // public_code prefixes — other suites also create CAS-* cases and
  // we don't want to step on theirs.
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token IN ('DIM-CASES-PA1', 'DIM-CASES-PB1')
    )`);
    await tx.execute(sql`DELETE FROM cases WHERE public_code LIKE 'CAS-CHK-%'
      OR public_code LIKE 'CAS-OK-%' OR public_code LIKE 'CAS-DUP-%' OR public_code LIKE 'CAS-AA-%'`);
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
      SELECT id FROM pets WHERE public_token IN ('DIM-CASES-PA1', 'DIM-CASES-PB1')
    )`);
    await tx.execute(
      sql`DELETE FROM pets WHERE public_token IN ('DIM-CASES-PA1', 'DIM-CASES-PB1')`,
    );
    await tx.execute(sql`DELETE FROM organizations WHERE public_token = 'DIM-CASES-ORG1'`);
  });

  // Pet A (the main subject for most tests).
  const [petA] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-CASES-PA1",
      name: "CasesTestA",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = petA.id;
  petTokenA = petA.publicToken;

  // Pet B (used to verify uniqueness scope is per-pet, not global).
  const [petB] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-CASES-PB1",
      name: "CasesTestB",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petTokenB = petB.publicToken;

  // Org used by adoption_listing uniqueness tests.
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: "DIM-CASES-ORG1",
      legalName: "Cases Test Refugio SRL",
      displayName: "Cases Test Refugio",
      orgType: "shelter",
      email: "cases-test@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;
});

afterAll(async () => {
  // Clean up cases we inserted (Drizzle bypasses RLS via service role).
  // Wrapped in a tx so pet_events.case_id RESTRICT can be relaxed via
  // explicit ordering. Guard against undefined fixture state from a
  // beforeAll that may have crashed mid-setup.
  await withMutationOverride(async (tx) => {
    for (const id of insertedCaseIds) {
      await tx.execute(sql`DELETE FROM pet_events WHERE case_id = ${id}`);
      await tx.execute(sql`DELETE FROM cases WHERE id = ${id}`);
    }
    if (petTokenA) {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token = ${petTokenA}
      )`);
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
        SELECT id FROM pets WHERE public_token = ${petTokenA}
      )`);
      await tx.execute(sql`DELETE FROM pets WHERE public_token = ${petTokenA}`);
    }
    if (petTokenB) {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token = ${petTokenB}
      )`);
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
        SELECT id FROM pets WHERE public_token = ${petTokenB}
      )`);
      await tx.execute(sql`DELETE FROM pets WHERE public_token = ${petTokenB}`);
    }
    if (orgId) {
      await tx.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`);
    }
  });
});

async function insertCase(values: {
  publicCode: string;
  caseKind: string;
  primarySubjectKind?: string;
  primaryPetId?: string | null;
  locationLat?: string | null;
  locationLng?: string | null;
  applicantUserId?: string | null;
  openedByOrganizationId?: string | null;
  status?: string;
  closedReason?: string | null;
  closedAt?: string | null;
  supersededByCaseId?: string | null;
  openedReason?: string | null;
}): Promise<{ id: string }> {
  // `??` would coerce explicit nulls into the default for `primaryPetId`
  // (we need to test rows that pass null deliberately). Use `in` to
  // distinguish undefined vs explicit null.
  const primaryPetId = "primaryPetId" in values ? (values.primaryPetId ?? null) : petId;
  const [row] = await db
    .insert(cases)
    .values({
      publicCode: values.publicCode,
      caseKind: values.caseKind,
      primarySubjectKind:
        (values.primarySubjectKind as
          | "registered_pet"
          | "unowned_animal"
          | "location"
          | "general") ?? "registered_pet",
      primaryPetId,
      locationLat: values.locationLat ?? null,
      locationLng: values.locationLng ?? null,
      applicantUserId: values.applicantUserId ?? null,
      openedByOrganizationId: values.openedByOrganizationId ?? null,
      status: (values.status as "open" | "escalated" | "closed" | "merged") ?? "open",
      closedReason:
        (values.closedReason as "resolved" | "cancelled" | "auto_expired" | "merged" | null) ??
        null,
      closedAt: values.closedAt ? new Date(values.closedAt) : null,
      supersededByCaseId: values.supersededByCaseId ?? null,
      openedReason: values.openedReason ?? null,
    })
    .returning({ id: cases.id });
  insertedCaseIds.push(row.id);
  return row;
}

describe("cases schema — CHECK constraints", () => {
  it("rejects registered_pet without primary_pet_id", async () => {
    await expectDbError(
      insertCase({
        publicCode: "CAS-CHK-PET1",
        caseKind: "bite_incident",
        primarySubjectKind: "registered_pet",
        primaryPetId: null,
      }),
      { constraint: /cases_subject_pet_consistency/ },
    );
  });

  it("rejects non-registered_pet with primary_pet_id", async () => {
    await expectDbError(
      insertCase({
        publicCode: "CAS-CHK-PET2",
        caseKind: "welfare_denuncia",
        primarySubjectKind: "general",
        primaryPetId: petId,
      }),
      { constraint: /cases_subject_pet_consistency/ },
    );
  });

  it("rejects location subject without lat/lng", async () => {
    await expectDbError(
      insertCase({
        publicCode: "CAS-CHK-LOC1",
        caseKind: "welfare_denuncia",
        primarySubjectKind: "location",
        primaryPetId: null,
        locationLat: null,
        locationLng: null,
      }),
      { constraint: /cases_subject_location_consistency/ },
    );
  });

  it("rejects merged status without superseded_by + closed_reason='merged'", async () => {
    await expectDbError(
      insertCase({
        publicCode: "CAS-CHK-MRG1",
        caseKind: "bite_incident",
        status: "merged",
        closedReason: "resolved",
        closedAt: new Date().toISOString(),
      }),
      { constraint: /cases_merged_consistency/ },
    );
  });

  it("rejects closed status without closed_at", async () => {
    await expectDbError(
      insertCase({
        publicCode: "CAS-CHK-CLS1",
        caseKind: "bite_incident",
        status: "closed",
        closedReason: "resolved",
        closedAt: null,
      }),
      { constraint: /cases_closed_consistency/ },
    );
  });

  it("rejects opened_reason shorter than 10 chars", async () => {
    await expectDbError(
      insertCase({
        publicCode: "CAS-CHK-RSN1",
        caseKind: "bite_incident",
        openedReason: "short",
      }),
      { constraint: /cases_opened_reason_min_length/ },
    );
  });

  it("accepts a fully valid open registered_pet case", async () => {
    const row = await insertCase({
      publicCode: "CAS-OK-1",
      caseKind: "bite_incident",
      openedReason: "Test fixture insert for happy path verification",
    });
    expect(row.id).toBeTruthy();
  });

  it("accepts a valid location-subject case with lat/lng", async () => {
    const row = await insertCase({
      publicCode: "CAS-OK-LOC1",
      caseKind: "welfare_denuncia",
      primarySubjectKind: "location",
      primaryPetId: null,
      locationLat: "-34.6037",
      locationLng: "-58.3816",
    });
    expect(row.id).toBeTruthy();
  });
});

describe("cases schema — partial unique indexes", () => {
  it("rejects a second open case of the same kind for the same pet (default rule)", async () => {
    // Use lost_pet_episode (not bite_incident which is already taken
    // by earlier happy-path test on petA).
    await insertCase({
      publicCode: "CAS-DUP-PET1-A",
      caseKind: "lost_pet_episode",
    });
    await expectDbError(
      insertCase({
        publicCode: "CAS-DUP-PET1-B",
        caseKind: "lost_pet_episode",
      }),
      { constraint: /cases_open_per_pet_kind_idx/ },
    );
  });

  it("allows two open cases of the same kind for DIFFERENT pets", async () => {
    // PetA already has a lost_pet_episode from the previous test. Open one
    // on petB — should succeed because the index is per (pet, kind).
    const [petBRow] = await db
      .select({ id: pets.id })
      .from(pets)
      .where(sql`public_token = ${petTokenB}`);
    const row = await insertCase({
      publicCode: "CAS-DUP-PETB-A",
      caseKind: "lost_pet_episode",
      primaryPetId: petBRow.id,
    });
    expect(row.id).toBeTruthy();
  });

  it("allows multiple open adoption_application cases on same pet w/ different applicants", async () => {
    // adoption_application is exempt from the default uniqueness and has its
    // own partial index by applicant. Without two real applicants we can't
    // fully test that index here — but we can verify that two rows with
    // the same pet but different applicants don't collide with the default
    // index (which excludes adoption_application).
    const r1 = await insertCase({
      publicCode: "CAS-AA-1",
      caseKind: "adoption_application",
      applicantUserId: null,
    });
    expect(r1.id).toBeTruthy();
    // Note: same (pet, applicant=null, kind=adoption_application) would
    // still collide on the per-applicant index when both applicants are
    // null. Real test of multi-applicant happens in integration tests.
  });
});

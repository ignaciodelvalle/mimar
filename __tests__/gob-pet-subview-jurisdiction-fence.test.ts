// Jurisdictional-fence leak fix — loadGobPetSubView open-cases scoping (task #59).
//
// THE LEAK (fresh-context security review): a govt operator who legitimately
// reaches a pet through an IN-SCOPE welfare nexus saw, in the pet sub-view's
// "Casos abiertos" list, EVERY open case where the pet is primary — including
// cases in provinces (and sibling barrios) the operator does NOT govern. The
// case detail is separately gated (clicking 404s), but the existence + public
// code + kind + open-date already leaked cross-fence, contradicting invariant #6.
//
// THE PROOF (real Postgres, real SQL — no mocks): a pet with three open cases —
// one IN scope (CABA/Palermo), one out of PROVINCE (Salta), one SIBLING barrio
// (CABA/Almagro) — is loaded as:
//   - a Palermo-scoped govt operator → payload carries ONLY the CABA/Palermo case;
//   - an admin (universal) → payload carries ALL THREE (admin is never fenced).
// The in-scope case doubles as the linking record that opens the gate, so the
// operator legitimately reaches the pet; the fence applies to the LIST it sees.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pets } from "@/db";
import { openCase } from "@/lib/infra/case-helpers";
import { loadGobPetSubView } from "@/lib/infra/gob-pet-subview";
import { withMutationOverride } from "./_helpers/db-overrides";

const PET_TOKEN = "DIM-FENCE-59-PET";

// Govt operator scoped to a single CABA barrio (Palermo). A barrio-specific
// assignment stays exact-match — it must NOT subsume sibling barrios.
const GOVT_PALERMO = {
  profile: { id: "test-govt-59", role: "govt" as const },
  jurisdictions: [{ province: "CABA", locality: "Palermo" }],
  user: { id: "test-govt-59" },
};
const ADMIN = {
  profile: { id: "test-admin-59", role: "admin" as const },
  jurisdictions: [] as { province: string; locality: string }[],
  user: { id: "test-admin-59" },
};

let petId: string;
const insertedCaseIds: string[] = [];

async function scrub() {
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
}

beforeAll(async () => {
  await scrub();

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "Fence Fixture",
      species: "dog",
      sex: "male",
      potentiallyDangerousBreed: false,
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Palermo",
    })
    .returning();
  petId = pet.id;

  // Distinct kinds per case: a partial unique index (cases_open_per_pet_kind_idx)
  // forbids two OPEN cases of the SAME kind for one pet. All three kinds are
  // non-excluded, so kind-filtering never masks the jurisdiction assertion.

  // In-scope (CABA/Palermo) — the linking record that opens the gate AND a case
  // the Palermo operator is entitled to see.
  const inScopeCase = await openCase({
    kind: "bite_incident",
    primarySubjectKind: "registered_pet",
    primaryPetId: petId,
    jurisdictionProvince: "CABA",
    jurisdictionLocality: "Palermo",
    openedReason: { code: "bite_reported_owner", victimKind: "human", severity: "moderate" },
  });
  insertedCaseIds.push(inScopeCase.id);

  // Out of PROVINCE (Salta) — must NOT leak to the CABA operator.
  const outOfProvinceCase = await openCase({
    kind: "microchip_remediation",
    primarySubjectKind: "registered_pet",
    primaryPetId: petId,
    jurisdictionProvince: "Salta",
    jurisdictionLocality: "Salta",
    openedReason: {
      code: "microchip_replaced",
      reason: "duplicate_detected",
      duplicateDetected: false,
    },
  });
  insertedCaseIds.push(outOfProvinceCase.id);

  // SIBLING barrio (CABA/Almagro) — same province, different barrio. A
  // barrio-scoped operator must NOT see it (no whole-province subsumption).
  const siblingBarrioCase = await openCase({
    kind: "outbreak_investigation",
    primarySubjectKind: "registered_pet",
    primaryPetId: petId,
    jurisdictionProvince: "CABA",
    jurisdictionLocality: "Almagro",
    openedReason: {
      code: "outbreak_investigation_manual",
      diseaseCode: "rabia",
      note: "fixture fence #59",
    },
  });
  insertedCaseIds.push(siblingBarrioCase.id);
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    for (const id of insertedCaseIds) {
      await tx.execute(sql`UPDATE cases SET welfare_report_id = NULL WHERE id = ${id}`);
      await tx.execute(sql`DELETE FROM cases WHERE id = ${id}`);
    }
  });
  await scrub();
});

describe("loadGobPetSubView — open-cases jurisdiction fence (task #59)", () => {
  it("govt (Palermo): openCases carries ONLY the in-scope CABA/Palermo case", async () => {
    const res = await loadGobPetSubView(GOVT_PALERMO, PET_TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Exactly one case, and it is the in-scope one.
    expect(res.pet.openCases).toHaveLength(1);
    expect(res.pet.openCases[0]?.id).toBe(insertedCaseIds[0]);
  });

  it("govt (Palermo): the out-of-PROVINCE (Salta) case is EXCLUDED from the payload", async () => {
    const res = await loadGobPetSubView(GOVT_PALERMO, PET_TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = res.pet.openCases.map((c) => c.id);
    expect(ids).not.toContain(insertedCaseIds[1]);
  });

  it("govt (Palermo): the SIBLING-barrio (CABA/Almagro) case is EXCLUDED from the payload", async () => {
    const res = await loadGobPetSubView(GOVT_PALERMO, PET_TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = res.pet.openCases.map((c) => c.id);
    expect(ids).not.toContain(insertedCaseIds[2]);
  });

  it("admin (universal): openCases carries ALL THREE cases — admin is never fenced", async () => {
    const res = await loadGobPetSubView(ADMIN, PET_TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = res.pet.openCases.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(insertedCaseIds));
    expect(res.pet.openCases).toHaveLength(3);
  });
});

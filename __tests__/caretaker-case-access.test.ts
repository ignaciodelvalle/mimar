// A caretaker cannot read the pet's cases — and must be TOLD so.
//
// THE NON-CAPABILITY IS DELIBERATE (design F2, accepted by the PO for v1):
// `can_read_case` grants the subject-pet branch only to `role='owner'`, and
// `lib/infra/case-access.ts` mirrors it. Widening a SECURITY DEFINER function
// that also governs welfare denuncias — where the wrong read is a serious harm
// — is a separate decision with its own review.
//
// WHAT IS NOT ACCEPTABLE is how the limitation SURFACED. A caretaker sees
// LostCaseBlock and the open-cases badges on the pet they are caring for; every
// one of those links landed on notFound(). The spec says it in as many words:
// an explicit "no disponible para cuidadores", never a 404 a person discovers
// by clicking. That needs a predicate the case page can ask, and this is it.
//
// Against a real database: it is a JOIN over `ownerships` with a lifecycle
// filter, which is exactly the shape a mock gets wrong.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, pets, profiles } from "@/db";
import { holdsActiveCaretakerRow } from "@/lib/infra/case-access";

const PET_TOKEN = "DIM-CGCA-0001";
const OTHER_PET_TOKEN = "DIM-CGCA-0002";
const TITULAR_ID = "0cae7a13-4444-4000-8000-000000000001";
const CARETAKER_ID = "0cae7a13-4444-4000-8000-000000000002";
const EX_CARETAKER_ID = "0cae7a13-4444-4000-8000-000000000003";
const FOSTER_ID = "0cae7a13-4444-4000-8000-000000000004";
const STRANGER_ID = "0cae7a13-4444-4000-8000-000000000005";

let petId: string;
let otherPetId: string;

async function cleanup(): Promise<void> {
  await db.execute(
    sql`DELETE FROM ownerships WHERE pet_id IN (SELECT id FROM pets WHERE public_token IN (${PET_TOKEN}, ${OTHER_PET_TOKEN}))`,
  );
  await db.execute(sql`DELETE FROM pets WHERE public_token IN (${PET_TOKEN}, ${OTHER_PET_TOKEN})`);
  await db.execute(
    sql`DELETE FROM profiles WHERE id IN (${TITULAR_ID}::uuid, ${CARETAKER_ID}::uuid, ${EX_CARETAKER_ID}::uuid, ${FOSTER_ID}::uuid, ${STRANGER_ID}::uuid)`,
  );
}

beforeAll(async () => {
  await cleanup();
  await db.insert(profiles).values([
    { id: TITULAR_ID, displayName: "Titular Caso", role: "owner" },
    { id: CARETAKER_ID, displayName: "Cuidadora Caso", role: "owner" },
    { id: EX_CARETAKER_ID, displayName: "Ex Cuidadora Caso", role: "owner" },
    { id: FOSTER_ID, displayName: "Transitante Caso", role: "owner" },
    { id: STRANGER_ID, displayName: "Ajena Caso", role: "owner" },
  ]);
  const [pet] = await db
    .insert(pets)
    .values({ publicToken: PET_TOKEN, name: "Pampa Caso", species: "dog" })
    .returning({ id: pets.id });
  petId = pet.id;
  const [other] = await db
    .insert(pets)
    .values({ publicToken: OTHER_PET_TOKEN, name: "Otra Caso", species: "cat" })
    .returning({ id: pets.id });
  otherPetId = other.id;

  await db.insert(ownerships).values([
    { petId, ownerUserId: TITULAR_ID, role: "owner", startedAt: new Date("2026-01-01") },
    { petId, ownerUserId: CARETAKER_ID, role: "caretaker", startedAt: new Date("2026-08-01") },
    {
      petId,
      ownerUserId: EX_CARETAKER_ID,
      role: "caretaker",
      startedAt: new Date("2026-05-01"),
      endedAt: new Date("2026-06-01"),
    },
    { petId, ownerUserId: FOSTER_ID, role: "foster", startedAt: new Date("2026-07-01") },
    {
      petId: otherPetId,
      ownerUserId: CARETAKER_ID,
      role: "owner",
      startedAt: new Date("2026-01-01"),
    },
  ]);
});

afterAll(cleanup);

describe("holdsActiveCaretakerRow", () => {
  it("is true for the person currently caring for the pet", async () => {
    expect(await holdsActiveCaretakerRow(petId, CARETAKER_ID)).toBe(true);
  });

  it("is FALSE once the arrangement ended — an ex-caretaker is a stranger again", async () => {
    // The whole grant lifecycle turns on this: `ended_at` closes the row and
    // the person stops holding anything. A predicate that ignored it would keep
    // explaining a case to somebody who no longer has any relationship to the
    // animal.
    expect(await holdsActiveCaretakerRow(petId, EX_CARETAKER_ID)).toBe(false);
  });

  it("is false for the titular — they can READ the case, so they never reach this branch", async () => {
    expect(await holdsActiveCaretakerRow(petId, TITULAR_ID)).toBe(false);
  });

  it("is false for a foster — a different role with a different answer", async () => {
    // `can_read_case` has its own foster branch. Answering "true" here would
    // hand a foster the caretaker's explanation instead of their real access.
    expect(await holdsActiveCaretakerRow(petId, FOSTER_ID)).toBe(false);
  });

  it("is false for somebody with no row on this pet", async () => {
    expect(await holdsActiveCaretakerRow(petId, STRANGER_ID)).toBe(false);
  });

  it("does not leak across pets — caring for A says nothing about B", async () => {
    // The same person is the OWNER of another pet. A predicate that forgot the
    // pet id would call them a caretaker of everything.
    expect(await holdsActiveCaretakerRow(otherPetId, CARETAKER_ID)).toBe(false);
  });

  it("is false for a null viewer (anonymous)", async () => {
    expect(await holdsActiveCaretakerRow(petId, null)).toBe(false);
  });

  it("is false for a null pet (a case with no subject pet)", async () => {
    expect(await holdsActiveCaretakerRow(null, CARETAKER_ID)).toBe(false);
  });
});

describe("the fixture is real — non-vacuity", () => {
  it("the caretaker row this file depends on actually exists and is open", async () => {
    const rows = await db
      .select({ role: ownerships.role, endedAt: ownerships.endedAt })
      .from(ownerships)
      .where(eq(ownerships.ownerUserId, CARETAKER_ID));
    expect(rows.some((r) => r.role === "caretaker" && r.endedAt === null)).toBe(true);
  });
});

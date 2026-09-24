// Who hears "somebody found your pet".
//
// THE REGRESSION NET. Until custodia-temporal this was six lines inline in
// app/(public)/p/[publicToken]/encontre/action.ts (ROUTE-1, audit 2026-08-04)
// picking exactly ONE recipient: titular, else the institution holding custody,
// else whoever is caring for the animal. Extracting it is only safe if the
// no-caretaker answer is unchanged, so the first four cases below are that
// ranking, restated: same order, same single winner, same "no active owner"
// refusal. Everything after them is the new behaviour.
//
// Against a real database on purpose. The predicate is a JOIN over `ownerships`
// with a lifecycle filter, and the bug it replaced (a bare `.limit(1)` with no
// role filter handing the finder's phone number to a foster instead of the
// titular) was a database-ordering bug that no mock would have produced.

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db, organizations, ownerships, pets, profiles } from "@/db";
import { resolveLostPetAlertRecipients } from "@/lib/infra/pet-alert-recipients";

const PET_TOKEN = "DIM-ALRT-0001";
const TITULAR_ID = "0cae7a13-3333-4000-8000-000000000001";
const CARETAKER_ID = "0cae7a13-3333-4000-8000-000000000002";
const FOSTER_ID = "0cae7a13-3333-4000-8000-000000000003";
const SHELTER_USER_ID = "0cae7a13-3333-4000-8000-000000000004";
const ORG_ID = "0cae7a13-3333-4000-8000-0000000000f1";

let petId: string;

async function cleanup(): Promise<void> {
  await db.execute(
    sql`DELETE FROM ownerships WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${PET_TOKEN})`,
  );
  await db.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  await db.execute(sql`DELETE FROM organizations WHERE id = ${ORG_ID}::uuid`);
  await db.execute(
    sql`DELETE FROM profiles WHERE id IN (${TITULAR_ID}::uuid, ${CARETAKER_ID}::uuid, ${FOSTER_ID}::uuid, ${SHELTER_USER_ID}::uuid)`,
  );
}

beforeAll(async () => {
  await cleanup();
  await db.insert(profiles).values([
    { id: TITULAR_ID, displayName: "Titular Alerta", role: "owner" },
    { id: CARETAKER_ID, displayName: "Cuidadora Alerta", role: "owner" },
    { id: FOSTER_ID, displayName: "Transitante Alerta", role: "owner" },
    { id: SHELTER_USER_ID, displayName: "Refugio Persona", role: "owner" },
  ]);
  await db.insert(organizations).values({
    id: ORG_ID,
    publicToken: "ORG-ALRT-0001",
    legalName: "Refugio Alerta",
    displayName: "Refugio Alerta",
    orgType: "shelter",
    email: "refugio-alerta@dim-test.local",
  });
  const [pet] = await db
    .insert(pets)
    .values({ publicToken: PET_TOKEN, name: "Pampa Alerta", species: "dog" })
    .returning({ id: pets.id });
  petId = pet.id;
});

afterEach(async () => {
  await db.delete(ownerships).where(eq(ownerships.petId, petId));
});

afterAll(async () => {
  await cleanup();
});

// ---------------------------------------------------------------------------
// ROUTE-1 parity — the no-caretaker world must be untouched
// ---------------------------------------------------------------------------

describe("resolveLostPetAlertRecipients — ROUTE-1 parity (no caretaker)", () => {
  it("returns the titular alone", async () => {
    await db.insert(ownerships).values({ petId, ownerUserId: TITULAR_ID, role: "owner" });

    const recipients = await resolveLostPetAlertRecipients(petId);

    expect(recipients).toEqual([{ userId: TITULAR_ID, role: "owner", tier: "primary" }]);
  });

  it("prefers the titular over an active foster — the 2026-08-04 mis-routing bug", async () => {
    await db.insert(ownerships).values([
      { petId, ownerUserId: FOSTER_ID, role: "foster" },
      { petId, ownerUserId: TITULAR_ID, role: "owner" },
    ]);

    const recipients = await resolveLostPetAlertRecipients(petId);

    expect(recipients).toEqual([{ userId: TITULAR_ID, role: "owner", tier: "primary" }]);
  });

  it("falls back to the person holding shelter custody when there is no owner row", async () => {
    // A pet in shelter custody has no `owner` row at all. Filtering by role
    // instead of RANKING would turn a mis-routed alert into NO alert.
    await db
      .insert(ownerships)
      .values({ petId, ownerUserId: SHELTER_USER_ID, role: "shelter_custody" });

    const recipients = await resolveLostPetAlertRecipients(petId);

    expect(recipients).toEqual([
      { userId: SHELTER_USER_ID, role: "shelter_custody", tier: "primary" },
    ]);
  });

  it("falls back to any remaining holder — a foster still gets the alert", async () => {
    await db.insert(ownerships).values({ petId, ownerUserId: FOSTER_ID, role: "foster" });

    const recipients = await resolveLostPetAlertRecipients(petId);

    expect(recipients).toEqual([{ userId: FOSTER_ID, role: "foster", tier: "primary" }]);
  });

  it("returns nobody when every holder is an ORGANISATION (no user to notify)", async () => {
    await db.insert(ownerships).values({ petId, ownerOrganizationId: ORG_ID, role: "owner" });

    expect(await resolveLostPetAlertRecipients(petId)).toEqual([]);
  });

  it("returns nobody when there is no active holder at all", async () => {
    await db
      .insert(ownerships)
      .values({ petId, ownerUserId: TITULAR_ID, role: "owner", endedAt: new Date() });

    expect(await resolveLostPetAlertRecipients(petId)).toEqual([]);
  });

  it("ignores ENDED rows when ranking", async () => {
    await db.insert(ownerships).values([
      { petId, ownerUserId: TITULAR_ID, role: "owner", endedAt: new Date() },
      { petId, ownerUserId: FOSTER_ID, role: "foster" },
    ]);

    const recipients = await resolveLostPetAlertRecipients(petId);

    expect(recipients).toEqual([{ userId: FOSTER_ID, role: "foster", tier: "primary" }]);
  });
});

// ---------------------------------------------------------------------------
// The new behaviour
// ---------------------------------------------------------------------------

describe("resolveLostPetAlertRecipients — with an active caretaker", () => {
  it("notifies BOTH, titular primary and caretaker secondary", async () => {
    await db.insert(ownerships).values([
      { petId, ownerUserId: TITULAR_ID, role: "owner" },
      { petId, ownerUserId: CARETAKER_ID, role: "caretaker" },
    ]);

    const recipients = await resolveLostPetAlertRecipients(petId);

    expect(recipients).toEqual([
      { userId: TITULAR_ID, role: "owner", tier: "primary" },
      { userId: CARETAKER_ID, role: "caretaker", tier: "secondary" },
    ]);
  });

  it("ranks the titular first even when the caretaker row is older", async () => {
    await db.insert(ownerships).values([
      {
        petId,
        ownerUserId: CARETAKER_ID,
        role: "caretaker",
        startedAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        petId,
        ownerUserId: TITULAR_ID,
        role: "owner",
        startedAt: new Date("2026-08-01T00:00:00Z"),
      },
    ]);

    const recipients = await resolveLostPetAlertRecipients(petId);

    expect(recipients[0].tier).toBe("primary");
    expect(recipients[0].userId).toBe(TITULAR_ID);
  });

  it("drops an ENDED caretaker grant — access gone, alerts gone", async () => {
    await db.insert(ownerships).values([
      { petId, ownerUserId: TITULAR_ID, role: "owner" },
      { petId, ownerUserId: CARETAKER_ID, role: "caretaker", endedAt: new Date() },
    ]);

    const recipients = await resolveLostPetAlertRecipients(petId);

    expect(recipients).toEqual([{ userId: TITULAR_ID, role: "owner", tier: "primary" }]);
  });

  it("never lists the same person twice when the caretaker IS the only holder", async () => {
    // ROUTE-1's last fallback is "whoever is caring for it", so a lone
    // caretaker was already the recipient before this change. They must appear
    // ONCE, as the primary, not once per rule that matched them.
    await db.insert(ownerships).values({ petId, ownerUserId: CARETAKER_ID, role: "caretaker" });

    const recipients = await resolveLostPetAlertRecipients(petId);

    expect(recipients).toEqual([{ userId: CARETAKER_ID, role: "caretaker", tier: "primary" }]);
  });

  it("notifies the shelter-custody holder AND the caretaker", async () => {
    await db.insert(ownerships).values([
      { petId, ownerUserId: SHELTER_USER_ID, role: "shelter_custody" },
      { petId, ownerUserId: CARETAKER_ID, role: "caretaker" },
    ]);

    const recipients = await resolveLostPetAlertRecipients(petId);

    expect(recipients.map((r) => r.tier)).toEqual(["primary", "secondary"]);
    expect(recipients.map((r) => r.userId)).toEqual([SHELTER_USER_ID, CARETAKER_ID]);
  });

  it("does not promote a caretaker over the titular by returning them first", async () => {
    // Order is the delivery contract: the caller builds one notification per
    // recipient in array order, and "primary" has to be the first thing an
    // operator reading the notifications table sees.
    await db.insert(ownerships).values([
      { petId, ownerUserId: CARETAKER_ID, role: "caretaker" },
      { petId, ownerUserId: TITULAR_ID, role: "owner" },
      { petId, ownerUserId: FOSTER_ID, role: "foster" },
    ]);

    const recipients = await resolveLostPetAlertRecipients(petId);

    expect(recipients).toEqual([
      { userId: TITULAR_ID, role: "owner", tier: "primary" },
      { userId: CARETAKER_ID, role: "caretaker", tier: "secondary" },
    ]);
    // The foster is NOT added. Only the caretaker is promoted to a concurrent
    // recipient; widening this to every holder is a different decision.
    expect(recipients.map((r) => r.userId)).not.toContain(FOSTER_ID);
  });
});

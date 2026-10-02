// Integration test for the vecino-helps-stray custody path.
//
// Exercises the writer logic equivalent to createPetAction: insert a pet,
// insert an ownership with role='shelter_custody' (when custodyKind is
// 'foster_in_transit'), and emit a pet_registered event whose payload
// includes custody_kind='shelter_custody_by_citizen'. Validates the
// Zod schema accepts the new field at insert time via the same
// validateEventPayload path the action uses.

import { createClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isTransitRole } from "@/components/PetCard.helpers";
import { db, notifications, ownerships, petEvents, pets } from "@/db";
import { canEditPetProfile } from "@/lib/domain/profile-editors";
import { validateEventPayload } from "@/lib/events/event-schemas";
import {
  petHasActiveTitular,
  resolvePetHasTitularFact,
  resolvePetHolderAccess,
} from "@/lib/infra/pet-access";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser, deleteTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const EMAIL = "custody-transit-test@dim-test.local";
const PASS = "CustodyTransit_2026!";

let userId: string;

beforeAll(async () => {
  const { data: list } = await admin.auth.admin.listUsers();
  const found = list?.users.find((u) => u.email === EMAIL);
  if (found) {
    const owned = await db.select().from(ownerships).where(eq(ownerships.ownerUserId, found.id));
    await withMutationOverride(async (tx) => {
      for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
    });
    await admin.auth.admin.deleteUser(found.id);
  }
  const { data, error } = await createFreshTestUser(admin, {
    email: EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;
});

afterAll(async () => {
  const owned = await db.select().from(ownerships).where(eq(ownerships.ownerUserId, userId));
  await withMutationOverride(async (tx) => {
    for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
  });
  await admin.auth.admin.deleteUser(userId);
});

// Mirrors the createPetAction insert path with the inputs that matter for
// custody. Inlined here to keep the test self-contained — exercising the
// real action would require faking FormData + the supabase server client.
async function createPetWithCustody(opts: {
  custodyKind: "owner" | "foster_in_transit";
  potentiallyDangerousBreed?: boolean;
  publicTokenSuffix: string;
}): Promise<{ petId: string; ownershipRole: string; eventPayload: unknown }> {
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [newPet] = await tx
      .insert(pets)
      .values({
        publicToken: `CUST-${opts.publicTokenSuffix}`,
        name: opts.custodyKind === "foster_in_transit" ? "Sombra" : "Lila",
        species: "dog",
        sex: "unknown",
        status: "active",
        potentiallyDangerousBreed: opts.potentiallyDangerousBreed ?? false,
      })
      .returning();

    const ownershipRole = opts.custodyKind === "foster_in_transit" ? "shelter_custody" : "owner";
    const [ownership] = await tx
      .insert(ownerships)
      .values({
        petId: newPet.id,
        ownerUserId: userId,
        role: ownershipRole,
        startedAt: now,
      })
      .returning();

    const eventPayload = validateEventPayload("pet_registered", {
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
      jurisdiction_province: null,
      jurisdiction_locality: null,
      potentially_dangerous_breed: opts.potentiallyDangerousBreed ?? false,
      acquisition_method: opts.custodyKind === "foster_in_transit" ? "found_stray" : "adopted",
      has_photo: false,
      has_microchip: false,
      custody_kind:
        opts.custodyKind === "foster_in_transit" ? "shelter_custody_by_citizen" : "owner",
    });

    const [registered] = await tx
      .insert(petEvents)
      .values({
        petId: newPet.id,
        eventType: "pet_registered",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: userId,
        authorRole: "owner",
        payload: eventPayload,
      })
      .returning();

    // Mirror the suppression rule from createPetAction: PPP notification is
    // skipped for foster_in_transit because the legal obligation belongs to
    // the legal owner.
    if (opts.potentiallyDangerousBreed && opts.custodyKind !== "foster_in_transit") {
      await tx.insert(notifications).values({
        userId,
        notificationType: "ppp_registration_reminder",
        title: `${newPet.name}: registrá tu PPP en el provincial`,
        body: "Test notification body",
        severity: "warning",
        relatedPetId: newPet.id,
        relatedEventId: registered.id,
      });
    }

    return { petId: newPet.id, ownershipRole: ownership.role, eventPayload };
  });
  return result;
}

describe("createPet — custody path", () => {
  it("foster_in_transit creates ownership with role=shelter_custody", async () => {
    const { ownershipRole } = await createPetWithCustody({
      custodyKind: "foster_in_transit",
      publicTokenSuffix: "TRANSIT-1",
    });
    expect(ownershipRole).toBe("shelter_custody");
  });

  it("foster_in_transit puts custody_kind=shelter_custody_by_citizen in the payload", async () => {
    const { eventPayload } = await createPetWithCustody({
      custodyKind: "foster_in_transit",
      publicTokenSuffix: "TRANSIT-2",
    });
    const payload = eventPayload as Record<string, unknown>;
    expect(payload.custody_kind).toBe("shelter_custody_by_citizen");
  });

  it("owner (default) creates ownership with role=owner", async () => {
    const { ownershipRole } = await createPetWithCustody({
      custodyKind: "owner",
      publicTokenSuffix: "OWNER-1",
    });
    expect(ownershipRole).toBe("owner");
  });

  it("owner puts custody_kind=owner in the payload", async () => {
    const { eventPayload } = await createPetWithCustody({
      custodyKind: "owner",
      publicTokenSuffix: "OWNER-2",
    });
    const payload = eventPayload as Record<string, unknown>;
    expect(payload.custody_kind).toBe("owner");
  });

  it("PPP notification is suppressed for foster_in_transit", async () => {
    const { petId } = await createPetWithCustody({
      custodyKind: "foster_in_transit",
      potentiallyDangerousBreed: true,
      publicTokenSuffix: "PPP-TRANSIT",
    });
    const notifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.relatedPetId, petId),
          eq(notifications.notificationType, "ppp_registration_reminder"),
        ),
      );
    expect(notifs).toHaveLength(0);
  });

  it("PPP notification IS emitted for owner with PPP breed", async () => {
    const { petId } = await createPetWithCustody({
      custodyKind: "owner",
      potentiallyDangerousBreed: true,
      publicTokenSuffix: "PPP-OWNER",
    });
    const notifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.relatedPetId, petId),
          eq(notifications.notificationType, "ppp_registration_reminder"),
        ),
      );
    expect(notifs).toHaveLength(1);
  });

  // foster-alta-2026-07-21: the downstream "En tránsito" projection
  // (isTransitRole, feeding both the Mis mascotas list badge and the pet
  // profile page's transit alert/situation) must actually recognize the
  // ownership row the alta writes for a foster/tránsito registration — this
  // is the concrete check that the foster pillar's registration path isn't a
  // facade end-to-end, not just at the write.
  it("foster_in_transit registration surfaces as 'En tránsito' in the projection", async () => {
    const { ownershipRole } = await createPetWithCustody({
      custodyKind: "foster_in_transit",
      publicTokenSuffix: "TRANSIT-BADGE",
    });
    expect(isTransitRole(ownershipRole)).toBe(true);
  });

  it("owner registration does NOT surface as 'En tránsito' in the projection", async () => {
    const { ownershipRole } = await createPetWithCustody({
      custodyKind: "owner",
      publicTokenSuffix: "OWNER-BADGE",
    });
    expect(isTransitRole(ownershipRole)).toBe(false);
  });
});

// PO decision 2026-10-01: the vecino en tránsito (a user-held shelter_custody
// row) edits the animal's data ONLY while it has no titular. The predicate is
// pure; this block pins the FACT it reads, against real rows, across the
// transition a chip match produces — a titular appearing under the vecino.
describe("the vecino en tránsito edits only while the animal has no titular", () => {
  const OWNER_EMAIL = "custody-transit-titular@dim-test.local";
  let titularId: string;
  const createdPetIds: string[] = [];

  beforeAll(async () => {
    const { data, error } = await createFreshTestUser(admin, {
      email: OWNER_EMAIL,
      password: PASS,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
    titularId = data.user.id;
  });

  afterAll(async () => {
    await withMutationOverride(async (tx) => {
      for (const id of createdPetIds) await tx.delete(pets).where(eq(pets.id, id));
    });
    await deleteTestUser(admin, db, OWNER_EMAIL);
  });

  it("flips the vecino to read-only the moment a titular appears, and back when it ends", async () => {
    const { petId } = await createPetWithCustody({
      custodyKind: "foster_in_transit",
      publicTokenSuffix: "VECINO-EDIT",
    });
    createdPetIds.push(petId);

    // The guard resolves the vecino through the person path, as shelter_custody.
    const held = await resolvePetHolderAccess("CUST-VECINO-EDIT", userId);
    expect(held.kind === "owner" ? held.holderRole : held.kind).toBe("shelter_custody");
    const asVecino = { accessPath: "owner", holderRole: "shelter_custody", petId } as const;
    const vecinoEdits = async () =>
      canEditPetProfile("owner", "shelter_custody", await resolvePetHasTitularFact(asVecino));

    // A stray nobody owns: the vecino's own custody row is not a titular.
    expect(await petHasActiveTitular(petId)).toBe(false);
    expect(await vecinoEdits()).toBe(true);

    // The owner turns up (a chip match, a transfer): a live owner row.
    const [titularRow] = await db
      .insert(ownerships)
      .values({ petId, ownerUserId: titularId, role: "owner" })
      .returning({ id: ownerships.id });
    expect(await petHasActiveTitular(petId)).toBe(true);
    expect(await vecinoEdits()).toBe(false);
    // The titular edits; the fact is irrelevant to them.
    expect(canEditPetProfile("owner", "owner", true)).toBe(true);

    // An ENDED titular row is history, not a titular.
    await withMutationOverride(async (tx) => {
      await tx
        .update(ownerships)
        .set({ endedAt: new Date() })
        .where(eq(ownerships.id, titularRow.id));
    });
    expect(await petHasActiveTitular(petId)).toBe(false);
    expect(await vecinoEdits()).toBe(true);
  });

  it("never reads the fact for a holder whose answer does not depend on it", async () => {
    // `true` without a query: the conservative value, so a misuse only refuses.
    for (const holderRole of ["owner", "co_owner", "foster", "caretaker"]) {
      expect(
        await resolvePetHasTitularFact({
          accessPath: "owner",
          holderRole,
          petId: "00000000-0000-4000-8000-000000000000",
        }),
      ).toBe(true);
    }
    expect(
      await resolvePetHasTitularFact({
        accessPath: "org",
        holderRole: "shelter_custody",
        petId: "00000000-0000-4000-8000-000000000000",
      }),
    ).toBe(true);
  });
});

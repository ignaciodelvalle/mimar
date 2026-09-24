// Integration tests for the projection-writes audit §6 idempotency guards.
//
// Each describe proves that a SECOND identical call (double-click /
// double-submit) is a no-op: no duplicate pet, event, ownership, reminder or
// identification row. Surfaces covered here:
//
//   1. createIntake            — org intake (clientIdempotencyKey + advisory lock)
//   2. createTattooForUser     — tattoo event + ident (insertEventIdempotent)
//   3. createVaccineReminder   — manual reminder (conditional insert)
//   4. FosterRepository.insertAssignFoster — in-tx lock + re-check
//   5. confirmChipMatchAsRefugioWriter / Vecino — custody state guard
//   6. setPetDisclosurePrefs   — desired-state no-op
//
// Surfaces tested elsewhere: replace-microchip (microchip-replaced.test.ts),
// libreta share (libreta-share.test.ts), single adoption eligibility
// (set-adoption-eligibility.test.ts), tier2 windows (tier2-public-action.test.ts).
//
// Fixture pattern mirrors microchip-replaced.test.ts: admin-SDK users, pets +
// ownerships inserted directly, withMutationOverride for cleanup that cascades
// into pet_events.

import { createClient } from "@supabase/supabase-js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// next/cache + next/navigation are Next-runtime-only; the writers under test
// call revalidatePath/redirect on their success paths.
const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

import {
  attachments,
  db,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  petIdentifications,
  pets,
  reminders,
} from "@/db";
import { generateIntakeMatchClaim } from "@/lib/infra/intake-match-claim";
import type { PetEventAuthorship } from "@/lib/infra/pet-access";
import { FosterRepository } from "@/src/modules/foster/infrastructure/foster-repository";
import { confirmChipMatchAsRefugioWriter } from "@/src/modules/pets/application/chip-match/confirm-chip-match-refugio";
import { confirmChipMatchAsVecinoWriter } from "@/src/modules/pets/application/chip-match/confirm-chip-match-vecino";
import { createIntake } from "@/src/modules/pets/application/intake/create-intake";
import { setPetDisclosurePrefs } from "@/src/modules/pets/application/lost-mode/set-pet-disclosure-prefs";
import { createVaccineReminder } from "@/src/modules/pets/application/reminders/create-vaccine-reminder";
import { createTattooForUser } from "@/src/modules/pets/application/tattoo/create-tattoo";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const OWNER_EMAIL = "idem-guards-owner@dim-test.local";
const HELPER_EMAIL = "idem-guards-helper@dim-test.local";
const PASS = "IdemGuards_2026!";
const ORG_EMAIL = "idem-guards-org@dim-test.local";

let ownerUserId: string; // pet owner / org operator
let helperUserId: string; // vecino / foster volunteer
let orgId: string;

// Pets created during tests — tracked for afterAll cleanup.
const createdPetIds: string[] = [];

async function purgeUser(email: string) {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === email);
  if (!found) return;
  const owned = await db
    .select({ petId: ownerships.petId })
    .from(ownerships)
    .where(eq(ownerships.ownerUserId, found.id));
  await withMutationOverride(async (tx) => {
    for (const { petId } of owned) {
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${petId}::uuid`);
      await tx.delete(pets).where(eq(pets.id, petId));
    }
  });
  await admin.auth.admin.deleteUser(found.id);
}

async function insertPet(name: string, status: "active" | "lost" = "active") {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `IDEM-${name.toUpperCase().slice(0, 8)}-${Date.now()}`,
      name,
      species: "dog",
      sex: "unknown",
      status,
    })
    .returning();
  createdPetIds.push(pet.id);
  return pet;
}

beforeAll(async () => {
  await purgeUser(OWNER_EMAIL);
  await purgeUser(HELPER_EMAIL);
  await db.delete(organizations).where(eq(organizations.email, ORG_EMAIL));

  const { data: ownerData, error: ownerErr } = await createFreshTestUser(admin, {
    email: OWNER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (ownerErr || !ownerData.user) throw new Error(`createUser owner: ${ownerErr?.message}`);
  ownerUserId = ownerData.user.id;

  const { data: helperData, error: helperErr } = await createFreshTestUser(admin, {
    email: HELPER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (helperErr || !helperData.user) throw new Error(`createUser helper: ${helperErr?.message}`);
  helperUserId = helperData.user.id;

  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: `IDEM-ORG-${ownerUserId.slice(0, 6).toUpperCase()}`,
      legalName: "Refugio Idempotencia SRL",
      displayName: "Refugio Idempotencia",
      orgType: "shelter",
      email: ORG_EMAIL,
      verified: true,
    })
    .returning();
  orgId = org.id;

  await db.insert(organizationMemberships).values({
    organizationId: orgId,
    userId: ownerUserId,
    role: "admin",
  });
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    for (const petId of createdPetIds) {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}::uuid`);
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${petId}::uuid`);
      await tx.delete(ownerships).where(eq(ownerships.petId, petId));
      await tx.delete(pets).where(eq(pets.id, petId));
    }
  });

  if (orgId) {
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }

  if (ownerUserId) await admin.auth.admin.deleteUser(ownerUserId);
  if (helperUserId) await admin.auth.admin.deleteUser(helperUserId);
});

// ---------------------------------------------------------------------------
// 1. Org intake
// ---------------------------------------------------------------------------

describe("createIntake — idempotency guard", () => {
  it("double-submit with the same clientIdempotencyKey creates exactly one pet", async () => {
    const idemKey = crypto.randomUUID();
    const fd = new FormData();
    fd.set("name", "Intake Doble");
    fd.set("species", "dog");
    fd.set("intakeReason", "rescue");
    fd.set("noRedirect", "1");
    fd.set("clientIdempotencyKey", idemKey);

    const actorUser = { id: ownerUserId };
    const actorOrg = { id: orgId, displayName: "Refugio Idempotencia", verified: true };

    const first = await createIntake("IDEMORGTOK", actorUser, actorOrg, fd);
    expect(first.error).toBeNull();
    expect(first.ok).toBe(true);
    expect(first.createdPetToken).toBeTruthy();

    // Track for cleanup.
    const [createdPet] = await db
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, first.createdPetToken as string))
      .limit(1);
    createdPetIds.push(createdPet.id);

    // Double-submit: identical FormData, same key.
    const second = await createIntake("IDEMORGTOK", actorUser, actorOrg, fd);
    expect(second.error).toBeNull();
    expect(second.ok).toBe(true);

    // The retry surfaces the ORIGINAL pet — same token, same name.
    expect(second.createdPetToken).toBe(first.createdPetToken);
    expect(second.createdPetName).toBe("Intake Doble");

    // Exactly one pet_registered event carries this key → exactly one pet.
    const events = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(
        and(eq(petEvents.eventType, "pet_registered"), eq(petEvents.clientIdempotencyKey, idemKey)),
      );
    expect(events.length).toBe(1);

    // Exactly one shelter_intake_recorded event for the created pet.
    const intakeEvents = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, createdPet.id), eq(petEvents.eventType, "shelter_intake_recorded")),
      );
    expect(intakeEvents.length).toBe(1);

    // Exactly one active ownership row for the org on this pet.
    const custody = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, createdPet.id),
          eq(ownerships.ownerOrganizationId, orgId),
          isNull(ownerships.endedAt),
        ),
      );
    expect(custody.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Tattoo
// ---------------------------------------------------------------------------

describe("createTattooForUser — idempotency guard", () => {
  it("double-submit with the same clientIdempotencyKey is a no-op", async () => {
    const pet = await insertPet("Tattoo Doble");
    const idemKey = crypto.randomUUID();
    const authorship = {
      authorRole: "owner",
      authorOrganizationId: null,
      authorVerified: false,
    } as PetEventAuthorship;

    const input = {
      code: "IDEM-TAT-01",
      location: null,
      description: null,
      recordedAt: null,
      recordedBy: null,
      uploadedAttachment: {
        path: `test/idem-tattoo-${Date.now()}.jpg`,
        mimeType: "image/jpeg",
        size: 123,
      },
      clientIdempotencyKey: idemKey,
    };

    const first = await createTattooForUser(pet.id, ownerUserId, authorship, input);
    expect(first).toMatchObject({ ok: true });
    if (!("ok" in first)) throw new Error("Expected ok");

    const second = await createTattooForUser(pet.id, ownerUserId, authorship, input);
    expect(second).toMatchObject({ ok: true, wasNoop: true });
    if (!("ok" in second)) throw new Error("Expected ok");
    expect(second.eventId).toBe(first.eventId);

    const events = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "tattoo_recorded")));
    expect(events.length).toBe(1);

    const idents = await db
      .select({ id: petIdentifications.id })
      .from(petIdentifications)
      .where(and(eq(petIdentifications.petId, pet.id), eq(petIdentifications.kind, "tattoo")));
    expect(idents.length).toBe(1);

    const attachmentRows = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.petId, pet.id));
    expect(attachmentRows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Vaccine reminder
// ---------------------------------------------------------------------------

describe("createVaccineReminder — idempotency guard", () => {
  it("double-submit of the identical reminder inserts exactly one row", async () => {
    const pet = await insertPet("Reminder Doble");

    const fd = new FormData();
    fd.set("vaccineName", "Antirrábica");
    fd.set("dueAt", "2026-09-01");

    const first = await createVaccineReminder(
      ownerUserId,
      pet.id,
      pet.publicToken,
      { error: null },
      fd,
    );
    // Nav contract N3 (2026-08-05): success RETURNS the destination instead of
    // calling redirect(), which the App Router can drop.
    expect(first.error).toBeNull();
    expect(first.redirectTo).toBe(`/mis-mascotas/${pet.publicToken}`);
    expect(first.reminderId).toEqual(expect.any(String));

    const second = await createVaccineReminder(
      ownerUserId,
      pet.id,
      pet.publicToken,
      { error: null },
      fd,
    );
    expect(second.error).toBeNull();
    expect(second.redirectTo).toBe(`/mis-mascotas/${pet.publicToken}`);
    // THE REPLAY RETURNS THE SAME ROW, not a second one — a caller that asked
    // for this reminder to exist gets back the reminder it asked for, whether
    // this call created it or recognised it.
    expect(second.reminderId).toBe(first.reminderId);

    const rows = await db
      .select({ id: reminders.id })
      .from(reminders)
      .where(and(eq(reminders.petId, pet.id), eq(reminders.title, "Antirrábica")));
    expect(rows.length).toBe(1);
  });

  it("a different due date still creates a second reminder", async () => {
    const pet = await insertPet("Reminder Distinto");

    const fd1 = new FormData();
    fd1.set("vaccineName", "Séxtuple");
    fd1.set("dueAt", "2026-09-01");
    await createVaccineReminder(ownerUserId, pet.id, pet.publicToken, { error: null }, fd1);

    const fd2 = new FormData();
    fd2.set("vaccineName", "Séxtuple");
    fd2.set("dueAt", "2026-10-01");
    await createVaccineReminder(ownerUserId, pet.id, pet.publicToken, { error: null }, fd2);

    const rows = await db
      .select({ id: reminders.id })
      .from(reminders)
      .where(and(eq(reminders.petId, pet.id), eq(reminders.title, "Séxtuple")));
    expect(rows.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Foster assignment (repo-level in-tx guard)
// ---------------------------------------------------------------------------

describe("FosterRepository.insertAssignFoster — idempotency guard", () => {
  it("second call while a foster is active throws and inserts nothing", async () => {
    const pet = await insertPet("Foster Doble");

    const args = {
      petId: pet.id,
      petName: pet.name,
      petJurisdictionProvince: null,
      petJurisdictionLocality: null,
      fosterUserId: helperUserId,
      expectedWeeks: 4,
      notes: null,
      actorUserId: ownerUserId,
      actorOrgId: orgId,
      actorOrgVerified: true,
      actorOrgDisplayName: "Refugio Idempotencia",
      now: new Date(),
    };

    const first = await db.transaction(async (tx) => FosterRepository.insertAssignFoster(args, tx));
    expect(first.ownershipId).toBeTruthy();

    await expect(
      db.transaction(async (tx) => FosterRepository.insertAssignFoster(args, tx)),
    ).rejects.toThrow(/tránsito activo/i);

    const fosterRows = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, pet.id),
          eq(ownerships.role, "foster"),
          isNull(ownerships.endedAt),
        ),
      );
    expect(fosterRows.length).toBe(1);

    const events = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "foster_assigned")));
    expect(events.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Chip-match confirmations
// ---------------------------------------------------------------------------

describe("confirmChipMatchAsRefugioWriter — idempotency guard", () => {
  it("second 'same' confirmation is a no-op (custody already held)", async () => {
    const pet = await insertPet("ChipMatch Refugio", "lost");
    await db.insert(ownerships).values({ petId: pet.id, ownerUserId, role: "owner" });

    const call = () =>
      confirmChipMatchAsRefugioWriter({
        auth: {
          user: { id: helperUserId },
          organization: { id: orgId, displayName: "Refugio Idempotencia", verified: true },
        },
        orgToken: "IDEMORGTOK",
        matchedPetToken: pet.publicToken,
        claim: generateIntakeMatchClaim("IDEMORGTOK", pet.publicToken),
        decision: "same",
      });

    const first = await call();
    expect(first).toMatchObject({ ok: true });

    const second = await call();
    expect(second).toMatchObject({ ok: true });

    const custody = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, pet.id),
          eq(ownerships.ownerOrganizationId, orgId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      );
    expect(custody.length).toBe(1);

    const events = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "shelter_intake_recorded")));
    expect(events.length).toBe(1);
  });
});

describe("confirmChipMatchAsVecinoWriter — idempotency guard", () => {
  it("second 'same' confirmation is a no-op (custody already held)", async () => {
    const pet = await insertPet("ChipMatch Vecino", "lost");
    await db.insert(ownerships).values({ petId: pet.id, ownerUserId, role: "owner" });

    // The vecino writer now demands the code the actor typed as its actor↔pet
    // binding (chip-oracle fix), so the fixture needs a canonical chip.
    const chip = `900${String(Date.now()).slice(-12)}`; // 15 digits — chip_requires_iso_fields
    await db.insert(petIdentifications).values({
      petId: pet.id,
      kind: "microchip_iso",
      code: chip,
      status: "active",
      recordedAt: new Date().toISOString().slice(0, 10),
      isoCountryCode: chip.slice(0, 3),
      isoManufacturerCode: chip.slice(3, 7),
      isoNationalId: chip.slice(7, 15),
    });

    const call = () =>
      confirmChipMatchAsVecinoWriter({
        userId: helperUserId,
        matchedPetToken: pet.publicToken,
        attemptedMicrochipId: chip,
        decision: "same",
      });

    const first = await call();
    expect(first).toMatchObject({ ok: true });

    const second = await call();
    expect(second).toMatchObject({ ok: true });

    const custody = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, pet.id),
          eq(ownerships.ownerUserId, helperUserId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      );
    expect(custody.length).toBe(1);

    const events = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "shelter_intake_recorded")));
    expect(events.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Disclosure prefs (desired-state no-op)
// ---------------------------------------------------------------------------

describe("setPetDisclosurePrefs — desired-state guard", () => {
  it("setting the value the pet already holds writes nothing", async () => {
    const pet = await insertPet("Prefs Doble");
    mockRevalidatePath.mockClear();

    // Schema default for discloseEmailWhenLost is false → same-value call.
    await setPetDisclosurePrefs(pet.id, pet.publicToken, "discloseEmailWhenLost", false);

    const [afterNoop] = await db
      .select({ updatedAt: pets.updatedAt, value: pets.discloseEmailWhenLost })
      .from(pets)
      .where(eq(pets.id, pet.id))
      .limit(1);
    expect(afterNoop.value).toBe(false);
    expect(afterNoop.updatedAt.getTime()).toBe(pet.updatedAt.getTime());
    expect(mockRevalidatePath).not.toHaveBeenCalled();

    // A real change still writes + revalidates.
    await setPetDisclosurePrefs(pet.id, pet.publicToken, "discloseEmailWhenLost", true);
    const [afterChange] = await db
      .select({ value: pets.discloseEmailWhenLost })
      .from(pets)
      .where(eq(pets.id, pet.id))
      .limit(1);
    expect(afterChange.value).toBe(true);
    expect(mockRevalidatePath).toHaveBeenCalledOnce();
  });
});

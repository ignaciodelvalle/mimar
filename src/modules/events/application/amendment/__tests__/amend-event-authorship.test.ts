// Integration tests for the authorship gate on amendEvent — PO decision 3B
// (2026-09-22): an owner corrects only what they wrote; a professional record
// (or one a professional already corrected) only a professional corrects;
// admin/govt keep the override. Asserted THROUGH the use-case, against the local
// Postgres, because the gate lives there precisely so that every door reaching
// `amendEvent` (the web server action and `/api/v1`) inherits it.
//
// Runs against the local Postgres (vitest setup forces 127.0.0.1:54322).

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// amendEvent calls revalidatePath (Next request-scoped) after the write commits.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// A seam for the race test: runs ONCE, right after the EARLY authorship check
// (the one on `db`, before the transaction) and before the locked recheck.
const hook = vi.hoisted(() => ({ afterEarlyCheck: null as null | (() => Promise<void>) }));
vi.mock("@/src/modules/events/application/amendment/amend-authorship", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/src/modules/events/application/amendment/amend-authorship")
    >();
  return {
    ...actual,
    checkAmendAuthorship: async (...args: Parameters<typeof actual.checkAmendAuthorship>) => {
      const result = await actual.checkAmendAuthorship(...args);
      const pending = hook.afterEarlyCheck;
      if (args[1] === undefined && pending) {
        hook.afterEarlyCheck = null;
        await pending();
      }
      return result;
    },
  };
});

import { db, ownerships, petEvents, pets, profiles } from "@/db";
import type { PetEventAuthorship } from "@/lib/infra/pet-access";
import { amendEvent } from "@/src/modules/events/application/amendment/amend-event";
import { withMutationOverride } from "../../../../../../__tests__/_helpers/db-overrides";

const OWNER_ID = "3b000000-0000-4000-8000-000000000001";
const OTHER_OWNER_ID = "3b000000-0000-4000-8000-000000000002";
const VET_ID = "3b000000-0000-4000-8000-000000000003";
const ADMIN_ID = "3b000000-0000-4000-8000-000000000004";
const GOVT_ID = "3b000000-0000-4000-8000-000000000005";
const CARETAKER_ID = "3b000000-0000-4000-8000-000000000006";

const PROFILE_ROLES: Array<[string, "owner" | "vet" | "admin" | "govt"]> = [
  [OWNER_ID, "owner"],
  [OTHER_OWNER_ID, "owner"],
  [VET_ID, "vet"],
  [ADMIN_ID, "admin"],
  [GOVT_ID, "govt"],
  [CARETAKER_ID, "owner"],
];

const OWNER_SIGNATURE: PetEventAuthorship = {
  authorRole: "owner",
  authorOrganizationId: null,
  authorVerified: false,
};
// The org-path signature of a member holding a validated matrícula. The gate
// reads only `authorRole`, so the organization is left null and the fixture
// needs no organizations row.
const VET_SIGNATURE: PetEventAuthorship = {
  authorRole: "vet",
  authorOrganizationId: null,
  authorVerified: true,
};
// What the org path signs for a member WITHOUT a validated matrícula
// (lib/infra/pet-access.ts): no professional standing.
const UNVERIFIED_SHELTER_SIGNATURE: PetEventAuthorship = {
  authorRole: "shelter",
  authorOrganizationId: null,
  authorVerified: false,
};

// Explicit instants, never `defaultNow()` against a host clock: the legacy rule
// compares an ownership interval with a row's recorded_at.
const T_2020 = new Date("2020-01-01T00:00:00Z");
const T_2021 = new Date("2021-06-01T00:00:00Z");
const T_2023 = new Date("2023-01-01T00:00:00Z");

const PROFESSIONAL_REFUSAL =
  "Este registro lo cargó o lo corrigió un profesional. Solo un profesional puede corregirlo.";
const NOT_AUTHOR_REFUSAL = "Solo quien cargó este registro puede corregirlo.";

const insertedPetIds: string[] = [];

async function insertPet(suffix: string, opts: { withOwner?: boolean } = {}) {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `AMENDAUTH-${suffix}-${Date.now()}`,
      name: `Autoria${suffix}`,
      species: "dog",
      sex: "female",
      status: "active",
    })
    .returning();
  if (opts.withOwner !== false) {
    await db
      .insert(ownerships)
      .values({ petId: pet.id, ownerUserId: OWNER_ID, role: "owner", startedAt: T_2020 });
  }
  insertedPetIds.push(pet.id);
  return pet;
}

async function insertWeight(
  petId: string,
  author: {
    recordedByUserId: string | null;
    authorRole: "owner" | "vet" | "shelter";
    authorVerified?: boolean;
    recordedAt?: Date;
  },
) {
  const now = author.recordedAt ?? new Date();
  const [event] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "weight_recorded",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: author.recordedByUserId,
      authorRole: author.authorRole,
      authorOrganizationId: null,
      authorVerified: author.authorVerified ?? author.authorRole === "vet",
      payload: { payload_version: 1, kg: "10" },
    })
    .returning({ id: petEvents.id });
  return event.id;
}

async function countAmendments(petId: string) {
  const rows = await db
    .select({ id: petEvents.id })
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "event_amended")));
  return rows.length;
}

function correct(
  actorId: string,
  signature: PetEventAuthorship,
  pet: { id: string; name: string; publicToken: string },
  targetEventId: string,
  kg: string,
  reason: string | null = null,
) {
  return amendEvent({ id: actorId }, pet, signature, {
    publicToken: pet.publicToken,
    targetEventId,
    reason,
    changes: [{ field: "kg", old: "10", new: kg }],
  });
}

beforeAll(async () => {
  for (const [id, role] of PROFILE_ROLES) {
    await db.execute(sql`
      insert into auth.users (id, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, aud, role)
      values (${id}::uuid, ${`amend-auth-${id.slice(-2)}@dim-test.local`},
        'fake', now(), '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated')
      on conflict (id) do nothing
    `);
    // An UPSERT, not do-nothing: the auth.users insert trigger already created
    // a profile with the default role, and the override cases need admin/govt.
    await db
      .insert(profiles)
      .values({ id, role, accountType: "personal", displayName: `amend-auth-${role}` })
      .onConflictDoUpdate({ target: profiles.id, set: { role } });
  }
});

afterAll(async () => {
  for (const petId of insertedPetIds) {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }
});

describe("amendEvent — who may correct whose record (PO decision 3B)", () => {
  it("an owner corrects a record they wrote", async () => {
    const pet = await insertPet("own");
    const target = await insertWeight(pet.id, { recordedByUserId: OWNER_ID, authorRole: "owner" });
    const result = await correct(OWNER_ID, OWNER_SIGNATURE, pet, target, "11");
    expect(result.ok).toBe(true);
    expect(await countAmendments(pet.id)).toBe(1);
  });

  it("an owner may NOT correct a record a vet wrote — and nothing is appended", async () => {
    const pet = await insertPet("vetrec");
    const target = await insertWeight(pet.id, { recordedByUserId: VET_ID, authorRole: "vet" });
    const result = await correct(OWNER_ID, OWNER_SIGNATURE, pet, target, "11");
    expect(result).toEqual({
      ok: false,
      code: "authorship_refused",
      error: PROFESSIONAL_REFUSAL,
    });
    expect(await countAmendments(pet.id)).toBe(0);
  });

  it("an owner may NOT correct a record a shelter signed", async () => {
    const pet = await insertPet("shelterrec");
    const target = await insertWeight(pet.id, { recordedByUserId: VET_ID, authorRole: "shelter" });
    const result = await correct(OWNER_ID, OWNER_SIGNATURE, pet, target, "11");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("authorship_refused");
  });

  it("a vet corrects a record a vet wrote", async () => {
    const pet = await insertPet("vetvet");
    const target = await insertWeight(pet.id, { recordedByUserId: VET_ID, authorRole: "vet" });
    const result = await correct(VET_ID, VET_SIGNATURE, pet, target, "11");
    expect(result.ok).toBe(true);
    expect(await countAmendments(pet.id)).toBe(1);
  });

  it("a vet MAY correct an owner's entry — the rule is not symmetric", async () => {
    const pet = await insertPet("vetowner");
    const target = await insertWeight(pet.id, { recordedByUserId: OWNER_ID, authorRole: "owner" });
    const result = await correct(VET_ID, VET_SIGNATURE, pet, target, "11");
    expect(result.ok).toBe(true);
  });

  it("an owner may NOT overwrite a vet's correction of the owner's own record", async () => {
    const pet = await insertPet("chain");
    const target = await insertWeight(pet.id, { recordedByUserId: OWNER_ID, authorRole: "owner" });
    expect((await correct(VET_ID, VET_SIGNATURE, pet, target, "12")).ok).toBe(true);
    const result = await correct(OWNER_ID, OWNER_SIGNATURE, pet, target, "13");
    expect(result).toEqual({
      ok: false,
      code: "authorship_refused",
      error: PROFESSIONAL_REFUSAL,
    });
    expect(await countAmendments(pet.id)).toBe(1);
  });

  it("an owner may NOT correct a record another person wrote", async () => {
    const pet = await insertPet("other");
    const target = await insertWeight(pet.id, {
      recordedByUserId: OTHER_OWNER_ID,
      authorRole: "owner",
    });
    const result = await correct(OWNER_ID, OWNER_SIGNATURE, pet, target, "11");
    expect(result).toEqual({ ok: false, code: "authorship_refused", error: NOT_AUTHOR_REFUSAL });
  });

  it("a legacy owner row with no author is the titular's to correct while their tenure covers it", async () => {
    const pet = await insertPet("legacy");
    const target = await insertWeight(pet.id, {
      recordedByUserId: null,
      authorRole: "owner",
      recordedAt: T_2021,
    });
    const result = await correct(OWNER_ID, OWNER_SIGNATURE, pet, target, "11");
    expect(result.ok).toBe(true);
  });

  it("a legacy owner row with no author is NOT a caretaker's to correct", async () => {
    const pet = await insertPet("legacycare");
    await db
      .insert(ownerships)
      .values({ petId: pet.id, ownerUserId: CARETAKER_ID, role: "caretaker" });
    const target = await insertWeight(pet.id, {
      recordedByUserId: null,
      authorRole: "owner",
      recordedAt: T_2021,
    });
    const result = await correct(CARETAKER_ID, OWNER_SIGNATURE, pet, target, "11");
    expect(result).toEqual({ ok: false, code: "authorship_refused", error: NOT_AUTHOR_REFUSAL });
  });

  it("an admin keeps the override on a vet's record", async () => {
    const pet = await insertPet("admin");
    const target = await insertWeight(pet.id, { recordedByUserId: VET_ID, authorRole: "vet" });
    const result = await correct(ADMIN_ID, OWNER_SIGNATURE, pet, target, "11", "Error de carga");
    expect(result.ok).toBe(true);
  });

  it("a govt authority keeps the override on a vet's record", async () => {
    const pet = await insertPet("govt");
    const target = await insertWeight(pet.id, { recordedByUserId: VET_ID, authorRole: "vet" });
    const result = await correct(GOVT_ID, OWNER_SIGNATURE, pet, target, "11", "Error de carga");
    expect(result.ok).toBe(true);
  });

  it("a NEW owner may not correct the previous owner's legacy vaccine", async () => {
    // The previous owner held it 2020-2023 and wrote the vaccine in 2021 with no
    // recorded author; the current owner has held it since 2023.
    const pet = await insertPet("transfer", { withOwner: false });
    await db.insert(ownerships).values([
      {
        petId: pet.id,
        ownerUserId: OTHER_OWNER_ID,
        role: "owner",
        startedAt: T_2020,
        endedAt: T_2023,
      },
      { petId: pet.id, ownerUserId: OWNER_ID, role: "owner", startedAt: T_2023 },
    ]);
    const [vaccine] = await db
      .insert(petEvents)
      .values({
        petId: pet.id,
        eventType: "vaccination_administered",
        occurredAt: T_2021,
        recordedAt: T_2021,
        recordedByUserId: null,
        authorRole: "owner",
        authorOrganizationId: null,
        authorVerified: false,
        payload: { vaccine_name: "Antirrábica" },
      })
      .returning({ id: petEvents.id });
    const result = await amendEvent({ id: OWNER_ID }, pet, OWNER_SIGNATURE, {
      publicToken: pet.publicToken,
      targetEventId: vaccine.id,
      reason: null,
      changes: [{ field: "vaccine_name", old: "Antirrábica", new: "Séxtuple" }],
    });
    expect(result).toEqual({ ok: false, code: "authorship_refused", error: NOT_AUTHOR_REFUSAL });
    expect(await countAmendments(pet.id)).toBe(0);
  });

  it("an UNVERIFIED org member may not correct a verified vet's record", async () => {
    const pet = await insertPet("unverified");
    const target = await insertWeight(pet.id, { recordedByUserId: VET_ID, authorRole: "vet" });
    const result = await correct(OTHER_OWNER_ID, UNVERIFIED_SHELTER_SIGNATURE, pet, target, "11");
    expect(result).toEqual({
      ok: false,
      code: "authorship_refused",
      error: PROFESSIONAL_REFUSAL,
    });
    expect(await countAmendments(pet.id)).toBe(0);
  });

  it("an UNVERIFIED org member may correct what they wrote themselves", async () => {
    const pet = await insertPet("unverifiedown");
    const target = await insertWeight(pet.id, {
      recordedByUserId: OTHER_OWNER_ID,
      authorRole: "shelter",
      authorVerified: false,
    });
    const result = await correct(OTHER_OWNER_ID, UNVERIFIED_SHELTER_SIGNATURE, pet, target, "11");
    expect(result.ok).toBe(true);
  });

  it("the LOCKED recheck refuses when a vet corrects between the early check and the write", async () => {
    const pet = await insertPet("race");
    const target = await insertWeight(pet.id, { recordedByUserId: OWNER_ID, authorRole: "owner" });
    // The early check passes (the record is the owner's and uncorrected); then,
    // before the owner's transaction, a verified vet's correction commits.
    hook.afterEarlyCheck = async () => {
      const now = new Date();
      await db.insert(petEvents).values({
        petId: pet.id,
        eventType: "event_amended",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: VET_ID,
        authorRole: "vet",
        authorOrganizationId: null,
        authorVerified: true,
        payload: {
          target_event_id: target,
          reason: null,
          changes: [{ field: "kg", old: "10", new: "12" }],
          actor_role: "vet",
          actor_user_id: VET_ID,
        },
      });
    };
    const result = await correct(OWNER_ID, OWNER_SIGNATURE, pet, target, "13");
    expect(hook.afterEarlyCheck).toBeNull();
    expect(result).toEqual({
      ok: false,
      code: "authorship_refused",
      error: PROFESSIONAL_REFUSAL,
    });
    // Only the vet's correction exists — the owner's never landed.
    expect(await countAmendments(pet.id)).toBe(1);
  });
});

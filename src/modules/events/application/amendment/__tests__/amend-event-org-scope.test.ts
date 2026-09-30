// Integration tests for the ORG DOOR's scope on amendEvent (portal-vet-p0):
// from Atender a clinic corrects only its OWN records — the root and every
// correction already on it signed by this organization — and only with a
// verified signature. Any verified colleague of that clinic may correct, not
// only the original signer (PO decision 2026-09-30).
//
// Asserted THROUGH the use-case against the local Postgres, because the scope
// binds inside it, on both the early check and the locked recheck. The domain
// rule (`amendAuthorshipRefusal`) is unchanged and still runs after it.
//
// Runs against the local Postgres (vitest setup forces 127.0.0.1:54322).
// Explicit instants everywhere: nothing here compares a host clock with a
// column's defaultNow().

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// The race seam, as in amend-event-authorship.test.ts: runs ONCE, after the
// EARLY check (the one on `db`) and before the locked recheck.
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

import { withMutationOverride } from "@/__tests__/_helpers/db-overrides";
import { db, organizations, petEvents, pets, profiles } from "@/db";
import { ORG_AMENDMENT_SCOPE_REFUSAL_COPY } from "@/lib/infra/amendment";
import type { PetEventAuthorship } from "@/lib/infra/pet-access";
import { amendEvent } from "@/src/modules/events/application/amendment/amend-event";

const VET_A1 = "0a5c0000-0000-4000-8000-000000000001";
const VET_A2 = "0a5c0000-0000-4000-8000-000000000002";
const VET_B = "0a5c0000-0000-4000-8000-000000000003";
const OWNER = "0a5c0000-0000-4000-8000-000000000004";
const MEMBER_A = "0a5c0000-0000-4000-8000-000000000005";

const T_SIGNED = new Date("2026-03-01T12:00:00Z");
const T_EARLIER_FIX = new Date("2026-03-02T12:00:00Z");

const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
const petIds: string[] = [];
let clinicA = "";
let clinicB = "";

const signature = (organizationId: string, verified: boolean): PetEventAuthorship =>
  verified
    ? { authorRole: "vet", authorOrganizationId: organizationId, authorVerified: true }
    : { authorRole: "shelter", authorOrganizationId: organizationId, authorVerified: false };

async function insertOrg(label: string): Promise<string> {
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: `ORGSCOPE-${label}-${suffix}`,
      legalName: `Clinica ${label} ${suffix}`,
      displayName: `Clinica ${label} ${suffix}`,
      orgType: "clinic",
      email: `orgscope-${label.toLowerCase()}-${suffix.toLowerCase()}@example.test`,
    })
    .returning({ id: organizations.id });
  return org.id;
}

async function insertPet(label: string) {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `ORGSCOPE-${label}-${suffix}`,
      name: `Alcance${label}`,
      species: "dog",
      sex: "female",
      status: "active",
    })
    .returning();
  petIds.push(pet.id);
  return pet;
}

/** A vaccine the way Atender writes one: signed by `org` (null = the owner). */
async function insertVaccine(
  petId: string,
  author: { userId: string; org: string | null; verified: boolean },
): Promise<string> {
  const [row] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "vaccination_administered",
      occurredAt: T_SIGNED,
      recordedAt: T_SIGNED,
      recordedByUserId: author.userId,
      authorRole: author.org === null ? "owner" : author.verified ? "vet" : "shelter",
      authorOrganizationId: author.org,
      authorVerified: author.verified,
      payload: {
        vaccine_name: "Antirrábica",
        brand: null,
        batch: "L-1",
        administered_by: null,
        next_due_at: null,
      },
    })
    .returning({ id: petEvents.id });
  return row.id;
}

/** A correction already on the record, signed by `org` (null = no organization). */
async function insertCorrection(
  petId: string,
  targetEventId: string,
  author: { userId: string; org: string | null; actorRole: string },
) {
  await db.insert(petEvents).values({
    petId,
    eventType: "event_amended",
    occurredAt: T_EARLIER_FIX,
    recordedAt: T_EARLIER_FIX,
    recordedByUserId: author.userId,
    authorRole: author.org === null ? "owner" : "vet",
    authorOrganizationId: author.org,
    authorVerified: author.org !== null,
    payload: {
      target_event_id: targetEventId,
      reason: "corrección previa",
      changes: [{ field: "batch", old: "L-1", new: "L-2" }],
      actor_role: author.actorRole,
      actor_user_id: author.userId,
    },
  });
}

async function countAmendments(petId: string) {
  const rows = await db
    .select({ id: petEvents.id })
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "event_amended")));
  return rows.length;
}

function correctFromAtender(
  actorId: string,
  sig: PetEventAuthorship,
  organizationId: string,
  pet: { id: string; name: string; publicToken: string },
  targetEventId: string,
  lot: string,
) {
  return amendEvent(
    { id: actorId },
    pet,
    sig,
    {
      publicToken: pet.publicToken,
      targetEventId,
      reason: "Lote mal transcripto",
      changes: [{ field: "batch", old: "L-1", new: lot }],
    },
    { orgScope: { organizationId } },
  );
}

beforeAll(async () => {
  for (const [id, role] of [
    [VET_A1, "vet"],
    [VET_A2, "vet"],
    [VET_B, "vet"],
    [OWNER, "owner"],
    [MEMBER_A, "owner"],
  ] as const) {
    await db.execute(sql`
      insert into auth.users (id, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, aud, role)
      values (${id}::uuid, ${`org-scope-${id.slice(-2)}@dim-test.local`},
        'fake', now(), '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated')
      on conflict (id) do nothing
    `);
    await db
      .insert(profiles)
      .values({ id, role, accountType: "personal", displayName: `org-scope-${role}` })
      .onConflictDoUpdate({ target: profiles.id, set: { role } });
  }
  clinicA = await insertOrg("A");
  clinicB = await insertOrg("B");
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    if (petIds.length > 0) await tx.delete(pets).where(inArray(pets.id, petIds));
    const orgIds = [clinicA, clinicB].filter(Boolean);
    if (orgIds.length > 0) await tx.delete(organizations).where(inArray(organizations.id, orgIds));
  });
});

describe("amendEvent with the org door — a clinic corrects its own records", () => {
  it("the signer corrects her own vaccine", async () => {
    const pet = await insertPet("self");
    const target = await insertVaccine(pet.id, { userId: VET_A1, org: clinicA, verified: true });
    const result = await correctFromAtender(
      VET_A1,
      signature(clinicA, true),
      clinicA,
      pet,
      target,
      "L-9",
    );
    expect(result.ok).toBe(true);
    expect(await countAmendments(pet.id)).toBe(1);
  });

  it("a verified COLLEAGUE of the same clinic corrects it, and the correction is signed by her", async () => {
    const pet = await insertPet("colleague");
    const target = await insertVaccine(pet.id, { userId: VET_A1, org: clinicA, verified: true });
    const result = await correctFromAtender(
      VET_A2,
      signature(clinicA, true),
      clinicA,
      pet,
      target,
      "L-9",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [row] = await db
      .select({
        recordedByUserId: petEvents.recordedByUserId,
        authorOrganizationId: petEvents.authorOrganizationId,
        authorVerified: petEvents.authorVerified,
      })
      .from(petEvents)
      .where(eq(petEvents.id, result.amendmentEventId));
    expect(row).toEqual({
      recordedByUserId: VET_A2,
      authorOrganizationId: clinicA,
      authorVerified: true,
    });
  });

  it("the chain continues: a record this clinic already corrected is still its to correct", async () => {
    const pet = await insertPet("chain");
    const target = await insertVaccine(pet.id, { userId: VET_A1, org: clinicA, verified: true });
    await insertCorrection(pet.id, target, { userId: VET_A1, org: clinicA, actorRole: "vet" });
    const result = await correctFromAtender(
      VET_A2,
      signature(clinicA, true),
      clinicA,
      pet,
      target,
      "L-3",
    );
    expect(result.ok).toBe(true);
    expect(await countAmendments(pet.id)).toBe(2);
  });

  it("refuses ANOTHER clinic's record — nothing is appended", async () => {
    const pet = await insertPet("otherclinic");
    const target = await insertVaccine(pet.id, { userId: VET_B, org: clinicB, verified: true });
    const result = await correctFromAtender(
      VET_A1,
      signature(clinicA, true),
      clinicA,
      pet,
      target,
      "L-9",
    );
    expect(result).toEqual({
      ok: false,
      code: "authorship_refused",
      error: ORG_AMENDMENT_SCOPE_REFUSAL_COPY.other_author,
    });
    expect(await countAmendments(pet.id)).toBe(0);
  });

  it("refuses an OWNER's entry, though a verified vet could correct it through custody", async () => {
    const pet = await insertPet("ownerentry");
    const target = await insertVaccine(pet.id, { userId: OWNER, org: null, verified: false });
    const result = await correctFromAtender(
      VET_A1,
      signature(clinicA, true),
      clinicA,
      pet,
      target,
      "L-9",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(ORG_AMENDMENT_SCOPE_REFUSAL_COPY.other_author);
    expect(await countAmendments(pet.id)).toBe(0);
  });

  it("refuses an UNVERIFIED member of the same clinic (or one whose matrícula was revoked)", async () => {
    const pet = await insertPet("unverified");
    // Signed verified by the member back then; she signs unverified today.
    const target = await insertVaccine(pet.id, { userId: MEMBER_A, org: clinicA, verified: true });
    const result = await correctFromAtender(
      MEMBER_A,
      signature(clinicA, false),
      clinicA,
      pet,
      target,
      "L-9",
    );
    expect(result).toEqual({
      ok: false,
      code: "authorship_refused",
      error: ORG_AMENDMENT_SCOPE_REFUSAL_COPY.unverified_signer,
    });
    expect(await countAmendments(pet.id)).toBe(0);
  });

  it("refuses a record whose chain carries an admin correction (no organization)", async () => {
    const pet = await insertPet("adminchain");
    const target = await insertVaccine(pet.id, { userId: VET_A1, org: clinicA, verified: true });
    await insertCorrection(pet.id, target, { userId: OWNER, org: null, actorRole: "admin" });
    const result = await correctFromAtender(
      VET_A2,
      signature(clinicA, true),
      clinicA,
      pet,
      target,
      "L-9",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(ORG_AMENDMENT_SCOPE_REFUSAL_COPY.other_author);
    expect(await countAmendments(pet.id)).toBe(1);
  });

  it("the LOCKED recheck refuses when another clinic corrects between the early check and the write", async () => {
    const pet = await insertPet("race");
    const target = await insertVaccine(pet.id, { userId: VET_A1, org: clinicA, verified: true });
    hook.afterEarlyCheck = async () => {
      await insertCorrection(pet.id, target, { userId: VET_B, org: clinicB, actorRole: "vet" });
    };
    const result = await correctFromAtender(
      VET_A2,
      signature(clinicA, true),
      clinicA,
      pet,
      target,
      "L-9",
    );
    expect(hook.afterEarlyCheck).toBeNull();
    expect(result).toEqual({
      ok: false,
      code: "authorship_refused",
      error: ORG_AMENDMENT_SCOPE_REFUSAL_COPY.other_author,
    });
    // Only clinic B's correction exists — clinic A's never landed.
    expect(await countAmendments(pet.id)).toBe(1);
  });

  it("leaves the doors without an org scope unchanged: a verified vet still corrects another clinic's record through custody", async () => {
    const pet = await insertPet("nodoor");
    const target = await insertVaccine(pet.id, { userId: VET_B, org: clinicB, verified: true });
    const result = await amendEvent({ id: VET_A1 }, pet, signature(clinicA, true), {
      publicToken: pet.publicToken,
      targetEventId: target,
      reason: null,
      changes: [{ field: "batch", old: "L-1", new: "L-9" }],
    });
    expect(result.ok).toBe(true);
  });
});

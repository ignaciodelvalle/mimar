// The Atender correction, at the ACTION edge, against the local Postgres
// (portal-vet-p0).
//
// What is real: the walk-in resolver (org lookup, active membership, granted
// capabilities, the signer's matrícula), the pet lookup, amendEvent with its
// org scope and locked recheck, and completeAtenderSignature. What is mocked is
// only what a test process cannot have: the session (requireLiveUser — there is
// no cookie), the request headers, the rate-limit bucket store, Next's cache,
// and the owner notification's delivery (captured, so the notice's words and
// the "not on a replay" rule are asserted without writing an inbox).
//
// The authorization matrix, each through the real membership and profile rows:
//   · a same-clinic verified colleague corrects        → allowed, owner told
//   · another clinic's record                           → refused
//   · an owner's entry                                  → refused
//   · a member with event.write but no matrícula        → refused
//   · a vet whose matrícula was revoked                 → refused
//   · a receptionist (member without event.write)       → refused
// Every refusal appends nothing and tells nobody.

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const session = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () => ({
      ok: true,
      supabase: null,
      user: { id: session.userId },
      sessionStartedAt: new Date(),
    }),
  };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return { ...actual, enforceRateLimit: vi.fn(async () => undefined) };
});

const notifyOwners = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ delivered: 1 })));
vi.mock("@/lib/infra/notify-owners-of-clinical-event", () => ({
  notifyOwnersOfClinicalEvent: notifyOwners,
}));

import { withMutationOverride } from "@/__tests__/_helpers/db-overrides";
import {
  db,
  organizationCapabilityGrants,
  organizationMemberships,
  organizations,
  petEvents,
  pets,
  profiles,
} from "@/db";

import { atenderAmendEventAction } from "./actions";

const VET_A1 = "0a5d0000-0000-4000-8000-000000000001";
const VET_A2 = "0a5d0000-0000-4000-8000-000000000002";
const VET_B = "0a5d0000-0000-4000-8000-000000000003";
const OWNER = "0a5d0000-0000-4000-8000-000000000004";
const MEMBER_A = "0a5d0000-0000-4000-8000-000000000005";
const RECEPTION_A = "0a5d0000-0000-4000-8000-000000000006";
const REVOKED_A = "0a5d0000-0000-4000-8000-000000000007";

const T_SIGNED = new Date("2026-03-01T12:00:00Z");

const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randomBlock = () =>
  Array.from({ length: 4 }, () => TOKEN_ALPHABET[Math.floor(Math.random() * 31)]).join("");

const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
const petIds: string[] = [];
const org = { a: { id: "", token: "" }, b: { id: "", token: "" } };

async function upsertPerson(id: string, profile: Partial<typeof profiles.$inferInsert>) {
  await db.execute(sql`
    insert into auth.users (id, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, aud, role)
    values (${id}::uuid, ${`atender-amend-${id.slice(-2)}@dim-test.local`},
      'fake', now(), '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated')
    on conflict (id) do nothing
  `);
  const values = {
    role: "owner" as const,
    accountType: "personal" as const,
    displayName: `atender-amend-${id.slice(-2)}`,
    matriculaNumber: null,
    matriculaVerified: false,
    deletedAt: null,
    ...profile,
  };
  await db
    .insert(profiles)
    .values({ id, ...values })
    .onConflictDoUpdate({ target: profiles.id, set: values });
}

async function insertOrg(label: string) {
  const token = `AMENDORG-${label}-${suffix}`;
  const [row] = await db
    .insert(organizations)
    .values({
      publicToken: token,
      legalName: `Clinica ${label} ${suffix}`,
      displayName: `Clinica ${label} ${suffix}`,
      orgType: "clinic",
      email: `amendorg-${label.toLowerCase()}-${suffix.toLowerCase()}@example.test`,
    })
    .returning({ id: organizations.id });
  return { id: row.id, token };
}

async function join(
  organizationId: string,
  userId: string,
  role: "vet_individual" | "member",
  grantEventWrite = false,
) {
  const [m] = await db
    .insert(organizationMemberships)
    .values({ organizationId, userId, role })
    .returning({ id: organizationMemberships.id });
  if (grantEventWrite) {
    await db.insert(organizationCapabilityGrants).values({
      membershipId: m.id,
      organizationId,
      capability: "event.write",
      status: "approved",
    });
  }
}

async function insertPet() {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `DIM-${randomBlock()}-${randomBlock()}`,
      name: `Corregible${suffix}`,
      species: "dog",
      sex: "female",
      status: "active",
    })
    .returning();
  petIds.push(pet.id);
  return pet;
}

async function insertVaccine(
  petId: string,
  author: { userId: string; org: string | null },
): Promise<string> {
  const [row] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "vaccination_administered",
      occurredAt: T_SIGNED,
      recordedAt: T_SIGNED,
      recordedByUserId: author.userId,
      authorRole: author.org === null ? "owner" : "vet",
      authorOrganizationId: author.org,
      authorVerified: author.org !== null,
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

async function amendmentsOf(petId: string) {
  return db
    .select({ id: petEvents.id, recordedByUserId: petEvents.recordedByUserId })
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "event_amended")));
}

function correct(
  as: string,
  orgToken: string,
  pet: { publicToken: string },
  targetEventId: string,
  reason: string | null = "Lote mal transcripto",
  batch = "L-9",
) {
  session.userId = as;
  return atenderAmendEventAction(orgToken, pet.publicToken, {
    targetEventId,
    reason,
    changes: [{ field: "batch", old: "L-1", new: batch }],
  });
}

beforeAll(async () => {
  const vet = (n: string) => ({
    role: "vet" as const,
    matriculaNumber: `MN-AMEND-${n}`,
    matriculaVerified: true,
  });
  await upsertPerson(VET_A1, vet("A1"));
  await upsertPerson(VET_A2, vet("A2"));
  await upsertPerson(VET_B, vet("B"));
  await upsertPerson(OWNER, {});
  await upsertPerson(MEMBER_A, {});
  await upsertPerson(RECEPTION_A, {});
  // A vet whose matrícula verification was revoked: role still vet, no longer
  // verified — which is what a revocation leaves on the profile.
  await upsertPerson(REVOKED_A, { ...vet("R"), matriculaVerified: false });

  org.a = await insertOrg("A");
  org.b = await insertOrg("B");
  await join(org.a.id, VET_A1, "vet_individual");
  await join(org.a.id, VET_A2, "vet_individual");
  await join(org.a.id, MEMBER_A, "member", true);
  await join(org.a.id, RECEPTION_A, "member");
  await join(org.a.id, REVOKED_A, "vet_individual");
  await join(org.b.id, VET_B, "vet_individual");
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    if (petIds.length > 0) await tx.delete(pets).where(inArray(pets.id, petIds));
    const orgIds = [org.a.id, org.b.id].filter(Boolean);
    // Memberships and grants cascade with the organization.
    if (orgIds.length > 0) await tx.delete(organizations).where(inArray(organizations.id, orgIds));
  });
});

beforeEach(() => {
  notifyOwners.mockClear();
});

describe("atenderAmendEventAction — a same-clinic colleague corrects, the owner is told", () => {
  it("writes the correction signed by the colleague and returns the ?corregido=1 receipt", async () => {
    const pet = await insertPet();
    const target = await insertVaccine(pet.id, { userId: VET_A1, org: org.a.id });

    const result = await correct(VET_A2, org.a.token, pet, target);

    expect(result).toEqual({
      ok: true,
      error: null,
      redirectTo: `/org/${org.a.token}/atender/${pet.publicToken}?corregido=1`,
    });
    const rows = await amendmentsOf(pet.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].recordedByUserId).toBe(VET_A2);

    expect(notifyOwners).toHaveBeenCalledTimes(1);
    const alert = notifyOwners.mock.calls[0][0] as Record<string, unknown>;
    expect(alert.eventId).toBe(rows[0].id);
    expect(alert.eventType).toBe("event_amended");
    expect(alert.authorUserId).toBe(VET_A2);
    expect(alert.notice).toEqual({
      notificationType: "professional_event_amended",
      severity: "info",
      title: `Se corrigió un registro de ${pet.name}`,
      body: `Clinica A ${suffix} corrigió un registro de la libreta de ${pet.name}. El registro original sigue visible en el historial. Motivo: Lote mal transcripto.`,
      relatedCaseId: null,
      ctaLabel: "Ver el registro",
      ctaUrl: `/mis-mascotas/${pet.publicToken}/eventos/${target}`,
    });
  });

  it("an identical resubmit appends nothing and does not tell the owner twice", async () => {
    const pet = await insertPet();
    const target = await insertVaccine(pet.id, { userId: VET_A1, org: org.a.id });

    expect((await correct(VET_A1, org.a.token, pet, target)).ok).toBe(true);
    const replay = await correct(VET_A1, org.a.token, pet, target);

    expect(replay.ok).toBe(true);
    expect(await amendmentsOf(pet.id)).toHaveLength(1);
    expect(notifyOwners).toHaveBeenCalledTimes(1);
  });

  it("refuses a reason shorter than 5 characters — before any write", async () => {
    const pet = await insertPet();
    const target = await insertVaccine(pet.id, { userId: VET_A1, org: org.a.id });

    for (const reason of [null, "", "  ab  ", "1234"]) {
      const result = await correct(VET_A1, org.a.token, pet, target, reason);
      expect(result).toEqual({
        ok: false,
        error: "Contá el motivo de la corrección (mínimo 5 caracteres). Es lo que lee el dueño.",
      });
    }
    expect(await amendmentsOf(pet.id)).toHaveLength(0);
    expect(notifyOwners).not.toHaveBeenCalled();
  });
});

describe("atenderAmendEventAction — who is refused", () => {
  async function expectRefused(
    as: string,
    target: { petId: string; publicToken: string; eventId: string },
    error: string,
  ) {
    const result = await correct(as, org.a.token, target, target.eventId);
    expect(result).toEqual({ ok: false, error });
    expect(await amendmentsOf(target.petId)).toHaveLength(0);
    expect(notifyOwners).not.toHaveBeenCalled();
  }

  async function vaccineBy(author: { userId: string; org: string | null }) {
    const pet = await insertPet();
    const eventId = await insertVaccine(pet.id, author);
    return { petId: pet.id, publicToken: pet.publicToken, eventId };
  }

  it("another clinic's record", async () => {
    await expectRefused(
      VET_A1,
      await vaccineBy({ userId: VET_B, org: org.b.id }),
      "Desde Atender solo se corrigen registros que cargó esta organización.",
    );
  });

  it("an owner's entry", async () => {
    await expectRefused(
      VET_A1,
      await vaccineBy({ userId: OWNER, org: null }),
      "Desde Atender solo se corrigen registros que cargó esta organización.",
    );
  });

  it("a member with event.write but no validated matrícula", async () => {
    await expectRefused(
      MEMBER_A,
      await vaccineBy({ userId: VET_A1, org: org.a.id }),
      "Para corregir un registro desde Atender necesitás tu matrícula validada.",
    );
  });

  it("a vet whose matrícula was revoked (the credential caps go with it)", async () => {
    await expectRefused(
      REVOKED_A,
      await vaccineBy({ userId: VET_A1, org: org.a.id }),
      "Necesitás el permiso 'Registrar eventos clínicos' (event.write). Pediselo a un administrador.",
    );
  });

  it("a receptionist — a member without event.write", async () => {
    await expectRefused(
      RECEPTION_A,
      await vaccineBy({ userId: VET_A1, org: org.a.id }),
      "Necesitás el permiso 'Registrar eventos clínicos' (event.write). Pediselo a un administrador.",
    );
  });

  it("a malformed record id answers 'not found', never a database error", async () => {
    const pet = await insertPet();
    const result = await correct(VET_A1, org.a.token, pet, "not-a-uuid");
    expect(result).toEqual({ ok: false, error: "Registro no encontrado." });
  });
});

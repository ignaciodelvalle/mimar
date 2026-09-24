// Integration tests for submitAdoptionApplicationAction (spec
// adoption-listing-public Fase 5). Same E2E style as foster-e2e-flow: mock
// only `createClient` so the action reads "current user" from a stub.
//
// Covers:
//   - happy path: pet listable, applicant personal → row inserted +
//     notifs fanned out to org admin/coordinator.
//   - idempotency: a second submit by the same applicant for the same
//     pet returns { error } and does not insert a second event.
//   - pet no longer listable (paused) → { error }.
//   - institutional applicant → { error }.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import {
  db,
  notifications,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { createClient } from "@/lib/supabase/server";
import { submitAdoptionApplicationAction } from "@/src/modules/adoption/actions";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const APPLICANT_EMAIL = "adopt-app-applicant@dim-test.local";
const COORD_EMAIL = "adopt-app-coord@dim-test.local";
const ADMIN_EMAIL = "adopt-app-admin@dim-test.local";
const PASS = "AdoptApp_2026!";

let applicantUserId: string;
let coordUserId: string;
let adminUserId: string;
let orgId: string;
let petId: string;
let petToken: string;

function mockSessionAs(userId: string) {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: { id: userId } as unknown },
        error: null,
      }),
    },
  } as never);
}

async function purgeUserByEmail(email: string) {
  const { data } = await supabaseAdmin.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === email);
  const displayName = email.split("@")[0];
  const orphans = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));
  const ids = [
    ...(found ? [found.id] : []),
    ...orphans.map((o) => o.id).filter((id) => id !== found?.id),
  ];
  // Deleting profiles cascades to pet_events.recorded_by_user_id (ON DELETE
  // SET NULL), which triggers the append-only protection. Wrap so the
  // cascading UPDATE is allowed.
  await withMutationOverride(async (tx) => {
    for (const uid of ids) {
      await tx.delete(notifications).where(eq(notifications.userId, uid));
      await tx.delete(organizationMemberships).where(eq(organizationMemberships.userId, uid));
      await tx.delete(profiles).where(eq(profiles.id, uid));
    }
  });
  if (found) await supabaseAdmin.auth.admin.deleteUser(found.id);
}

beforeAll(async () => {
  // Clean up any leftover rows from a previous crashed run (hardcoded tokens).
  await withMutationOverride(async (tx) => {
    const stalePets = await tx
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, "DIM-AAPP-PET1"));
    for (const { id } of stalePets) {
      await tx.delete(notifications).where(eq(notifications.relatedPetId, id));
      await tx.delete(ownerships).where(eq(ownerships.petId, id));
      await tx.delete(petEvents).where(eq(petEvents.petId, id));
      await tx.delete(pets).where(eq(pets.id, id));
    }
  });
  const staleOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.publicToken, "DIM-ADOPTAPP-001"));
  for (const { id } of staleOrgs) {
    await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, id));
    await db.delete(organizations).where(eq(organizations.id, id));
  }

  await purgeUserByEmail(APPLICANT_EMAIL);
  await purgeUserByEmail(COORD_EMAIL);
  await purgeUserByEmail(ADMIN_EMAIL);

  for (const [email, ref] of [
    [APPLICANT_EMAIL, "applicant"] as const,
    [COORD_EMAIL, "coord"] as const,
    [ADMIN_EMAIL, "admin"] as const,
  ]) {
    const r = await createFreshTestUser(supabaseAdmin, {
      email,
      password: PASS,
      email_confirm: true,
    });
    if (r.error || !r.data.user) throw new Error(`createUser ${ref}: ${r.error?.message}`);
    if (ref === "applicant") applicantUserId = r.data.user.id;
    if (ref === "coord") coordUserId = r.data.user.id;
    if (ref === "admin") adminUserId = r.data.user.id;
  }

  await db
    .update(profiles)
    .set({
      displayName: "Applicant Test",
      role: "owner",
      accountType: "personal",
    })
    .where(eq(profiles.id, applicantUserId));

  await db
    .update(profiles)
    .set({
      displayName: "Coord Test",
      role: "owner",
      accountType: "personal",
    })
    .where(eq(profiles.id, coordUserId));

  await db
    .update(profiles)
    .set({
      displayName: "Admin Test",
      role: "owner",
      accountType: "personal",
    })
    .where(eq(profiles.id, adminUserId));

  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: "DIM-ADOPTAPP-001",
      legalName: "Adopt App Test Refugio SRL",
      displayName: "Adopt App Refugio",
      orgType: "shelter",
      email: "adopt-app@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;

  await db.insert(organizationMemberships).values([
    {
      organizationId: orgId,
      userId: coordUserId,
      role: "coordinator",
      canWritePetEvents: true,
    },
    {
      organizationId: orgId,
      userId: adminUserId,
      role: "admin",
      canWritePetEvents: true,
    },
  ]);

  // Pet listable: shelter_custody, listed, eligible.
  const now = new Date();
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-AAPP-PET1",
      name: "Toto",
      species: "dog",
      sex: "male",
      potentiallyDangerousBreed: false,
      adoptionListedAt: now,
      adoptionListingPausedAt: null,
      adoptionEligible: true,
      adoptionEligibilitySetAt: now,
      inCustodyDispute: false,
      rabiesObservationStatus: null,
    })
    .returning();
  petId = pet.id;
  petToken = pet.publicToken;

  await db.insert(ownerships).values({
    petId,
    ownerOrganizationId: orgId,
    role: "shelter_custody",
    startedAt: now,
  });
});

afterAll(async () => {
  await db.delete(notifications).where(eq(notifications.relatedPetId, petId));
  await db.delete(ownerships).where(eq(ownerships.petId, petId));
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(eq(petEvents.petId, petId));
    await tx.delete(pets).where(eq(pets.id, petId));
  });
  await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await purgeUserByEmail(APPLICANT_EMAIL);
  await purgeUserByEmail(COORD_EMAIL);
  await purgeUserByEmail(ADMIN_EMAIL);
});

describe("submitAdoptionApplicationAction", () => {
  it("happy path: inserts event + fans out notifications to admin+coordinator", async () => {
    mockSessionAs(applicantUserId);
    const result = await submitAdoptionApplicationAction({
      petPublicToken: petToken,
      housingType: "casa_con_patio",
      otherPets: "Un gato adulto",
      dailyRoutine: "Trabajo en casa 3 días por semana.",
      notes: null,
      profileSharingConsent: true,
      motivation: "Quiero adoptar a esta mascota y darle un hogar lleno de amor y cuidado.",
      priorPets: "yes_before",
    });
    expect("ok" in result && result.ok).toBe(true);
    if (!("ok" in result)) throw new Error(result.error);

    const events = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, petId), eq(petEvents.eventType, "adoption_application_submitted")),
      );
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(result.applicationEventId);

    const notifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.relatedPetId, petId));
    const recipients = notifs.map((n) => n.userId).sort();
    expect(recipients).toEqual([coordUserId, adminUserId].sort());
  });

  it("idempotency: second submit by same applicant for same pet returns error", async () => {
    mockSessionAs(applicantUserId);
    const result = await submitAdoptionApplicationAction({
      petPublicToken: petToken,
      housingType: "departamento",
      otherPets: null,
      dailyRoutine: null,
      notes: null,
      profileSharingConsent: true,
      motivation: "Quiero adoptar a esta mascota y darle un hogar lleno de amor y cuidado.",
      priorPets: "yes_before",
    });
    expect("error" in result).toBe(true);

    const events = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, petId), eq(petEvents.eventType, "adoption_application_submitted")),
      );
    expect(events).toHaveLength(1);
  });

  it("pet no longer listable (paused) returns error", async () => {
    await db.update(pets).set({ adoptionListingPausedAt: new Date() }).where(eq(pets.id, petId));

    // Different applicant to bypass idempotency.
    mockSessionAs(coordUserId);
    const result = await submitAdoptionApplicationAction({
      petPublicToken: petToken,
      housingType: "casa_con_patio",
      otherPets: null,
      dailyRoutine: null,
      notes: null,
      profileSharingConsent: true,
      motivation: "Quiero adoptar a esta mascota y darle un hogar lleno de amor y cuidado.",
      priorPets: "yes_before",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("ya no está disponible");
    }

    // Restore for any later tests.
    await db.update(pets).set({ adoptionListingPausedAt: null }).where(eq(pets.id, petId));
  });

  it("institutional applicant returns error", async () => {
    // Temporarily flip applicant to institutional. We'll restore right after.
    await db
      .update(profiles)
      .set({ accountType: "institutional", role: "admin" })
      .where(eq(profiles.id, applicantUserId));

    mockSessionAs(applicantUserId);
    const result = await submitAdoptionApplicationAction({
      petPublicToken: petToken,
      housingType: "casa_con_patio",
      otherPets: null,
      dailyRoutine: null,
      notes: null,
      profileSharingConsent: true,
      motivation: "Quiero adoptar a esta mascota y darle un hogar lleno de amor y cuidado.",
      priorPets: "yes_before",
    });
    expect("error" in result).toBe(true);

    await db
      .update(profiles)
      .set({ accountType: "personal", role: "owner" })
      .where(eq(profiles.id, applicantUserId));
  });

  it("anonymous (no session) returns error without writing", async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: async () => ({ data: { user: null }, error: null }),
      },
    } as never);
    const result = await submitAdoptionApplicationAction({
      petPublicToken: petToken,
      housingType: "casa_con_patio",
      otherPets: null,
      dailyRoutine: null,
      notes: null,
      profileSharingConsent: true,
      motivation: "Quiero adoptar a esta mascota y darle un hogar lleno de amor y cuidado.",
      priorPets: "yes_before",
    });
    expect("error" in result).toBe(true);
  });

  it("missing consent returns error containing 'consentimiento'", async () => {
    mockSessionAs(adminUserId);
    const result = await submitAdoptionApplicationAction({
      petPublicToken: petToken,
      housingType: "casa_con_patio",
      otherPets: null,
      dailyRoutine: null,
      notes: null,
      profileSharingConsent: false,
      motivation: null,
      priorPets: null,
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.toLowerCase()).toContain("consentimiento");
    }
  });

  it("with consent: emitted event payload contains profile_sharing_consent_at", async () => {
    // Use adminUserId — no prior pending application for this user.
    mockSessionAs(adminUserId);

    // Temporarily set adminUserId profile to personal so it passes the institutional check.
    await db
      .update(profiles)
      .set({ accountType: "personal", role: "owner" })
      .where(eq(profiles.id, adminUserId));

    const result = await submitAdoptionApplicationAction({
      petPublicToken: petToken,
      housingType: "departamento",
      otherPets: null,
      dailyRoutine: null,
      notes: null,
      profileSharingConsent: true,
      motivation: "Quiero adoptar a esta mascota y darle un hogar lleno de amor y cuidado.",
      priorPets: "yes_before",
    });
    expect("ok" in result && result.ok).toBe(true);
    if (!("ok" in result)) throw new Error("error" in result ? result.error : "unknown");

    const [event] = await db
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(eq(petEvents.id, result.applicationEventId));
    const consentAt = (event?.payload as Record<string, unknown>)?.profile_sharing_consent_at;
    expect(typeof consentAt).toBe("string");
    expect(consentAt as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// Belt-and-suspenders cleanup — keep the linter happy even if a test bails
// out before the last assertion.
void isNull;

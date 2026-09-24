// Integration test for the auto-rejection cascade triggered by
// finalizeAdoptionAction (spec adoption-listing-public Fase 5.5).
//
// Setup: 3 applicants postulan a la misma mascota. El refugio finaliza la
// adopción para el applicant #1. Esperamos:
//   - 1 adoption_finalized event para applicant #1 (su postulación queda
//     "finalized_to_me" porque hay un adoption_finalized con adopter=ella).
//   - 2 adoption_application_rejected events con auto_generated=true para
//     applicants #2 y #3.
//   - 2 notifications "adoption_application_closed" enviadas.
//   - El applicant #1 no recibe un _rejected (no aplica).

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { dniLast4, hashDni } from "@/lib/utils/dni-hash";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import {
  caseEvents,
  cases,
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

const APPLICANT_1_EMAIL = "adopt-cascade-app1@dim-test.local";
const APPLICANT_2_EMAIL = "adopt-cascade-app2@dim-test.local";
const APPLICANT_3_EMAIL = "adopt-cascade-app3@dim-test.local";
const COORD_EMAIL = "adopt-cascade-coord@dim-test.local";
const PASS = "AdoptCascade_2026!";

let applicant1Id: string;
let applicant2Id: string;
let applicant3Id: string;
let coordUserId: string;
let orgId: string;
let orgToken: string;
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
      await tx.delete(ownerships).where(eq(ownerships.ownerUserId, uid));
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
      .where(eq(pets.publicToken, "DIM-CASC-PET1"));
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
    .where(eq(organizations.publicToken, "DIM-CASCADE-001"));
  for (const { id } of staleOrgs) {
    await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, id));
    await db.delete(organizations).where(eq(organizations.id, id));
  }

  for (const email of [APPLICANT_1_EMAIL, APPLICANT_2_EMAIL, APPLICANT_3_EMAIL, COORD_EMAIL]) {
    await purgeUserByEmail(email);
  }

  const users: { email: string; ref: "app1" | "app2" | "app3" | "coord" }[] = [
    { email: APPLICANT_1_EMAIL, ref: "app1" },
    { email: APPLICANT_2_EMAIL, ref: "app2" },
    { email: APPLICANT_3_EMAIL, ref: "app3" },
    { email: COORD_EMAIL, ref: "coord" },
  ];
  for (const u of users) {
    const r = await createFreshTestUser(supabaseAdmin, {
      email: u.email,
      password: PASS,
      email_confirm: true,
    });
    if (r.error || !r.data.user) throw new Error(`createUser ${u.ref}: ${r.error?.message}`);
    if (u.ref === "app1") applicant1Id = r.data.user.id;
    if (u.ref === "app2") applicant2Id = r.data.user.id;
    if (u.ref === "app3") applicant3Id = r.data.user.id;
    if (u.ref === "coord") coordUserId = r.data.user.id;
  }

  // All applicants need a personal owner profile with DNI to be eligible
  // as a non-stub adopter. Applicant1 specifically needs a verified DNI
  // because finalizeAdoptionAction takes DNI as input.
  await db
    .update(profiles)
    .set({
      displayName: "Applicant One",
      phone: "+541111111111",
      dniHash: hashDni("30000001"),
      dniLast4: dniLast4("30000001"),
      dniVerified: true,
      role: "owner",
      accountType: "personal",
    })
    .where(eq(profiles.id, applicant1Id));
  await db
    .update(profiles)
    .set({
      displayName: "Applicant Two",
      role: "owner",
      accountType: "personal",
    })
    .where(eq(profiles.id, applicant2Id));
  await db
    .update(profiles)
    .set({
      displayName: "Applicant Three",
      role: "owner",
      accountType: "personal",
    })
    .where(eq(profiles.id, applicant3Id));
  await db
    .update(profiles)
    .set({
      displayName: "Cascade Coord",
      role: "owner",
      accountType: "personal",
    })
    .where(eq(profiles.id, coordUserId));

  orgToken = "DIM-CASCADE-001";
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: orgToken,
      legalName: "Cascade Test Refugio SRL",
      displayName: "Cascade Refugio",
      orgType: "shelter",
      email: "cascade@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;

  await db.insert(organizationMemberships).values({
    organizationId: orgId,
    userId: coordUserId,
    role: "admin",
    canWritePetEvents: true,
  });

  const now = new Date();
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-CASC-PET1",
      name: "Cascada",
      species: "dog",
      sex: "female",
      potentiallyDangerousBreed: false,
      adoptionListedAt: now,
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
  for (const email of [APPLICANT_1_EMAIL, APPLICANT_2_EMAIL, APPLICANT_3_EMAIL, COORD_EMAIL]) {
    await purgeUserByEmail(email);
  }
});

describe("F5.5 auto-rejection cascade in finalizeAdoptionAction", () => {
  it("rejects other pending applications + notifies their applicants", async () => {
    // 3 applicants postulan.
    for (const userId of [applicant1Id, applicant2Id, applicant3Id]) {
      mockSessionAs(userId);
      const r = await submitAdoptionApplicationAction({
        petPublicToken: petToken,
        housingType: "casa_con_patio",
        otherPets: null,
        dailyRoutine: null,
        notes: null,
        profileSharingConsent: true,
        motivation: "Quiero adoptar a esta mascota y darle un hogar lleno de amor y cuidado.",
        priorPets: "yes_before",
      });
      expect("ok" in r && r.ok).toBe(true);
    }

    // Sanity: 3 submitted events.
    const beforeFinalize = await db
      .select({ type: petEvents.eventType })
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, petId), eq(petEvents.eventType, "adoption_application_submitted")),
      );
    expect(beforeFinalize).toHaveLength(3);

    // Coord finalizes to applicant1 (using their verified DNI).
    mockSessionAs(coordUserId);
    const { finalizeAdoptionAction } = await import("@/src/modules/adoption/actions");
    const formData = new FormData();
    formData.set("adopterDni", "30000001");
    formData.set("adopterDisplayName", "Applicant One");
    formData.set("adopterPhone", "+541111111111");
    formData.set("followupMonths", "0");
    formData.set("notes", "Cascade test finalize");
    const result = await finalizeAdoptionAction(orgToken, petToken, { error: null }, formData);
    if (result.error !== null || !result.redirectTo) {
      throw new Error(
        `finalizeAdoptionAction did not succeed with a redirect target: ${JSON.stringify(result)}`,
      );
    }
    expect(result.redirectTo).toContain(`/org/${orgToken}/mascotas?adopcion=`);

    // 1 adoption_finalized event with adopter=applicant1.
    const finalizedEvents = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "adoption_finalized")));
    expect(finalizedEvents).toHaveLength(1);
    const finalPayload = finalizedEvents[0].payload as { adopter_user_id: string };
    expect(finalPayload.adopter_user_id).toBe(applicant1Id);

    // 2 auto-rejection events (resolved + outcome=rejected + auto_generated),
    // one each for applicant2 + applicant3.
    const resolvedEvents = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, petId), eq(petEvents.eventType, "adoption_application_resolved")),
      );
    const rejections = resolvedEvents.filter(
      (r) => (r.payload as { outcome?: string }).outcome === "rejected",
    );
    expect(rejections).toHaveLength(2);
    for (const r of rejections) {
      const payload = r.payload as {
        application_event_id: string;
        reviewer_user_id: string;
        reason: string;
        auto_generated: boolean;
      };
      expect(payload.reason).toBe("another_application_finalized");
      expect(payload.auto_generated).toBe(true);
      expect(payload.reviewer_user_id).toBe(coordUserId);
    }

    // 2 notifications, one each to applicant2 + applicant3.
    const closedNotifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.relatedPetId, petId),
          eq(notifications.notificationType, "adoption_application_closed"),
        ),
      );
    const closedRecipients = closedNotifs.map((n) => n.userId).sort();
    expect(closedRecipients).toEqual([applicant2Id, applicant3Id].sort());

    // S-6 (rehome verify report): the ADOPTER's own application case closes
    // as resolved — the adoption happened — with a note that says so. Until
    // 2026-08-22 finalize closed the custody and foster cases and left the
    // application case open for good.
    const [adopterCase] = await db
      .select({ id: cases.id, status: cases.status, closedReason: cases.closedReason })
      .from(cases)
      .where(
        and(
          eq(cases.primaryPetId, petId),
          eq(cases.caseKind, "adoption_application"),
          eq(cases.applicantUserId, applicant1Id),
        ),
      );
    expect(adopterCase, "applicant 1 has an adoption_application case").toBeDefined();
    expect(adopterCase?.status).toBe("closed");
    expect(adopterCase?.closedReason).toBe("resolved");
    const [adopterNote] = await db
      .select({ notes: caseEvents.notes })
      .from(caseEvents)
      .where(
        and(eq(caseEvents.caseId, adopterCase?.id ?? ""), eq(caseEvents.entryType, "case_closed")),
      );
    expect(adopterNote?.notes).toMatch(/se concretó/);

    // And the auto-rejected applications' cases are CLOSED by the same
    // transaction, as cancelled, with a note that says why. Until 2026-08-22
    // resolveApplication left every adoption_application case open after its
    // terminal event.
    for (const applicantId of [applicant2Id, applicant3Id]) {
      const [appCase] = await db
        .select({ id: cases.id, status: cases.status, closedReason: cases.closedReason })
        .from(cases)
        .where(
          and(
            eq(cases.primaryPetId, petId),
            eq(cases.caseKind, "adoption_application"),
            eq(cases.applicantUserId, applicantId),
          ),
        );
      expect(appCase, `applicant ${applicantId} has an adoption_application case`).toBeDefined();
      expect(appCase?.status).toBe("closed");
      expect(appCase?.closedReason).toBe("cancelled");
      const [note] = await db
        .select({ notes: caseEvents.notes })
        .from(caseEvents)
        .where(
          and(eq(caseEvents.caseId, appCase?.id ?? ""), eq(caseEvents.entryType, "case_closed")),
        );
      expect(note?.notes).toMatch(/otra postulación/);
    }

    // The pet comes OFF the adoption shelf. This fixture seeds
    // adoptionListedAt, and finalize used to leave it set: the adopter then
    // opened her own credential to an "EN ADOPCIÓN" chip, because
    // /mis-mascotas reads this field directly (adversarial review 2026-08-08,
    // S2-F04 / S6-F01, reproduced end to end in two minutes).
    //
    // The public /adoptar list hid the problem — its query also demands a live
    // shelter ownership, so it dropped the pet for a second reason while the
    // field itself stayed stale. Assert the FIELD, not the list.
    const [afterFinalize] = await db
      .select({
        listedAt: pets.adoptionListedAt,
        pausedAt: pets.adoptionListingPausedAt,
      })
      .from(pets)
      .where(eq(pets.id, petId));
    expect(afterFinalize.listedAt, "the pet is still listed for adoption").toBeNull();
    expect(afterFinalize.pausedAt).toBeNull();
  });
});

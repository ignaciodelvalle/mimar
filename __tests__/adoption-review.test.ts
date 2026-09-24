// Integration tests for approveAdoptionApplicationAction +
// rejectAdoptionApplicationAction (spec adoption-listing-public review
// surface — Fase 6 follow-up). Same E2E style as cascade.test.ts.
//
// Covers:
//   - approve happy path: _approved event + applicant notif.
//   - reject happy path: _rejected event with auto_generated=false +
//     applicant notif with adoption_application_rejected type.
//   - can't approve an already-resolved application.
//   - capability denial when caller has no adoption.review.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
import {
  approveAdoptionApplicationAction,
  rejectAdoptionApplicationAction,
  submitAdoptionApplicationAction,
} from "@/src/modules/adoption/actions";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const APPLICANT_EMAIL = "adopt-review-app@dim-test.local";
const COORD_EMAIL = "adopt-review-coord@dim-test.local";
const VOLUNTEER_EMAIL = "adopt-review-vol@dim-test.local";
const PASS = "AdoptReview_2026!";

let applicantUserId: string;
let coordUserId: string;
let volunteerUserId: string;
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
      .where(eq(pets.publicToken, "DIM-REV-PET1"));
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
    .where(eq(organizations.publicToken, "DIM-REVIEW-001"));
  for (const { id } of staleOrgs) {
    await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, id));
    await db.delete(organizations).where(eq(organizations.id, id));
  }

  for (const email of [APPLICANT_EMAIL, COORD_EMAIL, VOLUNTEER_EMAIL]) {
    await purgeUserByEmail(email);
  }

  for (const [email, ref] of [
    [APPLICANT_EMAIL, "applicant"] as const,
    [COORD_EMAIL, "coord"] as const,
    [VOLUNTEER_EMAIL, "volunteer"] as const,
  ]) {
    const r = await createFreshTestUser(supabaseAdmin, {
      email,
      password: PASS,
      email_confirm: true,
    });
    if (r.error || !r.data.user) throw new Error(`createUser ${ref}: ${r.error?.message}`);
    if (ref === "applicant") applicantUserId = r.data.user.id;
    if (ref === "coord") coordUserId = r.data.user.id;
    if (ref === "volunteer") volunteerUserId = r.data.user.id;
  }

  await db
    .update(profiles)
    .set({
      displayName: "Applicant Review",
      role: "owner",
      accountType: "personal",
    })
    .where(eq(profiles.id, applicantUserId));
  await db
    .update(profiles)
    .set({ displayName: "Coord Review", role: "owner", accountType: "personal" })
    .where(eq(profiles.id, coordUserId));
  await db
    .update(profiles)
    .set({ displayName: "Volunteer Review", role: "owner", accountType: "personal" })
    .where(eq(profiles.id, volunteerUserId));

  orgToken = "DIM-REVIEW-001";
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: orgToken,
      legalName: "Review Test Refugio SRL",
      displayName: "Review Refugio",
      orgType: "shelter",
      email: "review@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;

  // Coord is admin (has adoption.review). Volunteer has no membership.
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
      publicToken: "DIM-REV-PET1",
      name: "Revisa",
      species: "dog",
      sex: "female",
      potentiallyDangerousBreed: false,
      adoptionListedAt: now,
      adoptionEligible: true,
      adoptionEligibilitySetAt: now,
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
  for (const email of [APPLICANT_EMAIL, COORD_EMAIL, VOLUNTEER_EMAIL]) {
    await purgeUserByEmail(email);
  }
});

/**
 * The `adoption_application` case the submit opened for (pet, applicant) —
 * status, category and the `case_closed` note the applicant reads.
 */
async function applicationCase(forApplicantUserId: string) {
  const [row] = await db
    .select({
      id: cases.id,
      status: cases.status,
      closedReason: cases.closedReason,
      closedByUserId: cases.closedByUserId,
    })
    .from(cases)
    .where(
      and(
        eq(cases.primaryPetId, petId),
        eq(cases.caseKind, "adoption_application"),
        eq(cases.applicantUserId, forApplicantUserId),
      ),
    );
  const notes = row
    ? await db
        .select({ notes: caseEvents.notes, payload: caseEvents.payload })
        .from(caseEvents)
        .where(and(eq(caseEvents.caseId, row.id), eq(caseEvents.entryType, "case_closed")))
    : [];
  return { row, notes };
}

describe("approve/reject adoption application actions", () => {
  let applicationEventId = "";

  it("setup: applicant submits an application", async () => {
    mockSessionAs(applicantUserId);
    const r = await submitAdoptionApplicationAction({
      petPublicToken: petToken,
      housingType: "casa_con_patio",
      otherPets: "Un gato senior",
      dailyRoutine: "Trabajo en casa.",
      notes: null,
      profileSharingConsent: true,
      motivation: "Quiero adoptar a esta mascota y darle un hogar lleno de amor y cuidado.",
      priorPets: "yes_before",
    });
    if (!("ok" in r)) throw new Error(r.error);
    applicationEventId = r.applicationEventId;
    expect(applicationEventId).toBeTruthy();
  });

  it("approve happy path: inserts _approved + applicant notification", async () => {
    mockSessionAs(coordUserId);
    const r = await approveAdoptionApplicationAction(orgToken, {
      applicationEventId,
      notes: "Buena historia.",
    });
    expect("ok" in r).toBe(true);

    const approved = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, petId), eq(petEvents.eventType, "adoption_application_resolved")),
      );
    expect(approved).toHaveLength(1);
    const payload = approved[0].payload as {
      application_event_id: string;
      reviewer_user_id: string;
      outcome: string;
    };
    expect(payload.application_event_id).toBe(applicationEventId);
    expect(payload.reviewer_user_id).toBe(coordUserId);
    expect(payload.outcome).toBe("approved");

    const applicantNotif = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, applicantUserId),
          eq(notifications.notificationType, "adoption_application_approved"),
        ),
      );
    expect(applicantNotif).toHaveLength(1);
  });

  it("approve ATTACHES the resolution to the application's case and leaves the case OPEN (S-6)", async () => {
    // Approval is not the end of the process: the adopter waits for a
    // finalize (which closes the case `resolved`) or for the cascade that
    // tells them it will not happen (rehome-withdraw-flow.test.ts pins the
    // case as open after approval, on purpose). What approval must do is hang
    // the decision off the case — attachment rule `requires-open` — so the
    // case timeline shows it. Until 2026-08-22 the resolved event carried no
    // case_id at all.
    const { row, notes } = await applicationCase(applicantUserId);
    expect(row, "the submit opened an adoption_application case").toBeDefined();
    expect(row?.status).toBe("open");
    expect(notes).toHaveLength(0);
    const [resolved] = await db
      .select({ caseId: petEvents.caseId })
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, petId), eq(petEvents.eventType, "adoption_application_resolved")),
      );
    expect(resolved?.caseId).toBe(row?.id);
  });

  it("can't approve an already-resolved application", async () => {
    mockSessionAs(coordUserId);
    const r = await approveAdoptionApplicationAction(orgToken, { applicationEventId });
    expect("error" in r).toBe(true);
  });

  it("reject happy path: separate application gets _rejected with auto_generated=false", async () => {
    // Need a new applicant since the first one's app is already approved.
    // Re-use volunteer as the second applicant — they don't have an org
    // membership but they're a personal owner.
    mockSessionAs(volunteerUserId);
    const submission = await submitAdoptionApplicationAction({
      petPublicToken: petToken,
      housingType: "departamento",
      otherPets: null,
      dailyRoutine: null,
      notes: null,
      profileSharingConsent: true,
      motivation: "Quiero adoptar a esta mascota y darle un hogar lleno de amor y cuidado.",
      priorPets: "yes_before",
    });
    if (!("ok" in submission)) throw new Error(submission.error);
    const secondAppId = submission.applicationEventId;

    mockSessionAs(coordUserId);
    const r = await rejectAdoptionApplicationAction(orgToken, {
      applicationEventId: secondAppId,
      notes: "No avanzamos esta vez",
    });
    expect("ok" in r).toBe(true);

    const resolved = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, petId), eq(petEvents.eventType, "adoption_application_resolved")),
      );
    // There's the approval from the previous test + this rejection.
    expect(resolved).toHaveLength(2);
    const rejected = resolved.filter(
      (e) => (e.payload as { outcome?: string }).outcome === "rejected",
    );
    expect(rejected).toHaveLength(1);
    const payload = rejected[0].payload as {
      application_event_id: string;
      auto_generated: boolean;
      reviewer_user_id: string;
    };
    expect(payload.application_event_id).toBe(secondAppId);
    expect(payload.auto_generated).toBe(false);
    expect(payload.reviewer_user_id).toBe(coordUserId);

    const volunteerNotif = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, volunteerUserId),
          eq(notifications.notificationType, "adoption_application_rejected"),
        ),
      );
    expect(volunteerNotif).toHaveLength(1);
  });

  it("reject CLOSES the application's case as cancelled, with a note (S-6)", async () => {
    // The pre-existing bug (rehome verify report, S-6): resolveApplication
    // wrote the terminal event and left the `adoption_application` case open
    // forever — an "open" row in every queue for a decision already taken.
    const { row, notes } = await applicationCase(volunteerUserId);
    expect(row, "the second submit opened its own adoption_application case").toBeDefined();
    expect(row?.status).toBe("closed");
    expect(row?.closedReason).toBe("cancelled");
    expect(row?.closedByUserId).toBe(coordUserId);
    expect(notes).toHaveLength(1);
    expect(notes[0].notes).toMatch(/no avanz/);
    expect(notes[0].payload).toMatchObject({ adoption_decision: "rejected" });
  });

  it("non-member cannot review (capability denied)", async () => {
    // volunteer has no membership in the org → requireCapability fails.
    mockSessionAs(volunteerUserId);
    const r = await approveAdoptionApplicationAction(orgToken, {
      applicationEventId,
    });
    expect("error" in r).toBe(true);
  });
});

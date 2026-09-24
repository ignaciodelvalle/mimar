// E2E flow integration test — full propose→accept→adopt sequence at the
// server-action layer (no browser). Equivalent to a Playwright E2E for our
// purposes: each action runs through its real DB transactions, real schema
// validation, and real notifications/events emissions. We mock only
// `@/lib/supabase/server.createClient` so the action can read "the current
// user" from a controllable stub instead of cookies.
//
// Flow:
//   1. Volunteer User A enrolls in the pool (upsertFosterVolunteerAction)
//   2. Org coordinator User B proposes Pet X to User A (proposeFosterAction)
//   3. User A accepts (acceptFosterProposalAction) → foster ownership created
//   4. Org marks Pet X as adoption-eligible (setAdoptionEligibilityAction)
//   5. Org finalizes adoption to the foster shortcut (finalizeAdoptionAction
//      with adopterUserId) → user A becomes owner; foster row closed

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { dniLast4, hashDni } from "@/lib/utils/dni-hash";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import {
  db,
  fosterProposals,
  fosterVolunteers,
  notifications,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { createClient } from "@/lib/supabase/server";
import { setAdoptionEligibilityAction } from "@/src/modules/adoption/actions";
import {
  acceptFosterProposalAction,
  proposeFosterAction,
  upsertFosterVolunteerAction,
} from "@/src/modules/foster/actions";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const VOLUNTEER_EMAIL = "foster-e2e-vol@dim-test.local";
const COORD_EMAIL = "foster-e2e-coord@dim-test.local";
const PASS = "FosterE2E_2026!";

let volunteerUserId: string;
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
      await tx.delete(fosterVolunteers).where(eq(fosterVolunteers.userId, uid));
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
      .where(eq(pets.publicToken, "DIM-E2EF-PET1"));
    for (const { id } of stalePets) {
      await tx.delete(fosterProposals).where(eq(fosterProposals.petId, id));
      await tx.delete(notifications).where(eq(notifications.relatedPetId, id));
      await tx.delete(ownerships).where(eq(ownerships.petId, id));
      await tx.delete(petEvents).where(eq(petEvents.petId, id));
      await tx.delete(pets).where(eq(pets.id, id));
    }
  });
  const staleOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.publicToken, "DIM-E2EF-0001"));
  for (const { id } of staleOrgs) {
    await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, id));
    await db.delete(organizations).where(eq(organizations.id, id));
  }

  await purgeUserByEmail(VOLUNTEER_EMAIL);
  await purgeUserByEmail(COORD_EMAIL);

  const v = await createFreshTestUser(supabaseAdmin, {
    email: VOLUNTEER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (v.error || !v.data.user) throw new Error(`createUser volunteer: ${v.error?.message}`);
  volunteerUserId = v.data.user.id;

  const c = await createFreshTestUser(supabaseAdmin, {
    email: COORD_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (c.error || !c.data.user) throw new Error(`createUser coord: ${c.error?.message}`);
  coordUserId = c.data.user.id;

  // Volunteer profile must satisfy D13 pre-conditions:
  // accountType=personal, role=owner, dniVerified, displayName, phone.
  await db
    .update(profiles)
    .set({
      displayName: "FosterE2E Volunteer",
      phone: "+541112345678",
      dniHash: hashDni("10000001"),
      dniLast4: dniLast4("10000001"),
      dniVerified: true,
      role: "owner",
      accountType: "personal",
    })
    .where(eq(profiles.id, volunteerUserId));

  await db
    .update(profiles)
    .set({
      displayName: "FosterE2E Coord",
      role: "owner",
      accountType: "personal",
    })
    .where(eq(profiles.id, coordUserId));

  // Org + admin membership for the coordinator.
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: "DIM-E2EF-0001",
      legalName: "FosterE2E Refugio SRL",
      displayName: "FosterE2E Refugio",
      orgType: "shelter",
      email: "foster-e2e@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;
  orgToken = org.publicToken;

  await db.insert(organizationMemberships).values({
    organizationId: orgId,
    userId: coordUserId,
    role: "admin",
    canWritePetEvents: true,
  });

  // Pet in shelter_custody by the org.
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-E2EF-PET1",
      name: "FosterE2EPet",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = pet.id;
  petToken = pet.publicToken;

  await db.insert(ownerships).values({
    petId,
    ownerOrganizationId: orgId,
    role: "shelter_custody",
    startedAt: new Date(),
  });
});

afterAll(async () => {
  await db.delete(fosterProposals).where(eq(fosterProposals.petId, petId));
  await db.delete(notifications).where(eq(notifications.relatedPetId, petId));
  await db.delete(ownerships).where(eq(ownerships.petId, petId));
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(eq(petEvents.petId, petId));
    await tx.delete(pets).where(eq(pets.id, petId));
  });
  await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await purgeUserByEmail(VOLUNTEER_EMAIL);
  await purgeUserByEmail(COORD_EMAIL);
});

describe("foster-e2e: propose → accept → adopt", () => {
  it("runs the full sequence end-to-end at the action layer", async () => {
    // ----- Step 1: volunteer enrolls -----
    mockSessionAs(volunteerUserId);
    const enroll = await upsertFosterVolunteerAction({
      mode: "enroll",
      status: "active",
      acceptsDogs: true,
      acceptsCats: false,
      acceptsOtherSpecies: false,
      acceptsSizeSmall: true,
      acceptsSizeMedium: true,
      acceptsSizeLarge: true,
      acceptsPuppies: false,
      acceptsSeniors: true,
      acceptsChronicConditions: false,
      acceptsDangerousBreeds: false,
      maxDurationWeeks: 12,
    });
    expect("error" in enroll).toBe(false);
    if ("error" in enroll) throw new Error(enroll.error);
    expect(enroll.availableSlots).toBe(1);

    // ----- Step 2: coordinator proposes the pet -----
    mockSessionAs(coordUserId);
    const propose = await proposeFosterAction({
      orgToken,
      volunteerUserId,
      petPublicToken: petToken,
      proposedDurationWeeks: 4,
      proposedNotes: "Pet en custodia, perfil tranquilo.",
    });
    expect("error" in propose).toBe(false);
    if ("error" in propose) throw new Error(propose.error);
    const proposalToken = propose.proposalPublicToken;
    expect(proposalToken).toMatch(/^FP-/);

    // Verify proposal row + foster_proposed event.
    const [proposalRow] = await db
      .select({ status: fosterProposals.status, expiresAt: fosterProposals.expiresAt })
      .from(fosterProposals)
      .where(eq(fosterProposals.publicToken, proposalToken));
    expect(proposalRow.status).toBe("pending");
    expect(proposalRow.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const proposedEvents = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "foster_proposed")));
    expect(proposedEvents.length).toBe(1);

    // ----- Step 3: volunteer accepts -----
    mockSessionAs(volunteerUserId);
    const accept = await acceptFosterProposalAction({
      proposalPublicToken: proposalToken,
      allowCoFoster: true,
      responseNotes: "Listo para recibirlo el sábado.",
    });
    if ("error" in accept) throw new Error(`accept failed: ${accept.error}`);
    expect(accept.remainingSlots).toBe(0);
    expect(accept.cascadeCancelledProposals).toEqual([]);

    // Foster ownership row was created.
    const [fosterOwn] = await db
      .select()
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.role, "foster"),
          eq(ownerships.ownerUserId, volunteerUserId),
          isNull(ownerships.endedAt),
        ),
      );
    expect(fosterOwn).toBeTruthy();
    expect(fosterOwn.allowCoFoster).toBe(true);

    // Proposal row links to that ownership.
    const [resolved] = await db
      .select({
        status: fosterProposals.status,
        resolvedOwnershipId: fosterProposals.resolvedOwnershipId,
      })
      .from(fosterProposals)
      .where(eq(fosterProposals.publicToken, proposalToken));
    expect(resolved.status).toBe("accepted");
    expect(resolved.resolvedOwnershipId).toBe(fosterOwn.id);

    // foster_assigned + foster_proposal_resolved(outcome=accepted) + foster_co_foster_allowed
    // events emitted.
    const acceptEvents = await db
      .select({ type: petEvents.eventType, payload: petEvents.payload })
      .from(petEvents)
      .where(eq(petEvents.petId, petId));
    const types = acceptEvents.map((e) => e.type);
    expect(types).toContain("foster_proposal_resolved");
    expect(types).toContain("foster_assigned");
    expect(types).toContain("foster_co_foster_allowed");
    const resolvedEvent = acceptEvents.find((e) => e.type === "foster_proposal_resolved");
    expect((resolvedEvent?.payload as { outcome?: string })?.outcome).toBe("accepted");

    // ----- Step 4: org marks the pet adoption-eligible -----
    mockSessionAs(coordUserId);
    const setEligible = await setAdoptionEligibilityAction({
      orgToken,
      petPublicToken: petToken,
      eligible: true,
    });
    expect("error" in setEligible).toBe(false);

    const [petAfterEligible] = await db.select().from(pets).where(eq(pets.id, petId));
    expect(petAfterEligible.adoptionEligible).toBe(true);

    // ----- Step 5: org finalizes adoption to the foster shortcut -----
    // finalizeAdoptionAction uses FormData. adopterUserId hidden field
    // triggers the §15.1 shortcut path. Skip DNI fields entirely.
    const { finalizeAdoptionAction } = await import("@/src/modules/adoption/actions");
    const formData = new FormData();
    formData.set("adopterUserId", volunteerUserId);
    formData.set("followupMonths", "0");
    formData.set("notes", "Adoptado directo desde el tránsito.");

    // finalizeAdoptionAction returns a redirect target on success (the client
    // hard-navigates — the router-drop-immune cure), so no throw to catch.
    const finalizeResult = await finalizeAdoptionAction(
      orgToken,
      petToken,
      { error: null },
      formData,
    );
    expect(finalizeResult.error).toBeNull();
    expect(finalizeResult.redirectTo).toContain(`/org/${orgToken}/mascotas?adopcion=`);

    // Volunteer is now the owner.
    const [ownerRow] = await db
      .select()
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.role, "owner"),
          eq(ownerships.ownerUserId, volunteerUserId),
          isNull(ownerships.endedAt),
        ),
      );
    expect(ownerRow).toBeTruthy();

    // shelter_custody and foster rows are now closed.
    const activeNonOwner = await db
      .select({ role: ownerships.role })
      .from(ownerships)
      .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));
    const stillActiveRoles = activeNonOwner.map((r) => r.role);
    expect(stillActiveRoles).toEqual(["owner"]);

    // adoption_finalized event was emitted.
    const finalEvents = await db
      .select({ type: petEvents.eventType })
      .from(petEvents)
      .where(eq(petEvents.petId, petId));
    expect(finalEvents.map((e) => e.type)).toContain("adoption_finalized");
  });
});

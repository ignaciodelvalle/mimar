// Integration tests for Fase D6 of the cases system — wiring the
// foster_proposal lifecycle to the cases layer (migration 0068).
//
// Verifies that:
//   1. proposeFosterAction opens a foster_proposal case (status=open) and
//      writes case_id to both the fosterProposals row and the foster_proposed
//      pet_event.
//   2. acceptFosterProposalAction closes the case with reason='resolved'.
//   3. rejectFosterProposalAction closes the case with reason='resolved'.
//   4. cancelFosterProposalAction closes the case with reason='cancelled'.
//   5. expireFosterProposals closes the case with reason='auto_expired'.
//
// The test creates real auth users (via supabaseAdmin) and uses the real
// server actions at the DB-transaction level, mocking only createClient +
// revalidatePath so the actions can resolve "the current user".

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
  cases,
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
import { generatePrefixedToken } from "@/lib/infra/publicToken";
import { createClient } from "@/lib/supabase/server";
import {
  acceptFosterProposalAction,
  cancelFosterProposalAction,
  expireFosterProposalsAction as expireFosterProposals,
  proposeFosterAction,
  rejectFosterProposalAction,
} from "@/src/modules/foster/actions";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const VOLUNTEER_EMAIL = "d6-vol@dim-test.local";
const COORD_EMAIL = "d6-coord@dim-test.local";
const PASS = "D6FosterCase_2026!";

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

async function cleanPetState() {
  // Must delete fosterProposals first (case_id FK) then the cases rows.
  await db.delete(fosterProposals).where(eq(fosterProposals.petId, petId));
  await db.delete(notifications).where(eq(notifications.relatedPetId, petId));
  await db
    .delete(ownerships)
    .where(and(eq(ownerships.petId, petId), eq(ownerships.role, "foster")));
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(eq(petEvents.petId, petId));
  });
  // Clean up any open foster_proposal cases for this pet so the unique index
  // (cases_open_per_pet_kind_idx) doesn't block the next proposeFosterAction.
  await db
    .delete(cases)
    .where(and(eq(cases.primaryPetId, petId), eq(cases.caseKind, "foster_proposal")));
  // Re-seed the volunteer slot (some tests decrement it).
  await db
    .update(fosterVolunteers)
    .set({ availableSlots: 1, updatedAt: new Date() })
    .where(eq(fosterVolunteers.userId, volunteerUserId));
}

beforeAll(async () => {
  // Clean up any leftovers from a prior crashed run.
  await withMutationOverride(async (tx) => {
    const stalePets = await tx
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, "DIM-D6FP-PET1"));
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
    .where(eq(organizations.publicToken, "DIM-D6FP-001"));
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

  await db
    .update(profiles)
    .set({
      displayName: "D6 Volunteer",
      phone: "+541100000099",
      dniHash: hashDni("20000099"),
      dniLast4: dniLast4("20000099"),
      dniVerified: true,
      role: "owner",
      accountType: "personal",
    })
    .where(eq(profiles.id, volunteerUserId));

  await db
    .update(profiles)
    .set({ displayName: "D6 Coord", role: "owner", accountType: "personal" })
    .where(eq(profiles.id, coordUserId));

  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: "DIM-D6FP-001",
      legalName: "D6 Foster Test Refugio SRL",
      displayName: "D6 Refugio",
      orgType: "shelter",
      email: "d6-org@dim-test.local",
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

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-D6FP-PET1",
      name: "D6TestPet",
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

  await db.insert(fosterVolunteers).values({
    userId: volunteerUserId,
    status: "active",
    availableSlots: 1,
    acceptsDogs: true,
  });
});

afterAll(async () => {
  await db.delete(fosterProposals).where(eq(fosterProposals.petId, petId));
  await db.delete(notifications).where(eq(notifications.relatedPetId, petId));
  await db.delete(ownerships).where(eq(ownerships.petId, petId));
  await db
    .delete(cases)
    .where(and(eq(cases.primaryPetId, petId), eq(cases.caseKind, "foster_proposal")));
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(eq(petEvents.petId, petId));
    await tx.delete(pets).where(eq(pets.id, petId));
  });
  await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await purgeUserByEmail(VOLUNTEER_EMAIL);
  await purgeUserByEmail(COORD_EMAIL);
});

// ---------------------------------------------------------------------------
// Shared helper: propose → get proposal token + case id
// ---------------------------------------------------------------------------

async function propose(): Promise<{ proposalToken: string; caseId: string }> {
  mockSessionAs(coordUserId);
  const result = await proposeFosterAction({
    orgToken,
    volunteerUserId,
    petPublicToken: petToken,
    proposedDurationWeeks: 3,
  });
  if ("error" in result) throw new Error(`proposeFosterAction failed: ${result.error}`);

  const [row] = await db
    .select({ caseId: fosterProposals.caseId, publicToken: fosterProposals.publicToken })
    .from(fosterProposals)
    .where(eq(fosterProposals.publicToken, result.proposalPublicToken));
  if (!row.caseId) throw new Error("fosterProposals.caseId was not set by proposeFosterAction");

  return { proposalToken: result.proposalPublicToken, caseId: row.caseId };
}

// ---------------------------------------------------------------------------
// D6.1 — propose opens the case
// ---------------------------------------------------------------------------

describe("D6.1: proposeFosterAction opens a foster_proposal case", () => {
  it("creates an open cases row and links it to the proposal + event", async () => {
    await cleanPetState();

    mockSessionAs(coordUserId);
    const result = await proposeFosterAction({
      orgToken,
      volunteerUserId,
      petPublicToken: petToken,
      proposedDurationWeeks: 4,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error(result.error);

    // Proposal row has case_id set.
    const [proposal] = await db
      .select()
      .from(fosterProposals)
      .where(eq(fosterProposals.publicToken, result.proposalPublicToken));
    expect(proposal.caseId).toBeTruthy();

    // cases row is open.
    const [caseRow] = await db.select().from(cases).where(eq(cases.id, proposal.caseId!));
    expect(caseRow.status).toBe("open");
    expect(caseRow.caseKind).toBe("foster_proposal");
    expect(caseRow.primaryPetId).toBe(petId);

    // foster_proposed event carries case_id.
    const [event] = await db
      .select({ caseId: petEvents.caseId })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "foster_proposed")));
    expect(event.caseId).toBe(proposal.caseId);

    await cleanPetState();
  });
});

// ---------------------------------------------------------------------------
// D6.2 — accept closes the case with reason='resolved'
// ---------------------------------------------------------------------------

describe("D6.2: acceptFosterProposalAction closes with reason=resolved", () => {
  it("sets status=closed, closed_reason=resolved on the cases row", async () => {
    await cleanPetState();
    const { proposalToken, caseId } = await propose();

    mockSessionAs(volunteerUserId);
    const accept = await acceptFosterProposalAction({
      proposalPublicToken: proposalToken,
      allowCoFoster: false,
    });
    if ("error" in accept) throw new Error(`accept failed: ${accept.error}`);

    const [caseRow] = await db.select().from(cases).where(eq(cases.id, caseId));
    expect(caseRow.status).toBe("closed");
    expect(caseRow.closedReason).toBe("resolved");

    // foster_proposal_resolved event carries case_id.
    const [event] = await db
      .select({ caseId: petEvents.caseId, type: petEvents.eventType })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "foster_proposal_resolved")));
    expect(event.caseId).toBe(caseId);

    await cleanPetState();
  });
});

// ---------------------------------------------------------------------------
// D6.3 — reject closes the case with reason='resolved'
// ---------------------------------------------------------------------------

describe("D6.3: rejectFosterProposalAction closes with reason=resolved", () => {
  it("sets status=closed, closed_reason=resolved", async () => {
    await cleanPetState();
    const { proposalToken, caseId } = await propose();

    mockSessionAs(volunteerUserId);
    const reject = await rejectFosterProposalAction({
      proposalPublicToken: proposalToken,
      rejectionReason: "timing",
    });
    if ("error" in reject) throw new Error(`reject failed: ${reject.error}`);

    const [caseRow] = await db.select().from(cases).where(eq(cases.id, caseId));
    expect(caseRow.status).toBe("closed");
    expect(caseRow.closedReason).toBe("resolved");

    // foster_proposal_resolved event carries case_id.
    const [event] = await db
      .select({ caseId: petEvents.caseId })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "foster_proposal_resolved")));
    expect(event.caseId).toBe(caseId);

    await cleanPetState();
  });
});

// ---------------------------------------------------------------------------
// D6.4 — cancel closes the case with reason='cancelled'
// ---------------------------------------------------------------------------

describe("D6.4: cancelFosterProposalAction closes with reason=cancelled", () => {
  it("sets status=closed, closed_reason=cancelled", async () => {
    await cleanPetState();
    const { proposalToken, caseId } = await propose();

    mockSessionAs(coordUserId);
    const cancel = await cancelFosterProposalAction({
      proposalPublicToken: proposalToken,
      cancellationReason: "org_cancelled",
    });
    if ("error" in cancel) throw new Error(`cancel failed: ${cancel.error}`);

    const [caseRow] = await db.select().from(cases).where(eq(cases.id, caseId));
    expect(caseRow.status).toBe("closed");
    expect(caseRow.closedReason).toBe("cancelled");

    // foster_proposal_resolved event carries case_id.
    const [event] = await db
      .select({ caseId: petEvents.caseId })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "foster_proposal_resolved")));
    expect(event.caseId).toBe(caseId);

    await cleanPetState();
  });
});

// ---------------------------------------------------------------------------
// D6.5 — expirer closes the case with reason='auto_expired'
// ---------------------------------------------------------------------------

describe("D6.5: expireFosterProposals closes with reason=auto_expired", () => {
  it("sets status=closed, closed_reason=auto_expired on the cases row", async () => {
    await cleanPetState();
    const { caseId } = await propose();

    // Back-date the expiry to force it into the stale bucket.
    await db
      .update(fosterProposals)
      .set({ expiresAt: new Date(Date.now() - 1000), updatedAt: new Date() })
      .where(eq(fosterProposals.petId, petId));

    const stats = await expireFosterProposals();
    expect(stats.expired).toBeGreaterThanOrEqual(1);
    expect(stats.errors).toBe(0);

    const [caseRow] = await db.select().from(cases).where(eq(cases.id, caseId));
    expect(caseRow.status).toBe("closed");
    expect(caseRow.closedReason).toBe("auto_expired");

    // foster_proposal_resolved event carries case_id.
    const [event] = await db
      .select({ caseId: petEvents.caseId, payload: petEvents.payload })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "foster_proposal_resolved")));
    expect(event.caseId).toBe(caseId);
    expect((event.payload as { outcome?: string }).outcome).toBe("expired");

    await cleanPetState();
  });
});

// ---------------------------------------------------------------------------
// D6.6 — fallback path: pre-migration row (caseId=null) still closes
// ---------------------------------------------------------------------------

describe("D6.6: fallback path — pre-migration proposal (caseId=null) still closes case", () => {
  it("closeCase is called via findOpenCaseForPetAndKind when caseId is null", async () => {
    await cleanPetState();

    // Open a case manually (simulating what proposeFosterAction would have done).
    const { openCase } = await import("@/lib/infra/case-helpers");
    const caseRow = await openCase({
      kind: "foster_proposal",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId,
      openedReason: { code: "foster_proposal_sent" },
      openedByOrganizationId: orgId,
    });

    // Insert a proposal WITHOUT caseId (simulating a pre-migration row).
    const token = generatePrefixedToken("FP");
    const now = new Date();
    await db.insert(fosterProposals).values({
      publicToken: token,
      organizationId: orgId,
      volunteerUserId,
      petId,
      proposedByUserId: coordUserId,
      proposedAt: now,
      matchWarnings: [],
      expiresAt: new Date(now.getTime() - 1000),
      status: "pending",
      caseId: null, // pre-migration row — no case_id
    });

    // Expirer should fall back to findOpenCaseForPetAndKind and close it.
    const stats = await expireFosterProposals();
    expect(stats.expired).toBeGreaterThanOrEqual(1);
    expect(stats.errors).toBe(0);

    const [closed] = await db.select().from(cases).where(eq(cases.id, caseRow.id));
    expect(closed.status).toBe("closed");
    expect(closed.closedReason).toBe("auto_expired");

    await cleanPetState();
    // Clean up the manually-opened case.
    await db.delete(cases).where(eq(cases.id, caseRow.id));
  });
});

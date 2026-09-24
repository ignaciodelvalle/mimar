// Tests for lib/org-dashboard.ts — Wave 3 Item 17: Org operations dashboard.
//
// Coverage:
//   1. fetchIntakesLastWeek — counts shelter_intake_recorded events in window.
//   2. fetchAvailableForAdoption — counts eligible custody pets.
//   3. fetchActiveAdoptions — counts open applications (no resolved event).
//   4. fetchRequiresAction — surfaces long-stay animals; excludes animals with
//      ended custody.
//   5. actionReasonLabel / actionReasonIcon — pure helpers, no DB.
//   6. Empty-shelter org: all counts return 0 (not errors).
//
// Integration tests use the local Supabase/Postgres stack (127.0.0.1:54322).
// Fixtures are cleaned up in afterEach.

import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  cases,
  db,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
  reminders,
  welfareReports,
} from "@/db";
import {
  LONG_STAY_DAYS,
  type OrgQueueKey,
  actionReasonIcon,
  actionReasonLabel,
  applicableOrgQueues,
  fetchActiveAdoptions,
  fetchAvailableForAdoption,
  fetchIntakesLastWeek,
  fetchOrgDashboardMetrics,
  fetchOrgQueueCounts,
  fetchOrgQueueSignals,
  fetchRequiresAction,
} from "@/lib/analytics/org-dashboard";
import { withMutationOverride } from "./_helpers/db-overrides";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const fixtureOrgIds: string[] = [];
const fixturePetIds: string[] = [];
const fixtureEventIds: string[] = [];
const fixtureProfileIds: string[] = [];
const fixtureWelfareIds: string[] = [];

// Use a random 6-char suffix so re-runs and parallel workers never collide.
const RUN_ID = Math.random().toString(36).slice(2, 8).toUpperCase();
let counter = 0;
function next(prefix = "T"): string {
  counter += 1;
  return `${prefix}-D${RUN_ID}-${String(counter).padStart(3, "0")}`;
}

async function makeOrg(extra: Partial<typeof organizations.$inferInsert> = {}): Promise<string> {
  const token = next("ORG");
  const [row] = await db
    .insert(organizations)
    .values({
      publicToken: token,
      legalName: "Test Dash Org",
      displayName: "Test Dash Org",
      orgType: "shelter",
      email: `dash-${counter}@dim-test.local`,
      ...extra,
    })
    .returning({ id: organizations.id });
  fixtureOrgIds.push(row.id);
  return row.id;
}

async function makePet(
  species: "dog" | "cat" | "rabbit" = "dog",
  adoptionEligible = false,
): Promise<string> {
  const token = next("DIM");
  // When adoptionEligible is set, adoptionEligibilitySetAt must also be set
  // (pets_adoption_eligibility_consistent check constraint).
  const eligibilityFields = adoptionEligible
    ? { adoptionEligible: true as const, adoptionEligibilitySetAt: new Date() }
    : {};
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: `Dash Pet ${token}`,
      species,
      sex: "unknown",
      ...eligibilityFields,
    })
    .returning({ id: pets.id });
  fixturePetIds.push(row.id);
  return row.id;
}

async function makeCustody(
  petId: string,
  orgId: string,
  opts: { startedAt?: Date; endedAt?: Date | null } = {},
): Promise<void> {
  await db.insert(ownerships).values({
    petId,
    ownerOrganizationId: orgId,
    role: "shelter_custody",
    startedAt: opts.startedAt ?? new Date(),
    endedAt: opts.endedAt ?? undefined,
  });
}

async function makeIntakeEvent(petId: string, orgId: string, occurredAt: Date): Promise<string> {
  const [row] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "shelter_intake_recorded",
      occurredAt,
      recordedAt: new Date(),
      authorRole: "shelter",
      authorOrganizationId: orgId,
      payload: {},
    })
    .returning({ id: petEvents.id });
  fixtureEventIds.push(row.id);
  return row.id;
}

async function makeAdoptionSubmitted(petId: string, orgId: string): Promise<string> {
  const [row] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "adoption_application_submitted",
      occurredAt: new Date(),
      recordedAt: new Date(),
      authorRole: "owner",
      payload: { applicant_user_id: "00000000-0000-0000-0000-000000000001" },
    })
    .returning({ id: petEvents.id });
  fixtureEventIds.push(row.id);
  return row.id;
}

async function makeAdoptionResolved(petId: string, applicationEventId: string): Promise<void> {
  const [row] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "adoption_application_resolved",
      occurredAt: new Date(),
      recordedAt: new Date(),
      authorRole: "shelter",
      payload: {
        application_event_id: applicationEventId,
        outcome: "rejected",
      },
    })
    .returning({ id: petEvents.id });
  fixtureEventIds.push(row.id);
}

async function makeProfile(): Promise<string> {
  const id = randomUUID();
  await db.insert(profiles).values({
    id,
    role: "owner",
    displayName: `Dash Foster ${id.slice(0, 8)}`,
    accountType: "personal",
  });
  fixtureProfileIds.push(id);
  return id;
}

/** Active foster placement on a pet, held by a volunteer (user). */
async function makeFoster(petId: string, holderUserId: string): Promise<void> {
  await db.insert(ownerships).values({
    petId,
    ownerUserId: holderUserId,
    role: "foster",
    startedAt: new Date(),
  });
}

/** adoption_finalized event denormalizing the org that adopted the pet out. */
async function makeAdoptionFinalized(petId: string, prevOrgId: string): Promise<string> {
  const [row] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "adoption_finalized",
      occurredAt: new Date(),
      recordedAt: new Date(),
      authorRole: "shelter",
      payload: { previous_owner_organization_id: prevOrgId },
    })
    .returning({ id: petEvents.id });
  fixtureEventIds.push(row.id);
  return row.id;
}

async function makeOverdueCheckinReminder(petId: string, userId: string): Promise<void> {
  await db.insert(reminders).values({
    petId,
    userId,
    reminderType: "post_adoption_checkin",
    dueAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days overdue
    title: "Control post-adopción",
  });
}

/**
 * A welfare report derived to `orgId`. Defaults mirror the shape the demo seed
 * writes (scripts/seed-demo-spine.ts deriveWelfareToAuthority → the real
 * deriveWelfareToOrgAction): status 'open', derivedAt/derivedByUserId set,
 * orgInterventionStatus null. This is the row countDerivedWelfare must count.
 */
async function makeDerivedWelfare(
  orgId: string,
  opts: { status?: string; orgInterventionStatus?: "tomado" | "devuelto" | null } = {},
): Promise<void> {
  const [row] = await db
    .insert(welfareReports)
    .values({
      referenceCode: next("DEN"),
      kind: "dog_fighting",
      severity: "critical",
      description: "Fixture derived welfare report",
      subjectKind: "unowned_animal",
      status: (opts.status ?? "open") as never,
      derivedToOrganizationId: orgId,
      derivedAt: new Date(),
      derivedByUserId: await makeProfile(),
      orgInterventionStatus: opts.orgInterventionStatus ?? null,
    })
    .returning({ id: welfareReports.id });
  fixtureWelfareIds.push(row.id);
}

/**
 * A case row for the queue tests (D-6 / D-7). `primaryPetId` is always a
 * fixture pet, so the row cascade-deletes with it — no separate cleanup list.
 */
async function makeCase(
  petId: string,
  opts: {
    caseKind: string;
    openedByOrganizationId?: string;
    receiverOrganizationId?: string;
    openedAt?: Date;
  },
): Promise<string> {
  const [row] = await db
    .insert(cases)
    .values({
      publicCode: next("CAS"),
      caseKind: opts.caseKind,
      status: "open",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId,
      openedByOrganizationId: opts.openedByOrganizationId,
      receiverOrganizationId: opts.receiverOrganizationId,
      openedAt: opts.openedAt ?? new Date(),
    })
    .returning({ id: cases.id });
  return row.id;
}

/** A custody_transfer_proposed event pinning a decomiso handoff's 7-day clock. */
async function makeProposalEvent(petId: string, caseId: string, occurredAt: Date): Promise<void> {
  const [row] = await db
    .insert(petEvents)
    .values({
      petId,
      caseId,
      eventType: "custody_transfer_proposed",
      occurredAt,
      payload: {},
    })
    .returning({ id: petEvents.id });
  fixtureEventIds.push(row.id);
}

afterEach(async () => {
  // Welfare rows first — their FKs to org/profile are ON DELETE SET NULL, so
  // deleting the org/profile below would orphan (not remove) them.
  if (fixtureWelfareIds.length > 0) {
    await db.delete(welfareReports).where(inArray(welfareReports.id, fixtureWelfareIds));
    fixtureWelfareIds.length = 0;
  }
  // pet_events is append-only at the DB level — deleting requires the
  // withMutationOverride GUC escape hatch (same pattern as govt-dashboards.test.ts).
  // Deleting pets also cascades through ownerships; pet_events rows created by
  // fixtures are covered by the mutation override.
  if (fixturePetIds.length > 0) {
    await withMutationOverride(async (tx) => {
      if (fixtureEventIds.length > 0) {
        await tx.delete(petEvents).where(inArray(petEvents.id, fixtureEventIds));
      }
      await tx.delete(pets).where(inArray(pets.id, fixturePetIds));
    });
    fixtureEventIds.length = 0;
    fixturePetIds.length = 0;
  } else if (fixtureEventIds.length > 0) {
    // Events without pets (edge case — keep defensive)
    await withMutationOverride(async (tx) => {
      await tx.delete(petEvents).where(inArray(petEvents.id, fixtureEventIds));
    });
    fixtureEventIds.length = 0;
  }
  if (fixtureOrgIds.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, fixtureOrgIds));
    fixtureOrgIds.length = 0;
  }
  // Profiles last: reminders (user_id) and foster ownerships already cascaded
  // away with their pets above.
  if (fixtureProfileIds.length > 0) {
    await db.delete(profiles).where(inArray(profiles.id, fixtureProfileIds));
    fixtureProfileIds.length = 0;
  }
});

// ---------------------------------------------------------------------------
// fetchIntakesLastWeek
// ---------------------------------------------------------------------------

describe("fetchIntakesLastWeek", () => {
  it("returns 0 for an org with no events", async () => {
    const orgId = await makeOrg();
    expect(await fetchIntakesLastWeek(orgId)).toBe(0);
  });

  it("counts intake events from this org in the last 7 days", async () => {
    const orgId = await makeOrg();
    const petId = await makePet();
    await makeCustody(petId, orgId);

    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    await makeIntakeEvent(petId, orgId, recent);

    expect(await fetchIntakesLastWeek(orgId)).toBe(1);
  });

  it("excludes intake events older than 7 days", async () => {
    const orgId = await makeOrg();
    const petId = await makePet();
    await makeCustody(petId, orgId);

    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
    await makeIntakeEvent(petId, orgId, old);

    expect(await fetchIntakesLastWeek(orgId)).toBe(0);
  });

  it("does not count intakes authored by a different org", async () => {
    const orgA = await makeOrg();
    const orgB = await makeOrg();
    const petId = await makePet();
    await makeCustody(petId, orgA);

    // orgB records an intake on a pet not in its custody
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    await makeIntakeEvent(petId, orgB, recent);

    expect(await fetchIntakesLastWeek(orgA)).toBe(0);
    expect(await fetchIntakesLastWeek(orgB)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// fetchAvailableForAdoption
// ---------------------------------------------------------------------------

describe("fetchAvailableForAdoption", () => {
  it("returns 0 when no pets are in custody", async () => {
    const orgId = await makeOrg();
    expect(await fetchAvailableForAdoption(orgId)).toBe(0);
  });

  it("counts eligible pets in active custody", async () => {
    const orgId = await makeOrg();
    const petId = await makePet("dog", true);
    await makeCustody(petId, orgId);

    expect(await fetchAvailableForAdoption(orgId)).toBe(1);
  });

  it("excludes pets with adoption_eligible = false or null", async () => {
    const orgId = await makeOrg();
    const petIneligible = await makePet("cat", false);
    await makeCustody(petIneligible, orgId);

    expect(await fetchAvailableForAdoption(orgId)).toBe(0);
  });

  it("excludes pets whose custody has ended", async () => {
    const orgId = await makeOrg();
    const petId = await makePet("dog", true);
    await makeCustody(petId, orgId, { endedAt: new Date(Date.now() - 1000) });

    expect(await fetchAvailableForAdoption(orgId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fetchActiveAdoptions
// ---------------------------------------------------------------------------

describe("fetchActiveAdoptions", () => {
  it("returns 0 when no applications exist", async () => {
    const orgId = await makeOrg();
    expect(await fetchActiveAdoptions(orgId)).toBe(0);
  });

  it("counts open applications on custody pets", async () => {
    const orgId = await makeOrg();
    const petId = await makePet("dog", true);
    await makeCustody(petId, orgId);
    await makeAdoptionSubmitted(petId, orgId);

    expect(await fetchActiveAdoptions(orgId)).toBe(1);
  });

  it("excludes resolved applications", async () => {
    const orgId = await makeOrg();
    const petId = await makePet("dog", true);
    await makeCustody(petId, orgId);
    const appEventId = await makeAdoptionSubmitted(petId, orgId);
    await makeAdoptionResolved(petId, appEventId);

    expect(await fetchActiveAdoptions(orgId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fetchRequiresAction — long-stay flag
// ---------------------------------------------------------------------------

describe("fetchRequiresAction — long-stay", () => {
  it("returns empty list for an org with no custody pets", async () => {
    const orgId = await makeOrg();
    const result = await fetchRequiresAction(orgId);
    expect(result).toHaveLength(0);
  });

  it("surfaces pets with custody older than LONG_STAY_DAYS", async () => {
    const orgId = await makeOrg();
    const petId = await makePet("dog");
    const oldStart = new Date(Date.now() - (LONG_STAY_DAYS + 5) * 24 * 60 * 60 * 1000);
    await makeCustody(petId, orgId, { startedAt: oldStart });

    const result = await fetchRequiresAction(orgId);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const item = result.find((r) => r.petId === petId);
    expect(item).toBeDefined();
    expect(item?.reasons).toContain("long_stay");
  });

  it("does not surface pets with recent intake (short stay)", async () => {
    const orgId = await makeOrg();
    const petId = await makePet("dog");
    // Recent custody — well within LONG_STAY_DAYS and no health flags
    await makeCustody(petId, orgId, { startedAt: new Date() });

    const result = await fetchRequiresAction(orgId);
    const item = result.find((r) => r.petId === petId);
    expect(item).toBeUndefined();
  });

  it("excludes pets whose custody has ended", async () => {
    const orgId = await makeOrg();
    const petId = await makePet("dog");
    const oldStart = new Date(Date.now() - (LONG_STAY_DAYS + 10) * 24 * 60 * 60 * 1000);
    await makeCustody(petId, orgId, {
      startedAt: oldStart,
      endedAt: new Date(), // ended — should not surface
    });

    const result = await fetchRequiresAction(orgId);
    const item = result.find((r) => r.petId === petId);
    expect(item).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fetchOrgDashboardMetrics — all-zero empty shelter
// ---------------------------------------------------------------------------

describe("fetchOrgDashboardMetrics — empty shelter", () => {
  it("returns zeros across all metrics for a newly-created org", async () => {
    const orgId = await makeOrg();
    const metrics = await fetchOrgDashboardMetrics(orgId);

    expect(metrics.intakesLastWeek).toBe(0);
    expect(metrics.availableForAdopt).toBe(0);
    expect(metrics.activeAdoptions).toBe(0);
    expect(metrics.requiresActionCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — no DB required
// ---------------------------------------------------------------------------

describe("actionReasonLabel", () => {
  it("returns a non-empty string for each reason", () => {
    const reasons = [
      "overdue_vaccine",
      "overdue_deworming",
      "active_medication_no_dose",
      "long_stay",
    ] as const;
    for (const r of reasons) {
      expect(actionReasonLabel(r).length).toBeGreaterThan(0);
    }
  });
});

describe("actionReasonIcon", () => {
  it("returns a non-empty string for each reason", () => {
    const reasons = [
      "overdue_vaccine",
      "overdue_deworming",
      "active_medication_no_dose",
      "long_stay",
    ] as const;
    for (const r of reasons) {
      expect(actionReasonIcon(r).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// applicableOrgQueues — pure org-type/capability/role gating (no DB) (task #18)
// ---------------------------------------------------------------------------

describe("applicableOrgQueues — org-type gating", () => {
  // Admin implicitly holds every capability; model that as the full grant set
  // for the capabilities the queues gate on.
  const ALL_CAPS = new Set([
    "pet.read_held",
    "org.transfer.accept",
    "foster.assign",
    "adoption.review",
    "capability.grant",
  ]);

  const keysFor = (orgType: string, granted = ALL_CAPS, role = "admin"): OrgQueueKey[] =>
    applicableOrgQueues(orgType, granted, role).map((q) => q.key);

  it("shelter admin gets the full rehoming set", () => {
    const keys = keysFor("shelter");
    expect(keys).toContain("pendingFosterProposals");
    expect(keys).toContain("activeAdoptions");
    expect(keys).toContain("overdueCheckins");
    expect(keys).toContain("activeFosters");
    expect(keys).toContain("openCases");
    expect(keys).toContain("derivedWelfare");
  });

  it("rescue_network admin also gets the rehoming queues", () => {
    const keys = keysFor("rescue_network");
    expect(keys).toContain("pendingFosterProposals");
    expect(keys).toContain("activeAdoptions");
    expect(keys).toContain("activeFosters");
  });

  it("clinic admin never gets structurally-impossible foster/adoption queues", () => {
    const keys = keysFor("clinic");
    expect(keys).not.toContain("pendingFosterProposals");
    expect(keys).not.toContain("activeAdoptions");
    expect(keys).not.toContain("overdueCheckins");
    expect(keys).not.toContain("activeFosters");
    // But universal queues remain.
    expect(keys).toContain("openCases");
    expect(keys).toContain("pendingTransfers");
    expect(keys).toContain("pendingPermits");
  });

  it("sanitary_authority admin gets casos + welfare-derived work, no foster/adoption clutter", () => {
    const keys = keysFor("sanitary_authority");
    expect(keys).toContain("openCases");
    expect(keys).toContain("derivedWelfare");
    expect(keys).not.toContain("pendingFosterProposals");
    expect(keys).not.toContain("activeAdoptions");
  });

  // D-6 (Lote D): the vet's 10-day statutory clock had NO queue at all. It is
  // gated on pet.read_held — the same capability the org's casos list requires,
  // because the row links into that list — so it reaches clinics and sanitary
  // authorities, not only shelters.
  it("the rabies-observation queue reaches every org type that can read held pets", () => {
    for (const orgType of ["shelter", "clinic", "sanitary_authority", "rescue_network"]) {
      expect(keysFor(orgType), orgType).toContain("rabiesObservations");
    }
  });

  it("the rabies-observation queue disappears without pet.read_held", () => {
    const granted = new Set(["org.transfer.accept", "capability.grant"]);
    expect(keysFor("clinic", granted)).not.toContain("rabiesObservations");
  });

  it("welfare queue is role-gated — a foster never sees derived maltrato", () => {
    const keys = keysFor("shelter", ALL_CAPS, "foster");
    expect(keys).not.toContain("derivedWelfare");
  });

  it("a zero-capability member with no role gets no queues", () => {
    expect(applicableOrgQueues("shelter", new Set(), undefined)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// fetchOrgQueueCounts — batched counts (task #18)
// ---------------------------------------------------------------------------

describe("fetchOrgQueueCounts — empty org", () => {
  it("returns 0 for every requested queue on a fresh org", async () => {
    const orgId = await makeOrg();
    const keys: OrgQueueKey[] = [
      "openCases",
      "pendingTransfers",
      "pendingFosterProposals",
      "activeAdoptions",
      "overdueCheckins",
      "activeFosters",
      "derivedWelfare",
      "pendingPermits",
    ];
    const counts = await fetchOrgQueueCounts(orgId, keys);
    for (const k of keys) expect(counts[k]).toBe(0);
  });

  it("only the requested keys are computed; unrequested default to 0", async () => {
    const orgId = await makeOrg();
    const counts = await fetchOrgQueueCounts(orgId, ["openCases"]);
    expect(counts.openCases).toBe(0);
    expect(counts.activeAdoptions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// activeFosters / overdueCheckins — correctness after the org-scoped-first
// rewrite (task #40). The counters were rewritten to DRIVE from the org's
// custody / adoption rows instead of scanning the platform-wide foster or
// reminder population; these assert the counts are unchanged and stay
// org-isolated (another org's fosters/checkins never leak in).
// ---------------------------------------------------------------------------

describe("activeFosters — org-scoped foster count", () => {
  it("counts an active foster placement on a pet this org holds in custody", async () => {
    const orgId = await makeOrg();
    const petId = await makePet();
    await makeCustody(petId, orgId);
    await makeFoster(petId, await makeProfile());

    const counts = await fetchOrgQueueCounts(orgId, ["activeFosters"]);
    expect(counts.activeFosters).toBe(1);
  });

  it("excludes ended fosters and fosters on another org's custody pets", async () => {
    const orgA = await makeOrg();
    const orgB = await makeOrg();
    const fosterUser = await makeProfile();

    // orgA: active custody + active foster → counts.
    const petA = await makePet();
    await makeCustody(petA, orgA);
    await makeFoster(petA, fosterUser);

    // orgA: active custody but the foster has ENDED → excluded.
    const petEnded = await makePet();
    await makeCustody(petEnded, orgA);
    await db.insert(ownerships).values({
      petId: petEnded,
      ownerUserId: fosterUser,
      role: "foster",
      startedAt: new Date(Date.now() - 1000),
      endedAt: new Date(),
    });

    // orgB holds custody of its own pet with a foster — must not leak into orgA.
    const petB = await makePet();
    await makeCustody(petB, orgB);
    await makeFoster(petB, fosterUser);

    expect((await fetchOrgQueueCounts(orgA, ["activeFosters"])).activeFosters).toBe(1);
    expect((await fetchOrgQueueCounts(orgB, ["activeFosters"])).activeFosters).toBe(1);
  });
});

describe("overdueCheckins — org-scoped post-adoption check-in count", () => {
  it("counts an overdue checkin reminder for a pet this org adopted out", async () => {
    const orgId = await makeOrg();
    const petId = await makePet();
    await makeAdoptionFinalized(petId, orgId);
    await makeOverdueCheckinReminder(petId, await makeProfile());

    const counts = await fetchOrgQueueCounts(orgId, ["overdueCheckins"]);
    expect(counts.overdueCheckins).toBe(1);
  });

  it("does not double-count when a pet has two adoption_finalized events for this org", async () => {
    // A re-adoption gives the pet two adoption_finalized events carrying this
    // org; the DISTINCT in the rewrite must keep the single overdue reminder
    // counted exactly once (a naive JOIN would return 2).
    const orgId = await makeOrg();
    const petId = await makePet();
    await makeAdoptionFinalized(petId, orgId);
    await makeAdoptionFinalized(petId, orgId);
    await makeOverdueCheckinReminder(petId, await makeProfile());

    const counts = await fetchOrgQueueCounts(orgId, ["overdueCheckins"]);
    expect(counts.overdueCheckins).toBe(1);
  });

  it("excludes completed / not-yet-due reminders and other orgs' adoptions", async () => {
    const orgA = await makeOrg();
    const orgB = await makeOrg();
    const user = await makeProfile();

    // orgA adopted this pet out, reminder overdue → counts.
    const petOverdue = await makePet();
    await makeAdoptionFinalized(petOverdue, orgA);
    await makeOverdueCheckinReminder(petOverdue, user);

    // orgA adopted out, but the reminder is completed → excluded.
    const petDone = await makePet();
    await makeAdoptionFinalized(petDone, orgA);
    await db.insert(reminders).values({
      petId: petDone,
      userId: user,
      reminderType: "post_adoption_checkin",
      dueAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      title: "hecho",
      completedAt: new Date(),
    });

    // orgB adopted out, reminder overdue → must not leak into orgA.
    const petB = await makePet();
    await makeAdoptionFinalized(petB, orgB);
    await makeOverdueCheckinReminder(petB, user);

    expect((await fetchOrgQueueCounts(orgA, ["overdueCheckins"])).overdueCheckins).toBe(1);
    expect((await fetchOrgQueueCounts(orgB, ["overdueCheckins"])).overdueCheckins).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// derivedWelfare — derived maltrato count (task #46 seed-presence wiring).
// The demo seed derives one welfare report to Alejo's sanitary_authority
// (scripts/seed-demo-spine.ts). These assert the counter that turns that seeded
// row into the authority's "Denuncias de maltrato derivadas (N)" surface: an
// open derived report counts, and terminal / returned reports are excluded —
// exactly the filter countDerivedWelfare applies. Fixture shape mirrors the
// seed, so a seed row of this shape is guaranteed to surface as N≥1.
// ---------------------------------------------------------------------------

describe("derivedWelfare — derived maltrato count", () => {
  it("counts an open report derived to this org (the seeded shape)", async () => {
    const orgId = await makeOrg({ orgType: "sanitary_authority" });
    await makeDerivedWelfare(orgId);

    const counts = await fetchOrgQueueCounts(orgId, ["derivedWelfare"]);
    expect(counts.derivedWelfare).toBe(1);
  });

  it("excludes terminal (closed/invalid) and returned ('devuelto') reports", async () => {
    const orgId = await makeOrg({ orgType: "sanitary_authority" });
    await makeDerivedWelfare(orgId, { status: "closed" });
    await makeDerivedWelfare(orgId, { status: "invalid" });
    await makeDerivedWelfare(orgId, { orgInterventionStatus: "devuelto" });

    const counts = await fetchOrgQueueCounts(orgId, ["derivedWelfare"]);
    expect(counts.derivedWelfare).toBe(0);
  });

  it("stays org-isolated — another org's derived report never leaks in", async () => {
    const orgA = await makeOrg({ orgType: "sanitary_authority" });
    const orgB = await makeOrg({ orgType: "sanitary_authority" });
    await makeDerivedWelfare(orgA);
    await makeDerivedWelfare(orgB, { orgInterventionStatus: "tomado" });

    expect((await fetchOrgQueueCounts(orgA, ["derivedWelfare"])).derivedWelfare).toBe(1);
    expect((await fetchOrgQueueCounts(orgB, ["derivedWelfare"])).derivedWelfare).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// D-6 — the rabies-observation queue. The vet's 10-day statutory clock had no
// presence on their landing at all; this is the count behind that row.
// ---------------------------------------------------------------------------

describe("rabiesObservations — the 10-day statutory clock, counted", () => {
  it("counts an open bite expediente whose pet is under an in-progress observation", async () => {
    const orgId = await makeOrg({ orgType: "clinic" });
    const petId = await makePet();
    await db.update(pets).set({ rabiesObservationStatus: "in_progress" }).where(eq(pets.id, petId));
    await makeCase(petId, { caseKind: "bite_incident", openedByOrganizationId: orgId });

    const counts = await fetchOrgQueueCounts(orgId, ["rabiesObservations"]);
    expect(counts.rabiesObservations).toBe(1);
  });

  it("reaches a pet the org only HOLDS — custody counts, not just authorship", async () => {
    const opener = await makeOrg({ orgType: "sanitary_authority" });
    const holder = await makeOrg();
    const petId = await makePet();
    await makeCustody(petId, holder);
    await db.update(pets).set({ rabiesObservationStatus: "in_progress" }).where(eq(pets.id, petId));
    await makeCase(petId, { caseKind: "bite_incident", openedByOrganizationId: opener });

    expect((await fetchOrgQueueCounts(holder, ["rabiesObservations"])).rabiesObservations).toBe(1);
  });

  it("excludes an ENDED observation — the case may stay open, the clock stopped", async () => {
    const orgId = await makeOrg();
    const petId = await makePet();
    await db
      .update(pets)
      .set({ rabiesObservationStatus: "completed_negative" })
      .where(eq(pets.id, petId));
    await makeCase(petId, { caseKind: "bite_incident", openedByOrganizationId: orgId });

    expect((await fetchOrgQueueCounts(orgId, ["rabiesObservations"])).rabiesObservations).toBe(0);
  });

  it("excludes another org's expediente — no cross-org leak", async () => {
    const orgA = await makeOrg();
    const orgB = await makeOrg();
    const petId = await makePet();
    await db.update(pets).set({ rabiesObservationStatus: "in_progress" }).where(eq(pets.id, petId));
    await makeCase(petId, { caseKind: "bite_incident", openedByOrganizationId: orgA });

    expect((await fetchOrgQueueCounts(orgB, ["rabiesObservations"])).rabiesObservations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D-7 — the decomiso handoff's 7-day legal window (Ley 14.346), as a SIGNAL.
// The pure tone/copy rules live in
// app/org/[orgToken]/_lib/queue-signal-display.test.ts; this asserts the query
// that feeds them actually finds a stale handoff.
// ---------------------------------------------------------------------------

describe("fetchOrgQueueSignals — pendingTransfers", () => {
  const DAY = 24 * 60 * 60 * 1000;

  async function makeDecomisoHandoff(receiverId: string, proposedDaysAgo: number): Promise<void> {
    const authority = await makeOrg({ orgType: "sanitary_authority" });
    const petId = await makePet();
    const caseId = await makeCase(petId, {
      caseKind: "custody_episode",
      openedByOrganizationId: authority,
      receiverOrganizationId: receiverId,
      openedAt: new Date(Date.now() - proposedDaysAgo * DAY),
    });
    await makeProposalEvent(petId, caseId, new Date(Date.now() - proposedDaysAgo * DAY));
  }

  it("THE D-7 CASE: a decomiso handoff proposed 20 days ago reports hasOverdue", async () => {
    const orgId = await makeOrg();
    await makeDecomisoHandoff(orgId, 20);

    const signals = await fetchOrgQueueSignals(orgId, ["pendingTransfers"]);
    expect(signals.pendingTransfers?.hasOverdue).toBe(true);
    expect(signals.pendingTransfers?.oldestAgeDays).toBe(20);
  });

  it("a handoff proposed 2 days ago is NOT overdue, but its age is still reported", async () => {
    const orgId = await makeOrg();
    await makeDecomisoHandoff(orgId, 2);

    const signals = await fetchOrgQueueSignals(orgId, ["pendingTransfers"]);
    expect(signals.pendingTransfers?.hasOverdue).toBe(false);
    expect(signals.pendingTransfers?.oldestAgeDays).toBe(2);
  });

  it("an empty queue reports a null age and nothing overdue", async () => {
    const orgId = await makeOrg();
    const signals = await fetchOrgQueueSignals(orgId, ["pendingTransfers"]);
    expect(signals.pendingTransfers).toEqual({ oldestAgeDays: null, hasOverdue: false });
  });

  it("returns nothing for a queue that carries no signal — never a fabricated zero-age", async () => {
    const orgId = await makeOrg();
    const signals = await fetchOrgQueueSignals(orgId, ["openCases", "derivedWelfare"]);
    expect(signals.openCases).toBeUndefined();
    expect(signals.derivedWelfare).toBeUndefined();
  });
});

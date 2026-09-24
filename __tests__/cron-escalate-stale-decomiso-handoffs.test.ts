// Integration tests for the decomiso stale-handoff escalation cron.
// Spec: decomiso spec §13.5 + DC8.
//
// Three invariants tested:
//
//  1. Stale case (latest proposal >7d) IS found by the scan.
//
//  2. Reassigned case — opened_at is >7d but the LATEST custody_transfer_proposed
//     event is only 3 days old → NOT in scan results. Proves the clock keys on
//     the latest proposal event, NOT on cases.opened_at.
//
//  3. Idempotency — running escalateStaleDecomiso twice on the same candidate
//     inserts notifications only on the first run; the second run finds the
//     existing recent notification and skips (no duplicate rows).
//
//  4. Non-sanitary-authority exclusion — a custody_episode opened by a clinic
//     (org_type != 'sanitary_authority') is excluded from the scan.
//
// Each scenario uses its own pet token to avoid the cases_open_per_pet_kind_idx
// partial unique constraint (at most one open custody_episode per pet at a time).

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, notifications, organizations, petEvents, pets } from "@/db";
import {
  escalateStaleDecomiso,
  findStaleDecomisoCandidates,
} from "@/lib/case-closers/escalate-stale-decomiso-handoffs";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { openCase } from "@/lib/infra/case-helpers";
import { withMutationOverride } from "./_helpers/db-overrides";

// ---------------------------------------------------------------------------
// Tokens (unique to this test file to avoid collisions)
// ---------------------------------------------------------------------------
const SANITARY_ORG_TOKEN = "DIM-DCE-GOVT1";
const SHELTER_ORG_TOKEN = "DIM-DCE-SHE1";
const NON_SANITARY_ORG_TOKEN = "DIM-DCE-CLIN1";
const PET_STALE_TOKEN = "DIM-DCE-P01"; // scenario 1: stale handoff
const PET_REASSIGNED_TOKEN = "DIM-DCE-P02"; // scenario 2: reassigned (clock test)
const PET_NONSANITARY_TOKEN = "DIM-DCE-P03"; // scenario 4: non-sanitary exclusion

let sanitaryOrgId: string;
let shelterOrgId: string;
let nonSanitaryOrgId: string;
let petStaleId: string;
let petReassignedId: string;
let petNonSanitaryId: string;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeAll(async () => {
  // Cleanup any leftover rows from a previous interrupted run.
  const allPetTokens = [PET_STALE_TOKEN, PET_REASSIGNED_TOKEN, PET_NONSANITARY_TOKEN];
  const allOrgTokens = [SANITARY_ORG_TOKEN, SHELTER_ORG_TOKEN, NON_SANITARY_ORG_TOKEN];

  await withMutationOverride(async (tx) => {
    for (const token of allPetTokens) {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token = ${token}
      )`);
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
        SELECT id FROM pets WHERE public_token = ${token}
      )`);
      await tx.execute(sql`DELETE FROM pets WHERE public_token = ${token}`);
    }
    for (const token of allOrgTokens) {
      await tx.execute(sql`DELETE FROM organizations WHERE public_token = ${token}`);
    }
  });

  // Sanitary authority org (the decomiso discriminator).
  const [sanitaryOrg] = await db
    .insert(organizations)
    .values({
      publicToken: SANITARY_ORG_TOKEN,
      legalName: "Autoridad Sanitaria Test",
      displayName: "Autoridad Sanitaria Test",
      orgType: "sanitary_authority",
      email: "sanitary@dim-test.local",
      verified: true,
    })
    .returning();
  sanitaryOrgId = sanitaryOrg.id;

  // Receiving shelter.
  const [shelter] = await db
    .insert(organizations)
    .values({
      publicToken: SHELTER_ORG_TOKEN,
      legalName: "Refugio Test Decomiso",
      displayName: "Refugio Test Decomiso",
      orgType: "shelter",
      email: "shelter-dce@dim-test.local",
      verified: true,
    })
    .returning();
  shelterOrgId = shelter.id;

  // Non-sanitary org (clinic — must be excluded from scan).
  const [clinic] = await db
    .insert(organizations)
    .values({
      publicToken: NON_SANITARY_ORG_TOKEN,
      legalName: "Clínica Test Decomiso",
      displayName: "Clínica Test Decomiso",
      orgType: "clinic",
      email: "clinic-dce@dim-test.local",
      verified: true,
    })
    .returning();
  nonSanitaryOrgId = clinic.id;

  // Subject pets (one per scenario to avoid the per-pet open-case unique index).
  const [petStale] = await db
    .insert(pets)
    .values({
      publicToken: PET_STALE_TOKEN,
      name: "DecomisoCronStale",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petStaleId = petStale.id;

  const [petReassigned] = await db
    .insert(pets)
    .values({
      publicToken: PET_REASSIGNED_TOKEN,
      name: "DecomisoCronReassigned",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petReassignedId = petReassigned.id;

  const [petNonSanitary] = await db
    .insert(pets)
    .values({
      publicToken: PET_NONSANITARY_TOKEN,
      name: "DecomisoCronNonSanitary",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petNonSanitaryId = petNonSanitary.id;
});

afterAll(async () => {
  const allPetIds = [petStaleId, petReassignedId, petNonSanitaryId].filter(Boolean);
  await withMutationOverride(async (tx) => {
    for (const pid of allPetIds) {
      await tx.execute(sql`DELETE FROM notifications WHERE related_case_id IN (
        SELECT id FROM cases WHERE primary_pet_id = ${pid}
      )`);
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${pid}`);
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${pid}`);
      await tx.execute(sql`DELETE FROM pets WHERE id = ${pid}`);
    }
    await tx.execute(
      sql`DELETE FROM organizations WHERE id IN (${sanitaryOrgId}::uuid, ${shelterOrgId}::uuid, ${nonSanitaryOrgId}::uuid)`,
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertIntakeEvent(petLocalId: string, caseId: string, occurredAt: Date) {
  const payload = validateEventPayload("shelter_intake_recorded", {
    intake_reason: "seizure",
    intake_condition: "Condición regular al momento del decomiso.",
    rescue_jurisdiction: null,
    seizure_motive: "maltrato_fisico",
    seizure_motive_other_detail: null,
    judicial_proceeding_reference: null,
    originating_welfare_report_id: null,
    intended_receiver_organization_id: shelterOrgId,
  });
  await db.insert(petEvents).values({
    petId: petLocalId,
    eventType: "shelter_intake_recorded",
    occurredAt,
    recordedAt: occurredAt,
    authorRole: "govt",
    authorOrganizationId: sanitaryOrgId,
    payload,
    caseId,
  });
}

async function insertProposalEvent(
  petLocalId: string,
  caseId: string,
  proposalOccurredAt: Date,
  fromOrgId: string,
) {
  const payload = validateEventPayload("custody_transfer_proposed", {
    from_user_id: null,
    from_organization_id: fromOrgId,
    to_user_id: null,
    to_organization_id: shelterOrgId,
    reason: "org_to_org_handoff",
    notes: null,
    matched_against_pet_id: null,
    proposed_at: proposalOccurredAt.toISOString(),
  });
  await db.insert(petEvents).values({
    petId: petLocalId,
    eventType: "custody_transfer_proposed",
    occurredAt: proposalOccurredAt,
    recordedAt: proposalOccurredAt,
    authorRole: "govt",
    authorOrganizationId: fromOrgId,
    payload,
    caseId,
  });
}

// ---------------------------------------------------------------------------
// Scenario 1: Stale handoff — latest proposal >7d
// ---------------------------------------------------------------------------
describe("decomiso handoff cron — stale handoff is found", () => {
  let staleCaseId: string;

  beforeAll(async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const c = await openCase({
      kind: "custody_episode",
      primarySubjectKind: "registered_pet",
      primaryPetId: petStaleId,
      openedByOrganizationId: sanitaryOrgId,
      receiverOrganizationId: shelterOrgId,
      openedReason: { code: "decomiso_executed", motive: "maltrato_fisico", judicialRef: null },
    });
    staleCaseId = c.id;
    await db.execute(
      sql`UPDATE cases SET opened_at = ${tenDaysAgo.toISOString()}::timestamptz WHERE id = ${staleCaseId}`,
    );
    await insertIntakeEvent(petStaleId, staleCaseId, tenDaysAgo);
    await insertProposalEvent(petStaleId, staleCaseId, tenDaysAgo, sanitaryOrgId);
  });

  it("scan includes case with latest proposal >7d old", async () => {
    const candidates = await findStaleDecomisoCandidates({ staleAfterDays: 7 });
    expect(candidates.some((c) => c.id === staleCaseId)).toBe(true);
  });

  it("escalate inserts decomiso_handoff_stale notifications", async () => {
    const candidates = await findStaleDecomisoCandidates({ staleAfterDays: 7 });
    const candidate = candidates.find((c) => c.id === staleCaseId);
    expect(candidate).toBeDefined();
    if (!candidate) return;

    await escalateStaleDecomiso(candidate);

    const notifs = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.notificationType, "decomiso_handoff_stale"),
          eq(notifications.relatedCaseId, staleCaseId),
        ),
      );
    expect(notifs.length).toBeGreaterThan(0);
  });

  it("idempotency — second run inserts no new notifications", async () => {
    const before = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.notificationType, "decomiso_handoff_stale"),
          eq(notifications.relatedCaseId, staleCaseId),
        ),
      );
    const countBefore = before.length;
    expect(countBefore).toBeGreaterThan(0); // first run inserted something

    const candidates = await findStaleDecomisoCandidates({ staleAfterDays: 7 });
    const candidate = candidates.find((c) => c.id === staleCaseId);
    if (candidate) {
      await escalateStaleDecomiso(candidate);
    }

    const after = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.notificationType, "decomiso_handoff_stale"),
          eq(notifications.relatedCaseId, staleCaseId),
        ),
      );
    expect(after.length).toBe(countBefore); // no new rows
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Reassigned — opened_at >7d but latest proposal <7d → excluded
// ---------------------------------------------------------------------------
describe("decomiso handoff cron — reassigned case excluded (clock on latest proposal)", () => {
  let reassignedCaseId: string;

  beforeAll(async () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    const c = await openCase({
      kind: "custody_episode",
      primarySubjectKind: "registered_pet",
      primaryPetId: petReassignedId,
      openedByOrganizationId: sanitaryOrgId,
      receiverOrganizationId: shelterOrgId,
      openedReason: { code: "decomiso_executed", motive: "abandono_extremo", judicialRef: null },
    });
    reassignedCaseId = c.id;

    // opened_at = 20 days ago (would be stale if the clock used opened_at).
    await db.execute(
      sql`UPDATE cases SET opened_at = ${twentyDaysAgo.toISOString()}::timestamptz WHERE id = ${reassignedCaseId}`,
    );
    await insertIntakeEvent(petReassignedId, reassignedCaseId, twentyDaysAgo);
    // First proposal: 20 days ago (stale if clocked on it alone).
    await insertProposalEvent(petReassignedId, reassignedCaseId, twentyDaysAgo, sanitaryOrgId);
    // Reassign: new proposal 3 days ago — this resets the 7-day window.
    await insertProposalEvent(petReassignedId, reassignedCaseId, threeDaysAgo, sanitaryOrgId);
  });

  it("scan excludes case where latest proposal is <7d old (even if opened_at >7d)", async () => {
    const candidates = await findStaleDecomisoCandidates({ staleAfterDays: 7 });
    expect(candidates.some((c) => c.id === reassignedCaseId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Non-sanitary-authority org — excluded from scan
// ---------------------------------------------------------------------------
describe("decomiso handoff cron — non-sanitary-authority org excluded", () => {
  let nonDecomisoCaseId: string;

  beforeAll(async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const c = await openCase({
      kind: "custody_episode",
      primarySubjectKind: "registered_pet",
      primaryPetId: petNonSanitaryId,
      openedByOrganizationId: nonSanitaryOrgId, // clinic, NOT sanitary_authority
      receiverOrganizationId: shelterOrgId,
      openedReason: { code: "org_intake", intakeReason: "rescue" },
    });
    nonDecomisoCaseId = c.id;

    await db.execute(
      sql`UPDATE cases SET opened_at = ${tenDaysAgo.toISOString()}::timestamptz WHERE id = ${nonDecomisoCaseId}`,
    );
    // Insert a stale proposal — would be found if the org check were missing.
    const payload = validateEventPayload("custody_transfer_proposed", {
      from_user_id: null,
      from_organization_id: nonSanitaryOrgId,
      to_user_id: null,
      to_organization_id: shelterOrgId,
      reason: "org_to_org_handoff",
      notes: null,
      matched_against_pet_id: null,
      proposed_at: tenDaysAgo.toISOString(),
    });
    await db.insert(petEvents).values({
      petId: petNonSanitaryId,
      eventType: "custody_transfer_proposed",
      occurredAt: tenDaysAgo,
      recordedAt: tenDaysAgo,
      authorRole: "shelter",
      authorOrganizationId: nonSanitaryOrgId,
      payload,
      caseId: nonDecomisoCaseId,
    });
  });

  it("scan excludes custody_episode opened by non-sanitary-authority org", async () => {
    const candidates = await findStaleDecomisoCandidates({ staleAfterDays: 7 });
    expect(candidates.some((c) => c.id === nonDecomisoCaseId)).toBe(false);
  });
});

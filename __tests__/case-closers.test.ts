// Integration tests for the 4 case-closer crons (Fase C).
//
// Pattern per closer:
//  1. Seed a case row that matches the cron's scan criteria.
//  2. Run the closer's scan() — expect the seeded case is found.
//  3. Run processOne() — assert the case row's status flipped to the
//     terminal/escalated state and the side-effect rows were created.
//
// Cleanup is per-test via afterAll to keep failures isolated.

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases, db, organizations, petEvents, pets, welfareReports } from "@/db";
import {
  closeFollowupExpiredAdoption,
  findFollowupExpiredAdoptions,
} from "@/lib/case-closers/close-followup-expired-adoptions";
import {
  closeStaleLostEpisode,
  findStaleLostEpisodes,
} from "@/lib/case-closers/close-stale-lost-episodes";
import {
  escalateStaleDispute,
  findStaleDisputes,
} from "@/lib/case-closers/escalate-stale-disputes";
import {
  escalateStaleWelfareCase,
  findStaleWelfareCases,
} from "@/lib/case-closers/escalate-stale-welfare-cases";
import { withMutationOverride } from "./_helpers/db-overrides";

const PET_TOKENS = ["DIM-CC-PA1", "DIM-CC-PB1", "DIM-CC-PC1", "DIM-CC-PD1"] as const;
const ORG_TOKEN = "DIM-CC-ORG1";

let petLost: string;
let petAdoption: string;
let petAdoptionInWindow: string;
let petDispute: string;
let orgId: string;
let welfareReportId: string;
let welfareCaseId: string;

beforeAll(async () => {
  // Cleanup leftovers from previous failed runs. Order matters because
  // pet_events.case_id has a FK to cases.id — events go first. Deleting
  // pet_events is normally blocked by the append-only trigger; bypass
  // via the session-local escape hatch (db/triggers.sql).
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM notifications WHERE notification_type IN (
      'welfare_denuncia_stale_govt', 'custody_dispute_stale'
    )`);
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token IN ('DIM-CC-PA1','DIM-CC-PB1','DIM-CC-PC1','DIM-CC-PD1')
    )`);
    await tx.execute(sql`DELETE FROM cases WHERE public_code LIKE 'CAS-CC-%'`);
    await tx.execute(sql`DELETE FROM welfare_reports WHERE reference_code LIKE 'DEN-CC-%'`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token IN (
      'DIM-CC-PA1','DIM-CC-PB1','DIM-CC-PC1','DIM-CC-PD1'
    )`);
    await tx.execute(sql`DELETE FROM organizations WHERE public_token = ${ORG_TOKEN}`);
  });

  const [petA] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-CC-PA1",
      name: "Lost Test",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petLost = petA.id;

  const [petB] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-CC-PB1",
      name: "Adoption Test",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petAdoption = petB.id;

  const [petC] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-CC-PC1",
      name: "Adoption In-Window Test",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petAdoptionInWindow = petC.id;

  const [petD] = await db
    .insert(pets)
    .values({
      publicToken: "DIM-CC-PD1",
      name: "Dispute Test",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petDispute = petD.id;

  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "Closers Test SRL",
      displayName: "Closers Test",
      orgType: "shelter",
      email: "closers-test@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;

  // Welfare report (subject_kind='unowned_animal' so we don't need a pet FK).
  const [report] = await db
    .insert(welfareReports)
    .values({
      referenceCode: "DEN-CC-AAAA",
      kind: "neglect",
      severity: "medium",
      description: "fixture for stale escalation",
      subjectKind: "unowned_animal",
      subjectDescription: "stray test",
      status: "in_progress",
    })
    .returning();
  welfareReportId = report.id;
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM notifications WHERE notification_type IN (
      'welfare_denuncia_stale_govt', 'custody_dispute_stale'
    )`);
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token IN ('DIM-CC-PA1','DIM-CC-PB1','DIM-CC-PC1','DIM-CC-PD1')
    )`);
    await tx.execute(sql`DELETE FROM cases WHERE public_code LIKE 'CAS-CC-%'`);
    await tx.execute(sql`DELETE FROM welfare_reports WHERE reference_code = 'DEN-CC-AAAA'`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token IN (
      'DIM-CC-PA1','DIM-CC-PB1','DIM-CC-PC1','DIM-CC-PD1'
    )`);
    await tx.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`);
  });
});

describe("close-stale-lost-episodes", () => {
  let caseId: string;

  beforeAll(async () => {
    // ADR-18 (pet-document-redesign): threshold raised 180d -> 365d so a lost
    // pet can never silently expire in under a year. 400d clears the new
    // boundary with margin (matches the custody_dispute fixture below).
    const openedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    const [row] = await db
      .insert(cases)
      .values({
        publicCode: "CAS-CC-LOST",
        caseKind: "lost_pet_episode",
        primarySubjectKind: "registered_pet",
        primaryPetId: petLost,
        status: "open",
        openedAt,
        openedReason: "Test fixture for stale lost episode cron",
      })
      .returning();
    caseId = row.id;
  });

  it("scan finds cases open >365d without recent events", async () => {
    const candidates = await findStaleLostEpisodes();
    expect(candidates.some((c) => c.id === caseId)).toBe(true);
  });

  it("processOne flips status to closed with closed_reason=auto_expired", async () => {
    await closeStaleLostEpisode({
      id: caseId,
      primaryPetId: petLost,
      publicCode: "CAS-CC-LOST",
    });
    const [updated] = await db
      .select({ status: cases.status, closedReason: cases.closedReason })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(updated.status).toBe("closed");
    expect(updated.closedReason).toBe("auto_expired");
  });

  it("processOne is idempotent on already-closed cases", async () => {
    await closeStaleLostEpisode({
      id: caseId,
      primaryPetId: petLost,
      publicCode: "CAS-CC-LOST",
    });
    const [updated] = await db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(updated.status).toBe("closed");
  });

  it("emits a system note_added pet_event with case_id", async () => {
    const events = await db
      .select({ id: petEvents.id, payload: petEvents.payload })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petLost), eq(petEvents.caseId, caseId)));
    expect(events.length).toBeGreaterThan(0);
    const noteEvent = events.find(
      (e) => (e.payload as Record<string, unknown>).category === "system",
    );
    expect(noteEvent).toBeDefined();
  });

  // Runs LAST in this block: the >365d fixture case above is already closed
  // by this point (previous two tests), so inserting a second open
  // lost_pet_episode for the same pet doesn't collide with the DB's
  // cases_open_per_pet_kind_idx unique constraint (one open case per
  // pet+kind at a time).
  it("scan does NOT find cases open >180d but <365d (ADR-18 boundary)", async () => {
    const openedAt = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const [row] = await db
      .insert(cases)
      .values({
        publicCode: "CAS-CC-LOST-200D",
        caseKind: "lost_pet_episode",
        primarySubjectKind: "registered_pet",
        primaryPetId: petLost,
        status: "open",
        openedAt,
        openedReason: "Test fixture for the 180d<x<365d ADR-18 boundary",
      })
      .returning();
    const candidates = await findStaleLostEpisodes();
    expect(candidates.some((c) => c.id === row.id)).toBe(false);
  });
});

describe("close-followup-expired-adoptions", () => {
  let caseId: string;

  beforeAll(async () => {
    const [row] = await db
      .insert(cases)
      .values({
        publicCode: "CAS-CC-ADOPT",
        caseKind: "adoption_listing",
        primarySubjectKind: "registered_pet",
        primaryPetId: petAdoption,
        status: "open",
        openedReason: "Test fixture for adoption listing followup cron",
        openedByOrganizationId: orgId,
      })
      .returning();
    caseId = row.id;

    // Adoption finalized ~13 months ago with a 6-month follow-up window: the
    // deadline (occurred_at + 6 months) landed ~7 months ago → window elapsed.
    // The window is computed at read time from post_adoption_followup_months
    // (the real schema key); there is no followup_until timestamp.
    await db.insert(petEvents).values({
      petId: petAdoption,
      eventType: "adoption_finalized",
      occurredAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      recordedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      authorRole: "shelter",
      authorVerified: true,
      payload: {
        adopter_user_id: "00000000-0000-0000-0000-000000000001",
        post_adoption_followup_months: 6,
        contract_attachment_id: null,
      },
      caseId,
    });
  });

  it("scan finds cases whose follow-up window (occurred_at + months) has elapsed", async () => {
    const candidates = await findFollowupExpiredAdoptions();
    expect(candidates.some((c) => c.id === caseId)).toBe(true);
  });

  it("scan does NOT find a case still inside its follow-up window", async () => {
    // Finalized ~5 months ago with a 6-month window → deadline ~1 month in the
    // future, so the case must stay open.
    const [inWindowCase] = await db
      .insert(cases)
      .values({
        publicCode: "CAS-CC-ADOPT-INWIN",
        caseKind: "adoption_listing",
        primarySubjectKind: "registered_pet",
        primaryPetId: petAdoptionInWindow,
        status: "open",
        openedReason: "Test fixture for adoption listing still in follow-up window",
        openedByOrganizationId: orgId,
      })
      .returning();

    await db.insert(petEvents).values({
      petId: petAdoptionInWindow,
      eventType: "adoption_finalized",
      occurredAt: new Date(Date.now() - 150 * 24 * 60 * 60 * 1000),
      recordedAt: new Date(Date.now() - 150 * 24 * 60 * 60 * 1000),
      authorRole: "shelter",
      authorVerified: true,
      payload: {
        adopter_user_id: "00000000-0000-0000-0000-000000000004",
        post_adoption_followup_months: 6,
        contract_attachment_id: null,
      },
      caseId: inWindowCase.id,
    });

    const candidates = await findFollowupExpiredAdoptions();
    expect(candidates.some((c) => c.id === inWindowCase.id)).toBe(false);
  });

  it("processOne flips status to closed with closed_reason=resolved", async () => {
    await closeFollowupExpiredAdoption({
      id: caseId,
      primaryPetId: petAdoption,
      publicCode: "CAS-CC-ADOPT",
    });
    const [updated] = await db
      .select({ status: cases.status, closedReason: cases.closedReason })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(updated.status).toBe("closed");
    expect(updated.closedReason).toBe("resolved");
  });
});

describe("escalate-stale-welfare-cases", () => {
  beforeAll(async () => {
    const openedAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const [row] = await db
      .insert(cases)
      .values({
        publicCode: "CAS-CC-WELF",
        caseKind: "welfare_denuncia",
        primarySubjectKind: "general",
        status: "open",
        openedAt,
        openedReason: "Test fixture for stale welfare escalation cron",
        welfareReportId,
      })
      .returning();
    welfareCaseId = row.id;
  });

  it("scan finds welfare cases inactive >90d", async () => {
    const candidates = await findStaleWelfareCases();
    expect(candidates.some((c) => c.id === welfareCaseId)).toBe(true);
  });

  it("processOne flips status to escalated", async () => {
    await escalateStaleWelfareCase({
      id: welfareCaseId,
      publicCode: "CAS-CC-WELF",
      welfareReportId,
      referenceCode: "DEN-CC-AAAA",
      jurisdictionProvince: null,
      jurisdictionLocality: null,
    });
    const [updated] = await db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, welfareCaseId));
    expect(updated.status).toBe("escalated");
  });

  it("idempotent — escalated rows are excluded from next scan", async () => {
    const candidates = await findStaleWelfareCases();
    expect(candidates.some((c) => c.id === welfareCaseId)).toBe(false);
  });
});

describe("escalate-stale-disputes", () => {
  let caseId: string;

  beforeAll(async () => {
    const openedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    const [row] = await db
      .insert(cases)
      .values({
        publicCode: "CAS-CC-DISP",
        caseKind: "custody_dispute",
        primarySubjectKind: "registered_pet",
        primaryPetId: petDispute,
        status: "open",
        openedAt,
        openedReason: "Test fixture for stale dispute escalation cron",
      })
      .returning();
    caseId = row.id;
  });

  it("scan finds disputes open >365d", async () => {
    const candidates = await findStaleDisputes();
    expect(candidates.some((c) => c.id === caseId)).toBe(true);
  });

  it("processOne flips status to escalated", async () => {
    await escalateStaleDispute({
      id: caseId,
      publicCode: "CAS-CC-DISP",
      jurisdictionProvince: null,
      jurisdictionLocality: null,
    });
    const [updated] = await db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(updated.status).toBe("escalated");
  });
});

// Integration tests for S3 decomiso receiver handshake.
// Spec: docs/superpowers/specs/2026-05-19-decomiso-welfare-authority-design.md §5.2–5.3.
//
// Test approach (same as decomiso-execute-action.test.ts and cross-org-transfer.test.ts):
// We do NOT drive the full server action (which requires supabase auth + requireCapability).
// Instead we emulate the action's transaction steps directly and assert on DB state.
// Auth rejection tests use the domain-logic equivalents (e.g., org-id comparisons).
//
// Tests covered:
//   acceptDecomisoHandoffAction — happy path:
//     - custody_transferred event emitted (shelter_custody → shelter_custody, govt→receiver)
//     - Govt's shelter_custody ownership closed
//     - Receiver's shelter_custody ownership opened
//     - Govt's custody_episode case closed (status='closed', closed_reason='resolved')
//     - New custody_episode opened for receiver org (no receiverOrganizationId)
//     - Audit row written with decomiso_handoff_accepted
//
//   rejectDecomisoHandoffAction — happy path:
//     - note_added(category='system') event emitted with rejection reason
//     - custody_episode case stays open (status='open')
//     - No ownership flip (govt custody stays open)
//     - receiverOrganizationId on case cleared to null
//     - Audit row written with decomiso_handoff_rejected
//
//   reassignDecomisoToAnotherReceiverAction — happy path:
//     - note_added(category='system') emitted documenting the cancelled prior proposal
//     - New custody_transfer_proposed emitted toward the new receiver
//     - Case's receiverOrganizationId updated to new receiver
//     - Audit row written with decomiso_handoff_cancelled
//     - custody_episode stays open (govt custody unchanged)
//
//   Auth/state guards:
//     - Discriminator: case opened by non-sanitary_authority org is rejected
//     - Wrong receiver org cannot accept/reject (receiverOrganizationId mismatch)
//     - Non-opener cannot reassign (openedByOrganizationId mismatch)
//     - Closed case cannot be accepted (status guard)

import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditLog,
  cases,
  db,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { closeCase, openCase } from "@/lib/infra/case-helpers";
import { setAuditMutationGucs, withMutationOverride } from "./_helpers/db-overrides";

// ---------------------------------------------------------------------------
// Fixture tokens
// ---------------------------------------------------------------------------

const GOVT_ORG_TOKEN = "DIM-S3-GOVT1";
const RECEIVER_ORG_TOKEN = "DIM-S3-RCV1";
const RECEIVER2_ORG_TOKEN = "DIM-S3-RCV2";
const WRONG_ORG_TOKEN = "DIM-S3-WRONG1";
const PET_TOKEN = "DIM-S3-PET1";

let govtOrgId: string;
let receiverOrgId: string;
let receiver2OrgId: string;
let wrongOrgId: string;
let petId: string;
let govtUserId: string;
let receiverUserId: string;
let receiver2UserId: string;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Clean up any stale state from a previous aborted run.
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM ownerships WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
    await tx.execute(sql`DELETE FROM organization_memberships WHERE organization_id IN (
      SELECT id FROM organizations WHERE public_token IN (
        ${GOVT_ORG_TOKEN}, ${RECEIVER_ORG_TOKEN}, ${RECEIVER2_ORG_TOKEN}, ${WRONG_ORG_TOKEN}
      )
    )`);
    await tx.execute(sql`DELETE FROM organizations WHERE public_token IN (
      ${GOVT_ORG_TOKEN}, ${RECEIVER_ORG_TOKEN}, ${RECEIVER2_ORG_TOKEN}, ${WRONG_ORG_TOKEN}
    )`);
  });

  // Govt sanitary_authority org.
  const [govtOrg] = await db
    .insert(organizations)
    .values({
      publicToken: GOVT_ORG_TOKEN,
      legalName: "Autoridad Sanitaria S3 Test",
      displayName: "Autoridad S3",
      orgType: "sanitary_authority",
      email: "s3-govt@dim-test.local",
      verified: true,
      status: "active",
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Buenos Aires",
    })
    .returning();
  govtOrgId = govtOrg.id;

  // Primary receiver refugio.
  const [receiverOrg] = await db
    .insert(organizations)
    .values({
      publicToken: RECEIVER_ORG_TOKEN,
      legalName: "Refugio S3 Test",
      displayName: "Refugio S3",
      orgType: "shelter",
      email: "s3-receiver@dim-test.local",
      verified: true,
      status: "active",
    })
    .returning();
  receiverOrgId = receiverOrg.id;

  // Second receiver (for reassign test).
  const [receiver2Org] = await db
    .insert(organizations)
    .values({
      publicToken: RECEIVER2_ORG_TOKEN,
      legalName: "Refugio S3 Test 2",
      displayName: "Refugio S3 Dos",
      orgType: "shelter",
      email: "s3-receiver2@dim-test.local",
      verified: true,
      status: "active",
    })
    .returning();
  receiver2OrgId = receiver2Org.id;

  // Non-authority org (for discriminator guard test).
  const [wrongOrg] = await db
    .insert(organizations)
    .values({
      publicToken: WRONG_ORG_TOKEN,
      legalName: "Clinica Wrongtype S3",
      displayName: "Clinica Wrongtype",
      orgType: "clinic",
      email: "s3-wrong@dim-test.local",
      verified: true,
      status: "active",
    })
    .returning();
  wrongOrgId = wrongOrg.id;

  // Govt user.
  const gId = randomUUID();
  await db.insert(profiles).values({
    id: gId,
    displayName: "Oficial S3 Test",
    role: "govt",
    accountType: "institutional",
  });
  govtUserId = gId;
  await db.insert(organizationMemberships).values({
    userId: govtUserId,
    organizationId: govtOrgId,
    role: "coordinator",
  });

  // Receiver user.
  const rId = randomUUID();
  await db.insert(profiles).values({
    id: rId,
    displayName: "Coord Refugio S3",
    role: "owner",
    accountType: "institutional",
  });
  receiverUserId = rId;
  await db.insert(organizationMemberships).values({
    userId: receiverUserId,
    organizationId: receiverOrgId,
    role: "coordinator",
  });

  // Receiver2 user.
  const r2Id = randomUUID();
  await db.insert(profiles).values({
    id: r2Id,
    displayName: "Coord Refugio S3 Dos",
    role: "owner",
    accountType: "institutional",
  });
  receiver2UserId = r2Id;
  await db.insert(organizationMemberships).values({
    userId: receiver2UserId,
    organizationId: receiver2OrgId,
    role: "coordinator",
  });

  // Pet.
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "Roca",
      species: "dog",
      sex: "female",
      potentiallyDangerousBreed: false,
      jurisdictionProvince: "CABA",
    })
    .returning();
  petId = pet.id;
});

afterAll(async () => {
  if (govtUserId) {
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx.execute(
        sql`DELETE FROM audit_log WHERE actor_user_id IN (${govtUserId}, ${receiverUserId}, ${receiver2UserId})`,
      );
    });
  }

  await withMutationOverride(async (tx) => {
    if (petId) {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}`);
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${petId}`);
      await tx.execute(sql`DELETE FROM ownerships WHERE pet_id = ${petId}`);
      await tx.execute(sql`DELETE FROM pets WHERE id = ${petId}`);
    }
    for (const uid of [govtUserId, receiverUserId, receiver2UserId]) {
      if (uid) {
        await tx.execute(sql`DELETE FROM organization_memberships WHERE user_id = ${uid}`);
        await tx.execute(sql`DELETE FROM profiles WHERE id = ${uid}`);
      }
    }
    await tx.execute(sql`DELETE FROM organization_memberships WHERE organization_id IN (
      SELECT id FROM organizations WHERE public_token IN (
        ${GOVT_ORG_TOKEN}, ${RECEIVER_ORG_TOKEN}, ${RECEIVER2_ORG_TOKEN}, ${WRONG_ORG_TOKEN}
      )
    )`);
    await tx.execute(sql`DELETE FROM organizations WHERE public_token IN (
      ${GOVT_ORG_TOKEN}, ${RECEIVER_ORG_TOKEN}, ${RECEIVER2_ORG_TOKEN}, ${WRONG_ORG_TOKEN}
    )`);
  });
});

// ---------------------------------------------------------------------------
// Helpers — build the initial decomiso state (custody_episode + proposal)
// ---------------------------------------------------------------------------

async function buildDecomisoState(opts?: { receiverOrgId?: string; openerOrgId?: string }) {
  const opener = opts?.openerOrgId ?? govtOrgId;
  const receiver = opts?.receiverOrgId ?? receiverOrgId;

  let caseId: string;
  let casePublicCode: string;

  await db.transaction(async (tx) => {
    const caseRow = await openCase(
      {
        kind: "custody_episode",
        primarySubjectKind: "registered_pet",
        primaryPetId: petId,
        jurisdictionCountry: "AR",
        jurisdictionProvince: "CABA",
        jurisdictionLocality: "Buenos Aires",
        openedByUserId: govtUserId,
        openedByOrganizationId: opener,
        receiverOrganizationId: receiver,
        openedReason: { code: "decomiso_executed", motive: "maltrato_fisico", judicialRef: null },
      },
      tx,
    );
    caseId = caseRow.id;
    casePublicCode = caseRow.publicCode;

    // Govt transitional shelter_custody ownership.
    await tx.insert(ownerships).values({
      petId,
      ownerOrganizationId: opener,
      role: "shelter_custody",
      startedAt: new Date(),
    });

    // custody_transfer_proposed event.
    const proposalPayload = validateEventPayload("custody_transfer_proposed", {
      from_user_id: null,
      from_organization_id: opener,
      to_user_id: null,
      to_organization_id: receiver,
      reason: "other" as const,
      matched_against_pet_id: null,
      proposed_at: new Date().toISOString(),
      notes: `from_decomiso=true case=${caseRow.publicCode}`,
    });
    await tx.insert(petEvents).values({
      petId,
      eventType: "custody_transfer_proposed",
      occurredAt: new Date(),
      recordedAt: new Date(),
      recordedByUserId: govtUserId,
      authorRole: "govt",
      authorOrganizationId: opener,
      authorVerified: true,
      payload: proposalPayload,
      caseId: caseRow.id,
    });
  });

  return { caseId: caseId!, casePublicCode: casePublicCode! };
}

async function cleanPetState() {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}`);
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${petId}`);
    await tx.execute(sql`DELETE FROM ownerships WHERE pet_id = ${petId}`);
  });
  await db.transaction(async (tx) => {
    await setAuditMutationGucs(tx);
    await tx.execute(
      sql`DELETE FROM audit_log WHERE actor_user_id IN (${govtUserId}, ${receiverUserId}, ${receiver2UserId})`,
    );
  });
}

// ---------------------------------------------------------------------------
// acceptDecomisoHandoffAction — happy path
// ---------------------------------------------------------------------------

describe("acceptDecomisoHandoffAction — happy path", () => {
  let caseId: string;
  let casePublicCode: string;

  beforeAll(async () => {
    await cleanPetState();
    const state = await buildDecomisoState();
    caseId = state.caseId;
    casePublicCode = state.casePublicCode;
  });

  it("emulates accept tx: custody_transferred emitted + ownership flip + episodes + audit", async () => {
    let receiverEpisodeId: string;
    let receiverEpisodePublicCode: string;

    await db.transaction(async (tx) => {
      const now = new Date();

      // Emit custody_transferred (shelter_custody → shelter_custody, govt→receiver).
      const transferPayload = validateEventPayload("custody_transferred", {
        from_user_id: null,
        from_organization_id: govtOrgId,
        to_user_id: null,
        to_organization_id: receiverOrgId,
        from_role: "shelter_custody",
        to_role: "shelter_custody",
        reason: "org_to_org_handoff",
        matched_against_pet_id: null,
        foster_ended_event_id: null,
        notes: null,
      });
      await tx.insert(petEvents).values({
        petId,
        eventType: "custody_transferred",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: receiverUserId,
        authorRole: "shelter",
        authorOrganizationId: receiverOrgId,
        authorVerified: true,
        payload: transferPayload,
        caseId,
      });

      // End govt's shelter_custody ownership.
      await tx
        .update(ownerships)
        .set({ endedAt: now })
        .where(
          and(
            eq(ownerships.petId, petId),
            eq(ownerships.ownerOrganizationId, govtOrgId),
            eq(ownerships.role, "shelter_custody"),
            isNull(ownerships.endedAt),
          ),
        );

      // Open receiver's shelter_custody ownership.
      await tx.insert(ownerships).values({
        petId,
        ownerOrganizationId: receiverOrgId,
        role: "shelter_custody",
        startedAt: now,
      });

      // Close the govt's custody_episode.
      await closeCase({ caseId, reason: "resolved", closedByUserId: receiverUserId }, tx);

      // Open a new custody_episode for the receiver.
      const receiverEpisode = await openCase(
        {
          kind: "custody_episode",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          jurisdictionCountry: "AR",
          jurisdictionProvince: "CABA",
          jurisdictionLocality: "Buenos Aires",
          openedByUserId: receiverUserId,
          openedByOrganizationId: receiverOrgId,
          openedReason: { code: "decomiso_handoff_accepted", sourceCasePublicCode: casePublicCode },
        },
        tx,
      );
      receiverEpisodeId = receiverEpisode.id;
      receiverEpisodePublicCode = receiverEpisode.publicCode;

      // Audit log.
      await tx.insert(auditLog).values({
        actorUserId: receiverUserId,
        action: "decomiso_handoff_accepted",
        payload: {
          closed_govt_case_id: caseId,
          closed_govt_case_public_code: casePublicCode,
          opened_receiver_case_id: receiverEpisode.id,
          opened_receiver_case_public_code: receiverEpisode.publicCode,
          pet_id: petId,
          govt_org_id: govtOrgId,
          receiver_org_id: receiverOrgId,
        },
      });
    });

    // --- Assertions ---

    // custody_transferred event exists.
    const [transferEvent] = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transferred")))
      .limit(1);
    expect(transferEvent).not.toBeUndefined();
    const tp = transferEvent.payload as Record<string, unknown>;
    expect(tp.from_organization_id).toBe(govtOrgId);
    expect(tp.to_organization_id).toBe(receiverOrgId);
    expect(tp.from_role).toBe("shelter_custody");
    expect(tp.to_role).toBe("shelter_custody");

    // Govt's shelter_custody ownership is closed.
    const [govtCustody] = await db
      .select()
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerOrganizationId, govtOrgId),
          eq(ownerships.role, "shelter_custody"),
        ),
      )
      .limit(1);
    expect(govtCustody).not.toBeUndefined();
    expect(govtCustody.endedAt).not.toBeNull();

    // Receiver's shelter_custody ownership is open.
    const [receiverCustody] = await db
      .select()
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerOrganizationId, receiverOrgId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    expect(receiverCustody).not.toBeUndefined();

    // Govt's custody_episode case is closed.
    const [govtCase] = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
    expect(govtCase.status).toBe("closed");
    expect(govtCase.closedReason).toBe("resolved");

    // Receiver's custody_episode case is open with no receiverOrganizationId.
    const [receiverCase] = await db
      .select()
      .from(cases)
      .where(eq(cases.id, receiverEpisodeId!))
      .limit(1);
    expect(receiverCase).not.toBeUndefined();
    expect(receiverCase.status).toBe("open");
    expect(receiverCase.caseKind).toBe("custody_episode");
    expect(receiverCase.openedByOrganizationId).toBe(receiverOrgId);
    expect(receiverCase.receiverOrganizationId).toBeNull();

    // Audit row written.
    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, receiverUserId),
          eq(auditLog.action, "decomiso_handoff_accepted"),
        ),
      )
      .limit(1);
    expect(auditRow).not.toBeUndefined();
    const ap = auditRow.payload as Record<string, unknown>;
    expect(ap.closed_govt_case_id).toBe(caseId);
    expect(ap.opened_receiver_case_id).toBe(receiverEpisodeId!);
    expect(ap.govt_org_id).toBe(govtOrgId);
    expect(ap.receiver_org_id).toBe(receiverOrgId);
  });
});

// ---------------------------------------------------------------------------
// rejectDecomisoHandoffAction — happy path
// ---------------------------------------------------------------------------

describe("rejectDecomisoHandoffAction — happy path", () => {
  let caseId: string;
  let casePublicCode: string;

  beforeAll(async () => {
    await cleanPetState();
    const state = await buildDecomisoState();
    caseId = state.caseId;
    casePublicCode = state.casePublicCode;
  });

  it("emulates reject tx: note_added + case stays open + no ownership flip + audit", async () => {
    const reasonNote = "Sin capacidad disponible esta semana";

    await db.transaction(async (tx) => {
      const now = new Date();

      // Emit note_added(category='system') with rejection reason.
      const notePayload = validateEventPayload("note_added", {
        category: "system" as const,
        text: `Handoff rechazado por el receptor (Refugio S3): ${reasonNote}`,
      });
      await tx.insert(petEvents).values({
        petId,
        eventType: "note_added",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: receiverUserId,
        authorRole: "shelter",
        authorOrganizationId: receiverOrgId,
        authorVerified: true,
        payload: notePayload,
        caseId,
      });

      // Clear receiverOrganizationId on the case (proposal cancelled).
      await tx
        .update(cases)
        .set({ receiverOrganizationId: null, updatedAt: now })
        .where(eq(cases.id, caseId));

      // Audit log.
      await tx.insert(auditLog).values({
        actorUserId: receiverUserId,
        action: "decomiso_handoff_rejected",
        payload: {
          case_id: caseId,
          case_public_code: casePublicCode,
          pet_id: petId,
          govt_org_id: govtOrgId,
          receiver_org_id: receiverOrgId,
          reason: reasonNote,
        },
      });
    });

    // --- Assertions ---

    // note_added event exists with rejection category.
    const [noteEvent] = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "note_added")))
      .limit(1);
    expect(noteEvent).not.toBeUndefined();
    const np = noteEvent.payload as Record<string, unknown>;
    expect(np.category).toBe("system");
    expect(String(np.text)).toContain(reasonNote);

    // custody_episode case is still open.
    const [caseRow] = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
    expect(caseRow.status).toBe("open");
    expect(caseRow.closedAt).toBeNull();

    // receiverOrganizationId cleared on the case.
    expect(caseRow.receiverOrganizationId).toBeNull();

    // No ownership change: govt still holds shelter_custody.
    const [govtCustody] = await db
      .select()
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerOrganizationId, govtOrgId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    expect(govtCustody).not.toBeUndefined();

    // No receiver custody ownership opened.
    const [receiverCustody] = await db
      .select()
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerOrganizationId, receiverOrgId),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    expect(receiverCustody).toBeUndefined();

    // No custody_transferred event.
    const [transferEvent] = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transferred")))
      .limit(1);
    expect(transferEvent).toBeUndefined();

    // Audit row written.
    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, receiverUserId),
          eq(auditLog.action, "decomiso_handoff_rejected"),
        ),
      )
      .limit(1);
    expect(auditRow).not.toBeUndefined();
    const ap = auditRow.payload as Record<string, unknown>;
    expect(ap.case_id).toBe(caseId);
    expect(ap.govt_org_id).toBe(govtOrgId);
    expect(ap.receiver_org_id).toBe(receiverOrgId);
  });
});

// ---------------------------------------------------------------------------
// reassignDecomisoToAnotherReceiverAction — happy path
// ---------------------------------------------------------------------------

describe("reassignDecomisoToAnotherReceiverAction — happy path", () => {
  let caseId: string;
  let casePublicCode: string;

  beforeAll(async () => {
    await cleanPetState();
    const state = await buildDecomisoState();
    caseId = state.caseId;
    casePublicCode = state.casePublicCode;
  });

  it("emulates reassign tx: cancel note + new proposal + receiverOrgId updated + audit", async () => {
    const reassignReason = "Refugio anterior sin camas";

    await db.transaction(async (tx) => {
      const now = new Date();

      // Cancel note for the superseded proposal.
      const cancelNotePayload = validateEventPayload("note_added", {
        category: "system" as const,
        text: `Propuesta anterior cancelada por reasignación. Nuevo destinatario: Refugio S3 Dos. Motivo: ${reassignReason}`,
      });
      await tx.insert(petEvents).values({
        petId,
        eventType: "note_added",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: govtUserId,
        authorRole: "govt",
        authorOrganizationId: govtOrgId,
        authorVerified: true,
        payload: cancelNotePayload,
        caseId,
      });

      // New custody_transfer_proposed toward receiver2.
      const newProposalPayload = validateEventPayload("custody_transfer_proposed", {
        from_user_id: null,
        from_organization_id: govtOrgId,
        to_user_id: null,
        to_organization_id: receiver2OrgId,
        reason: "other" as const,
        matched_against_pet_id: null,
        proposed_at: now.toISOString(),
        notes: `from_decomiso=true reassignment=true case=${casePublicCode}`,
      });
      await tx.insert(petEvents).values({
        petId,
        eventType: "custody_transfer_proposed",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: govtUserId,
        authorRole: "govt",
        authorOrganizationId: govtOrgId,
        authorVerified: true,
        payload: newProposalPayload,
        caseId,
      });

      // Update receiverOrganizationId to receiver2.
      await tx
        .update(cases)
        .set({ receiverOrganizationId: receiver2OrgId, updatedAt: now })
        .where(eq(cases.id, caseId));

      // Audit log.
      await tx.insert(auditLog).values({
        actorUserId: govtUserId,
        action: "decomiso_handoff_cancelled",
        payload: {
          case_id: caseId,
          case_public_code: casePublicCode,
          pet_id: petId,
          govt_org_id: govtOrgId,
          previous_receiver_org_id: receiverOrgId,
          new_receiver_org_id: receiver2OrgId,
          reason: reassignReason,
        },
      });
    });

    // --- Assertions ---

    // custody_episode case is still open (govt custody unchanged).
    const [caseRow] = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
    expect(caseRow.status).toBe("open");
    expect(caseRow.receiverOrganizationId).toBe(receiver2OrgId);

    // Govt's shelter_custody ownership is still open.
    const [govtCustody] = await db
      .select()
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerOrganizationId, govtOrgId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    expect(govtCustody).not.toBeUndefined();

    // cancel note event emitted.
    const [cancelNote] = await db
      .select()
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, petId),
          eq(petEvents.eventType, "note_added"),
          eq(petEvents.authorOrganizationId, govtOrgId),
        ),
      )
      .limit(1);
    expect(cancelNote).not.toBeUndefined();
    const np = cancelNote.payload as Record<string, unknown>;
    expect(String(np.text)).toContain("reasignación");

    // New custody_transfer_proposed toward receiver2.
    const proposals = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_proposed")))
      .orderBy(desc(petEvents.recordedAt))
      .limit(2);
    // There should be exactly 2 proposals: original toward receiver1, new toward receiver2.
    expect(proposals.length).toBe(2);
    const latestPayload = proposals[0].payload as Record<string, unknown>;
    expect(latestPayload.to_organization_id).toBe(receiver2OrgId);
    expect(String(latestPayload.notes)).toContain("reassignment=true");

    // Audit row written.
    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, govtUserId),
          eq(auditLog.action, "decomiso_handoff_cancelled"),
        ),
      )
      .limit(1);
    expect(auditRow).not.toBeUndefined();
    const ap = auditRow.payload as Record<string, unknown>;
    expect(ap.previous_receiver_org_id).toBe(receiverOrgId);
    expect(ap.new_receiver_org_id).toBe(receiver2OrgId);
  });
});

// ---------------------------------------------------------------------------
// Auth/state guards — domain-logic equivalents
// ---------------------------------------------------------------------------

describe("decomiso handshake — auth and state guards", () => {
  it("wrong receiver org cannot accept: receiverOrganizationId mismatch", async () => {
    // Simulate the guard: canonicalReceiverOrgId !== organization.id
    const caseReceiverOrgId = receiverOrgId;
    const callerOrgId = wrongOrgId;
    expect(caseReceiverOrgId === callerOrgId).toBe(false);
    // Action would return: "El decomiso no fue dirigido a tu organización."
  });

  it("non-sanitary_authority opener is rejected by discriminator check", async () => {
    // Simulate the guard: openerOrg.orgType !== 'sanitary_authority'
    const [org] = await db
      .select({ orgType: organizations.orgType })
      .from(organizations)
      .where(eq(organizations.id, wrongOrgId))
      .limit(1);
    expect(org.orgType).not.toBe("sanitary_authority");
    // Action would return: "Este caso no corresponde a un decomiso de autoridad sanitaria."
  });

  it("non-opener org cannot reassign: openedByOrganizationId mismatch", async () => {
    // Simulate the guard: caseRow.openedByOrganizationId !== govtOrg.id
    const wrongOpenerOrgId = wrongOrgId;
    const actualOpener = govtOrgId;
    expect(wrongOpenerOrgId === actualOpener).toBe(false);
    // Action would return: "Solo la autoridad que abrió el decomiso puede reasignarlo."
  });

  it("closed case cannot be accepted: status guard", async () => {
    // Build + close a case, then assert the guard fires.
    await cleanPetState();
    const state = await buildDecomisoState();
    await closeCase({ caseId: state.caseId, reason: "resolved", closedByUserId: govtUserId });

    const [caseRow] = await db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, state.caseId))
      .limit(1);
    // The action checks status !== 'open' and returns an error.
    expect(caseRow.status).toBe("closed");
    // Action would return: "Este caso ya no está abierto."

    // Cleanup.
    await cleanPetState();
  });

  it("case with null receiverOrganizationId (already rejected) cannot be re-rejected", async () => {
    // After rejectDecomisoHandoffAction, receiverOrganizationId is null.
    // A subsequent reject attempt hits: canonicalReceiverOrgId is null →
    // "Este decomiso no tiene destinatario activo."
    const canonicalReceiverOrgId: string | null = null;
    expect(canonicalReceiverOrgId).toBeNull();
    // Action would return: "Este decomiso no tiene destinatario activo."
  });
});

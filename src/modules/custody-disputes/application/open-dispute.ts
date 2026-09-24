// Use-case: openDisputeFromEvent
//
// Internal helper — called from the action that emits `custody_dispute_raised`.
// Inserts the dispute row, the initial parties, audit_log entry, and flips
// pets.in_custody_dispute = true. Caller must already have validated the
// raising event and pass it explicitly so the FK lands cleanly.
//
// Sequencing contract (ARCH-E): the caller MUST pre-create the case via
// openCase before inserting the raising pet_event, then pass the resulting
// caseId here. This ensures the raising event row carries case_id in the
// same transaction (pet_events.case_id is append-only — no post-insert update
// is possible without the GUC escape hatch). openDisputeFromEvent then updates
// the case row with custodyDisputeId once the dispute row exists.

import { and, eq } from "drizzle-orm";

import {
  type DisputePartyRole,
  auditLog,
  cases,
  custodyDisputeParties,
  custodyDisputes,
  type db,
  disputeHoldsCustodyLock,
  pets,
} from "@/db";
import { generatePrefixedToken } from "@/lib/infra/publicToken";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function openDisputeFromEvent(
  tx: Tx,
  input: {
    petId: string;
    raisingEventId: string;
    raisedByUserId: string;
    raisedByOrgId?: string | null;
    raisedByRole: "owner" | "org" | "govt" | "admin";
    jurisdictionProvince: string;
    jurisdictionLocality: string;
    initialParties: {
      userId?: string | null;
      orgId?: string | null;
      role: DisputePartyRole;
      positionSummary?: string | null;
    }[];
    /**
     * Pre-created case id. The case MUST be opened BEFORE the raising event
     * is inserted (see sequencing contract above); openDisputeFromEvent links
     * the dispute row to this existing case instead of opening a new one.
     */
    preCreatedCaseId: string;
  },
): Promise<{ disputeId: string; publicToken: string }> {
  // Guard: no two IN-DISPUTE disputes per pet (enforced by the partial unique
  // index too, but we want a clean error rather than a constraint violation).
  // An ESCALATED dispute still occupies the slot — PO decision 2A, 2026-09-22.
  const [existing] = await tx
    .select({ id: custodyDisputes.id })
    .from(custodyDisputes)
    .where(and(eq(custodyDisputes.petId, input.petId), disputeHoldsCustodyLock()))
    .limit(1);
  if (existing) {
    throw new Error("Ya hay una disputa de custodia en curso para esta mascota.");
  }

  const publicToken = generatePrefixedToken("DIS");
  const [dispute] = await tx
    .insert(custodyDisputes)
    .values({
      publicToken,
      petId: input.petId,
      raisedByUserId: input.raisedByUserId,
      raisedByOrgId: input.raisedByOrgId ?? null,
      raisedByRole: input.raisedByRole,
      raisingEventId: input.raisingEventId,
      jurisdictionProvince: input.jurisdictionProvince,
      jurisdictionLocality: input.jurisdictionLocality,
    })
    .returning({ id: custodyDisputes.id });

  for (const p of input.initialParties) {
    await tx.insert(custodyDisputeParties).values({
      disputeId: dispute.id,
      partyUserId: p.userId ?? null,
      partyOrganizationId: p.orgId ?? null,
      partyRole: p.role,
      partyPositionSummary: p.positionSummary ?? null,
      addedByUserId: input.raisedByUserId,
    });
  }

  await tx
    .update(pets)
    .set({ inCustodyDispute: true, updatedAt: new Date() })
    .where(eq(pets.id, input.petId));

  // Link the now-known dispute id back to the pre-created case row. A zero-row
  // update would leave the case permanently unlinked (resolveDisputeAction
  // could never close it), so fail the transaction instead of continuing.
  const [linkedCase] = await tx
    .update(cases)
    .set({ custodyDisputeId: dispute.id, updatedAt: new Date() })
    .where(eq(cases.id, input.preCreatedCaseId))
    .returning({ id: cases.id });
  if (!linkedCase) {
    throw new Error(`Pre-created case ${input.preCreatedCaseId} not found while opening dispute.`);
  }

  await tx.insert(auditLog).values({
    actorUserId: input.raisedByUserId,
    action: "dispute_raised",
    payload: {
      dispute_id: dispute.id,
      pet_id: input.petId,
      raising_event_id: input.raisingEventId,
      raised_by_role: input.raisedByRole,
    },
  });

  return { disputeId: dispute.id, publicToken };
}

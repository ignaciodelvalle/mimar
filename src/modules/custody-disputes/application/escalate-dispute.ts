// Use-case: escalateDisputeUseCase
//
// Moves a live custody dispute to the judicial channel: flips
// custody_disputes.status to 'escalated', appends a `note_added` pet event that
// records the reason on the pet's custody timeline, and writes the
// `dispute_escalated` audit_log entry.
//
// THE STATUS FLIP DOES NOT RELEASE THE CUSTODY LOCK (PO decision 2A,
// 2026-09-22). This use-case deliberately does NOT touch pets.in_custody_dispute
// and does NOT close the linked case: escalation is a change of CHANNEL, not an
// outcome. Every reader was moved onto IN_DISPUTE_STATUSES / the
// disputeHoldsCustodyLock() predicate BEFORE this writer landed, so 'escalated'
// still blocks transfers and adoption finalize, still bars a second dispute on
// the pet, and still lists for the arbiter and the authority. Writing the status
// while any reader still keyed on the bare literal 'open' would have silently
// unlocked the pet — that is what scripts/check-dispute-lock-predicate.ts fences.
//
// Who can escalate: admin, or a govt agent whose jurisdiction covers the
// dispute. A reason of at least 20 characters is required and is recorded in
// both the note and the audit entry.
//
// Escalation is TERMINAL-ADJACENT, not terminal: the dispute stays resolvable
// and withdrawable from 'escalated' (see resolve-dispute.ts / withdraw-dispute.ts),
// and resolving it releases the lock exactly like resolving an open one.
//
// NOT IN SCOPE: the automatic first-response-deadline escalation (contract
// A09-4, notices at 30 and 60 days). No cron writes this status; the 365-day
// `escalate-stale-disputes` job moves the linked `cases` row only, and wiring it
// onto the dispute row is a separate item with its own notification contract.

import { and, eq } from "drizzle-orm";

import {
  auditLog,
  cases,
  custodyDisputes,
  db,
  disputeHoldsCustodyLock,
  isInDisputeStatus,
  petEvents,
} from "@/db";
import type { CustodyDispute } from "@/db";
import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";
import { validateEventPayload } from "@/lib/events/event-schemas";

import type { EscalateDisputeInput, EscalateDisputeResult } from "../domain/types";

type Session = {
  user: { id: string };
  profile: { role: string };
  jurisdictions: { province: string; locality: string }[];
};

function isGovtInScope(
  jurisdictions: { province: string; locality: string }[],
  dispute: Pick<CustodyDispute, "jurisdictionProvince" | "jurisdictionLocality">,
): boolean {
  // Subsumption-aware: a whole-province assignment (e.g. whole-CABA) governs
  // every barrio in it; barrio assignments stay exact (never widens security).
  return jurisdictionScopeContains(
    jurisdictions,
    dispute.jurisdictionProvince,
    dispute.jurisdictionLocality,
  );
}

export async function escalateDisputeUseCase(
  session: Session,
  input: EscalateDisputeInput,
): Promise<EscalateDisputeResult> {
  const text = input.notes.trim();
  if (text.length < 20) {
    return { error: "El motivo de la escalada tiene que tener al menos 20 caracteres." };
  }

  try {
    const escalatedAt = await db.transaction(async (tx): Promise<Date> => {
      const [dispute] = await tx
        .select()
        .from(custodyDisputes)
        .where(eq(custodyDisputes.publicToken, input.disputeToken))
        .limit(1);
      if (!dispute) throw new Error("Disputa no encontrada.");
      if (!isInDisputeStatus(dispute.status)) {
        throw new Error("Solo se pueden escalar disputas en curso.");
      }
      if (dispute.status === "escalated") {
        throw new Error("La disputa ya está escalada a la vía judicial.");
      }

      if (session.profile.role === "govt" && !isGovtInScope(session.jurisdictions, dispute)) {
        throw new Error("Esta disputa está fuera de tu jurisdicción.");
      }

      const now = new Date();

      // THE WRITE COMES FIRST, AND IT IS ITS OWN ANTI-RACE.
      //
      // The SELECT above is unlocked on purpose: taking FOR UPDATE here would
      // add a lock edge on custody_disputes that only resolveDisputeUseCase
      // holds today (see src/modules/rehome/README.md's ordering table), and
      // this use-case needs no such edge. Instead the guard is re-applied
      // inside the UPDATE's own WHERE, under the row lock the UPDATE takes:
      // a concurrent resolve/withdraw that committed between the read and here
      // leaves this matching ZERO rows, and we abort before writing a note
      // about an escalation that did not happen. Same pattern as
      // escalate-stale-disputes.
      //
      // `status: "escalated"` and NOTHING else — no resolver columns (the
      // custody_disputes_resolution_consistent CHECK refuses an escalated row
      // that carries one), no touch of pets.in_custody_dispute, no closeCase.
      const escalated = await tx
        .update(custodyDisputes)
        .set({ status: "escalated", updatedAt: now })
        .where(and(eq(custodyDisputes.id, dispute.id), disputeHoldsCustodyLock()))
        .returning({ id: custodyDisputes.id });
      if (escalated.length === 0) {
        throw new Error("La disputa dejó de estar en curso. Volvé a cargar la página.");
      }

      // Find the linked case (for caseId on the pet event).
      const [linkedCase] = await tx
        .select({ id: cases.id })
        .from(cases)
        .where(eq(cases.custodyDisputeId, dispute.id))
        .limit(1);

      const notePayload = validateEventPayload("note_added", {
        category: "otro",
        text: `[Escalada vía judicial] ${text}`,
      });

      await tx.insert(petEvents).values({
        petId: dispute.petId,
        eventType: "note_added",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: session.user.id,
        // NOT a bug, and not a free choice: the `author_role` pgEnum has seven
        // values and 'admin' is not among them, so an admin escalation written
        // as its true role would be refused by the database. Admin and govt both
        // map to 'govt' for AUTHORSHIP, exactly as resolve-dispute.ts does and
        // documents. The acting role is preserved in the audit_log payload
        // below (actor_role) — and 0240 keys erasure redaction on THIS column,
        // where 'govt' is the honest answer for both: an institutional act that
        // outlives the person who performed it.
        authorRole: "govt",
        authorOrganizationId: null,
        authorVerified: true,
        payload: notePayload,
        caseId: linkedCase?.id ?? null,
      });

      await tx.insert(auditLog).values({
        actorUserId: session.user.id,
        action: "dispute_escalated",
        payload: {
          dispute_id: dispute.id,
          // The REAL role of whoever escalated. The pet_events row above cannot
          // carry it (see the authorRole comment there), and note_added's
          // payload is .strict() — so until a `custody_dispute_escalated` event
          // type exists, this is the only place an admin escalation is
          // distinguishable from a govt one. Mirrors resolved_by_role, which
          // resolve-dispute.ts puts in its own event payload.
          actor_role: session.profile.role,
          notes_excerpt: text.slice(0, 200),
        },
      });

      return now;
    });

    return { escalatedAt };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Error desconocido." };
  }
}

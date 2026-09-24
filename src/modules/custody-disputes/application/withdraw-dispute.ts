// Use-case: withdrawDisputeUseCase
//
// Admin or the raiser cancels an open custody dispute.
//
// Steps:
//   1. Load and validate dispute (open, caller authorized).
//   2. Update custody_disputes row to withdrawn.
//   3. Clear pets.in_custody_dispute.
//   4. Close the linked case as cancelled.
//   5. Insert audit_log entry.

import { eq } from "drizzle-orm";

import { auditLog, cases, custodyDisputes, db, isInDisputeStatus, pets } from "@/db";
import { closeCase } from "@/lib/infra/case-helpers";

import type { WithdrawDisputeInput, WithdrawDisputeResult } from "../domain/types";

type Session = {
  user: { id: string };
  profile: { role: string };
};

export async function withdrawDisputeUseCase(
  session: Session,
  input: WithdrawDisputeInput,
): Promise<WithdrawDisputeResult> {
  try {
    const withdrawnAt = await db.transaction(async (tx): Promise<Date> => {
      const [dispute] = await tx
        .select()
        .from(custodyDisputes)
        .where(eq(custodyDisputes.publicToken, input.disputeToken))
        .limit(1)
        // FOR UPDATE, added 2026-08-10. Its twin resolve-dispute.ts took this
        // lock and wrote down why (TR-M1); this one read the row unlocked and
        // then wrote over it. Under READ COMMITTED that is a lost update, and
        // the state it loses is titularidad: an admin resolves with
        // `ownership_transferred` — closing the ownerships, emitting
        // custody_transferred, opening the new one — while the govt who raised
        // the dispute reads status='open' from the older snapshot. The UPDATE
        // blocks until the admin commits, then overwrites: status='withdrawn',
        // resolutionSummary replaced by the withdrawal reason. The transfer is
        // already committed and is NOT undone. The file ends up saying
        // "Retirada — sin resolución" about an animal that changed hands, with
        // resolution='ownership_transferred' and a resolutionEventId hanging off
        // an event the status denies. closeCase being idempotent makes it worse,
        // not better: the `cases` row stays closed/resolved and the two rows of
        // one file contradict each other.
        .for("update");
      if (!dispute) throw new Error("Disputa no encontrada.");
      // Open AND escalated are both withdrawable (PO decision 2A, 2026-09-22);
      // withdrawing either releases the lock.
      if (!isInDisputeStatus(dispute.status)) throw new Error("La disputa ya no está en curso.");

      // Admins can withdraw anything; govts can only withdraw what they
      // raised. Out-of-scope govt is implicitly blocked by the raiser check
      // because they wouldn't be the raiser anyway.
      if (session.profile.role === "govt" && dispute.raisedByUserId !== session.user.id) {
        throw new Error("Solo un admin o quien la levantó puede retirarla.");
      }

      const now = new Date();
      await tx
        .update(custodyDisputes)
        .set({
          status: "withdrawn",
          resolvedByUserId: session.user.id,
          resolvedAt: now,
          resolutionSummary: input.reason?.trim() || null,
          updatedAt: now,
        })
        .where(eq(custodyDisputes.id, dispute.id));

      await tx
        .update(pets)
        .set({ inCustodyDispute: false, updatedAt: now })
        .where(eq(pets.id, dispute.petId));

      // Cases system (Fase D4): close the linked case as `cancelled`.
      // Withdrawal isn't a real determination — the case is set aside.
      const [linkedCase] = await tx
        .select({ id: cases.id })
        .from(cases)
        .where(eq(cases.custodyDisputeId, dispute.id))
        .limit(1);
      if (linkedCase) {
        await closeCase(
          { caseId: linkedCase.id, reason: "cancelled", closedByUserId: session.user.id },
          tx,
        );
      }

      await tx.insert(auditLog).values({
        actorUserId: session.user.id,
        action: "dispute_withdrawn",
        payload: {
          dispute_id: dispute.id,
          withdrawn_by_user_id: session.user.id,
          reason: input.reason ?? null,
        },
      });

      return now;
    });

    return { withdrawnAt };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Error desconocido." };
  }
}

// block-slot.ts — org-side slot blocking use-case (strangler 28/61).
// Moved verbatim from app/actions/slot-materialization.ts.
// Auth guards (requireOrgAccessByToken + getGrantedCapabilities + capability
// check) are lifted to the shim; organizationId is pre-resolved by the shim.

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db, serviceOfferings, timeSlots } from "@/db";

import type { BlockSlotResult } from "./types";

/**
 * Blocks an empty open slot so it can no longer be booked.
 *
 * The shim enforces requireOrgAccessByToken + appointment.manage before calling
 * here and passes organizationId so the transaction can verify slot ownership.
 *
 * Safety: acquires the same advisory lock used by bookSlotAction, re-reads
 * the slot inside the transaction, and only proceeds when bookings_count === 0
 * and status is "open".
 */
export async function blockSlot(input: {
  orgToken: string;
  slotId: string;
  organizationId: string;
}): Promise<BlockSlotResult> {
  const { orgToken, slotId, organizationId } = input;

  try {
    await db.transaction(async (tx) => {
      // Advisory lock — same key strategy as bookSlotAction.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${slotId}))`);

      const [slot] = await tx
        .select({
          id: timeSlots.id,
          bookingsCount: timeSlots.bookingsCount,
          status: timeSlots.status,
          serviceOfferingId: timeSlots.serviceOfferingId,
        })
        .from(timeSlots)
        .where(eq(timeSlots.id, slotId))
        .limit(1);

      if (!slot) throw new Error("El cupo no existe.");
      if (slot.status === "cancelled") throw new Error("El cupo ya estaba bloqueado.");
      // Schema allows 'open' | 'full' | 'cancelled' — only open slots are
      // blockable, even if a future writer starts persisting 'full'.
      if (slot.status !== "open") throw new Error("Solo se pueden bloquear cupos abiertos.");
      if (slot.bookingsCount > 0) {
        throw new Error("No podés bloquear un cupo con reservas confirmadas.");
      }

      // Verify the slot belongs to this org's offerings.
      const [offering] = await tx
        .select({ id: serviceOfferings.id })
        .from(serviceOfferings)
        .where(
          and(
            eq(serviceOfferings.id, slot.serviceOfferingId),
            eq(serviceOfferings.organizationId, organizationId),
          ),
        )
        .limit(1);

      if (!offering) throw new Error("El cupo no pertenece a esta organización.");

      await tx
        .update(timeSlots)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(timeSlots.id, slotId));
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Error al bloquear el cupo." };
  }

  revalidatePath(`/org/${orgToken}/agenda`);
  return { ok: true };
}

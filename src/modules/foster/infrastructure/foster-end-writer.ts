// The atomic end of a foster, in one transaction.
//
// WHY IT LEFT foster-repository.ts (2026-08-23)
// ---------------------------------------------------------------------------
// Exactly the reason `foster-convert-to-owner-writer.ts` left, two days
// earlier: that file lives on a size ratchet, and the M-8 fix (the pet advisory
// lock + a CHECKED re-read under it, on both writers that CLOSE a foster) grew
// this method past it. The repository's own header for the convert writer says
// the remedy — extract the largest thing, delegate from the repository — so the
// two closers now sit side by side as named writers.
//
// WHY A SIBLING AND NOT lib/infra/ OR ANOTHER MODULE
// ---------------------------------------------------------------------------
// It writes `foster_ended`, a titular-only event type.
// `scripts/check-titular-gate.ts` scans `src/modules/**/infrastructure/**`, so a
// writer moved to `lib/infra/` would vanish from the guard that exists to catch
// an ungated writer. And the flow is foster-owned, so anywhere under another
// module would add a cross-module edge `check-dependency-direction.ts` does not
// allow.
//
// VERBATIM MOVE. Same statements, same order, same comments.

import { and, eq, isNull, sql } from "drizzle-orm";

import { type db, fosterVolunteers, ownerships, petEvents } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { closeCase, findOpenCaseForPetAndKind } from "@/lib/infra/case-helpers";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Atomic: end foster ownership + emit foster_ended event + close
 * foster_placement case + optionally read volunteer slots for re-enroll
 * prompt logic. Returns the caseId (or null) and the volunteer slot count.
 */
export async function insertEndFoster(
  args: {
    petId: string;
    petName: string;
    fosterOwnershipId: string;
    fosterUserId: string;
    reason: string;
    closedReason: "resolved" | "cancelled";
    notes: string | null;
    actorUserId: string;
    actorOrgId: string;
    actorOrgVerified: boolean;
    now: Date;
  },
  tx: Tx,
): Promise<{ caseId: string | null; volunteerAvailableSlots: number | null }> {
  // THE PET ADVISORY LOCK, FIRST (M-8) — the same lock `insertAssignFoster`
  // takes to OPEN a foster, now taken by BOTH writers that close one. An
  // advisory lock excludes only other TAKERS, so locking the convert writer
  // alone would leave it unserialised against this one.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${args.petId}))`);

  // RE-READ AND CHECKED under the lock, never a blind UPDATE by id. The
  // use-case's `findActiveFosterRows` runs OUTSIDE the transaction; the old
  // statement had no `ended_at IS NULL` and DISCARDED its row count, so an
  // adoption finalize or a cross-org accept that closed this row first left
  // this writer emitting `foster_ended` over an arrangement that had already
  // ended for another reason — two endings for one foster, in an append-only
  // spine. Shape copied from `finalize-adoption.ts` (`lockLiveCustodyRow` +
  // `if (!locked)`).
  const [lockedFoster] = await tx
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(and(eq(ownerships.id, args.fosterOwnershipId), isNull(ownerships.endedAt)))
    .limit(1)
    .for("update");
  if (!lockedFoster) {
    throw new Error("Este tránsito ya no está activo. Actualizá la página y volvé a intentar.");
  }
  await tx
    .update(ownerships)
    .set({ endedAt: args.now })
    .where(eq(ownerships.id, args.fosterOwnershipId));

  // Resolve open foster_placement case via case-helpers.
  const caseRow = await findOpenCaseForPetAndKind(args.petId, "foster_placement", tx);
  const caseId = caseRow?.id ?? null;

  const payload = validateEventPayload("foster_ended", {
    foster_user_id: args.fosterUserId,
    reason: args.reason,
    notes: args.notes,
  });
  await tx.insert(petEvents).values({
    petId: args.petId,
    eventType: "foster_ended",
    occurredAt: args.now,
    recordedAt: args.now,
    recordedByUserId: args.actorUserId,
    authorRole: "shelter",
    authorOrganizationId: args.actorOrgId,
    authorVerified: args.actorOrgVerified,
    payload,
    caseId,
  });

  if (caseId) {
    await closeCase({ caseId, reason: args.closedReason, closedByUserId: args.actorUserId }, tx);
  }

  // Read volunteer slots INSIDE tx for re-enroll prompt (spec R2).
  const [volunteer] = await tx
    .select({ availableSlots: fosterVolunteers.availableSlots })
    .from(fosterVolunteers)
    .where(eq(fosterVolunteers.userId, args.fosterUserId))
    .limit(1);

  return { caseId, volunteerAvailableSlots: volunteer?.availableSlots ?? null };
}

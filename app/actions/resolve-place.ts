"use server";

// resolve-place.ts — the unresolved-place queue's action. Platform-admin only:
// the guard here is the request gate and the writer re-checks the capability
// inside its transaction (requirePlatformAdmin), so the actor id is bound from
// the session, never taken from the caller. Inventory pinned by
// scripts/check-admin-authority.ts.

import { db } from "@/db";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import {
  notifyNewlyCoveringAuthorities,
  retargetPendingOutbox,
} from "@/lib/place/resolution-rerouting";
import { type QueueSubjectTable, resolvePlaceFromQueue } from "@/lib/place/unresolved-queue";

export async function resolvePlaceFromQueueAction(input: {
  subjectTable: QueueSubjectTable;
  subjectId: string;
  localityId: string;
  reason: string;
}) {
  const { user } = await requireAdminOrRedirect();
  const actorUserId = user.id;
  const result = await resolvePlaceFromQueue(db, actorUserId, input);
  if ("ok" in result) {
    // After the commit, best effort: pending outbox rows snapshotted while the
    // place was unresolved take the resolved row (W7), and an OPEN case whose
    // place is now known reaches the unit that governs it (D9). Neither ever
    // un-notifies anyone.
    try {
      await retargetPendingOutbox(db, input);
      await notifyNewlyCoveringAuthorities(db, input);
    } catch (err) {
      console.error("[place-queue] re-routing after resolution failed", err);
    }
    // No revalidatePath on the queue page, deliberately: the form lives ON
    // that page and the caller leaves it by a full document navigation (N3).
    // Revalidating it re-renders the page inside the action response while the
    // row the form belongs to has just left the queue, so the client flashed
    // the segment error boundary before the navigation landed. The page is
    // force-dynamic, so the navigation reads fresh data anyway.
  }
  return result;
}

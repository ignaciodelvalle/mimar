"use server";

// Server action for the "Novedades" operator-orientation feed (viz-suite Wave 1).
//
// markNovedadesSeenAction advances the current operator's feed watermark to now,
// so the feed clears until new events are recorded. This is the ONLY thing that
// moves the watermark — the feed never auto-advances on render (a refresh must
// not clear it). Per-user UI state; the append-only pet_events log is untouched.
//
// Watermark UX is the PO-flagged default (viz-suite verification contract):
// explicit "Marcar como visto" only. Modeled on the small admin/libro action
// shape; gated by requireAdminOrGovtOrRedirect (the SAME guard both operator
// homes use), so a deactivated / non-institutional actor cannot advance it.

import { revalidatePath } from "next/cache";

import { db, operatorFeedWatermarks } from "@/db";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";

export async function markNovedadesSeenAction(): Promise<void> {
  const { user } = await requireAdminOrGovtOrRedirect();
  // Self-scoped write: the row key is the session actor's id — never
  // caller-supplied — so the action can only move its OWN watermark.
  const actorUserId = user.id;
  const now = new Date();

  // Upsert: insert on first mark, advance on every subsequent one. user_id is
  // the PK (one row per operator). user.id === profiles.id (the FK target).
  await db
    .insert(operatorFeedWatermarks)
    .values({ userId: actorUserId, lastSeenRecordedAt: now })
    .onConflictDoUpdate({
      target: operatorFeedWatermarks.userId,
      set: { lastSeenRecordedAt: now, updatedAt: now },
    });

  // The card renders on both operator homes; revalidate both so the feed clears
  // wherever the operator pressed the button.
  revalidatePath("/gob");
  revalidatePath("/admin");
}

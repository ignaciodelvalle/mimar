// Use-case: logLibretaShareViewForToken — strangler migration 32/61.
//
// Token-based writer (no userId): validates the share token, then bumps the
// cached view counter on the token row. No Next.js request context.
//
// Per-view telemetry (viewer_ip_hash + user_agent in `share_telemetry`) was
// removed in migration 0167 — PO decision TEL-1, 2026-08-04: the table had no
// reader, so it was collection without a purpose. What the owner actually sees
// is view_count_cached / last_viewed_at_cached, which live here on the token
// row and are all this use case maintains now.
//
// The outer shim (app/actions/libreta-share.ts) delegates without auth —
// the share token itself is the credential.

import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { db, libretaShareTokens } from "@/db";

export async function logLibretaShareViewForToken(input: {
  shareToken: string;
}): Promise<void> {
  const [row] = await db
    .select({
      id: libretaShareTokens.id,
      petId: libretaShareTokens.petId,
      revokedAt: libretaShareTokens.revokedAt,
      expiresAt: libretaShareTokens.expiresAt,
    })
    .from(libretaShareTokens)
    .where(eq(libretaShareTokens.shareToken, input.shareToken))
    .limit(1);
  if (!row) return;
  if (row.revokedAt !== null) return;
  if (row.expiresAt !== null && row.expiresAt < new Date()) return;

  const now = new Date();

  await db
    .update(libretaShareTokens)
    .set({
      viewCountCached: sql`${libretaShareTokens.viewCountCached} + 1`,
      lastViewedAtCached: now,
    })
    .where(eq(libretaShareTokens.id, row.id));
}

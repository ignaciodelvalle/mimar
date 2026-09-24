"use server";

// Server actions for /admin/libro (WS-L — Libro de eventos).
//
// fetchEventAmendmentChainAction returns the full event_amended chain for a
// single original event, for the expandable row in the read-only ledger. It is
// admin-only (universal scope) and writes NO data — pure projection.
//
// The chain is the auditable "ajá" moment: corrections are NEW events that
// reference the original; the original is never edited. We return every
// amendment (oldest → newest) so the UI can show the full correction history
// above the preserved original.

import { asc, sql } from "drizzle-orm";

import { db, petEvents } from "@/db";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";

export type AmendmentChainEntry = {
  id: string;
  occurredAt: string; // ISO
  recordedAt: string; // ISO
  actorRole: string;
  reason: string | null;
  changes: Array<{ field: string; old: unknown; new: unknown }>;
};

export type AmendmentChainResult =
  | { ok: true; chain: AmendmentChainEntry[] }
  | { ok: false; error: string };

/**
 * Returns the event_amended chain (oldest → newest) that targets `originalEventId`.
 * Admin-only. Empty chain is a valid result (ok: true, chain: []).
 */
export async function fetchEventAmendmentChainAction(
  originalEventId: string,
): Promise<AmendmentChainResult> {
  // Admin-only universal scope (rejects deactivated / non-institutional).
  await requireAdminOrRedirect();

  if (!originalEventId || typeof originalEventId !== "string") {
    return { ok: false, error: "Identificador de evento inválido." };
  }

  const rows = await db
    .select({
      id: petEvents.id,
      occurredAt: petEvents.occurredAt,
      recordedAt: petEvents.recordedAt,
      payload: petEvents.payload,
    })
    .from(petEvents)
    .where(
      sql`${petEvents.eventType} = 'event_amended' AND ${petEvents.payload}->>'target_event_id' = ${originalEventId}`,
    )
    .orderBy(asc(petEvents.occurredAt), asc(petEvents.id));

  const chain: AmendmentChainEntry[] = rows.map((r) => {
    const p = r.payload as Record<string, unknown>;
    return {
      id: r.id,
      occurredAt: r.occurredAt.toISOString(),
      recordedAt: r.recordedAt.toISOString(),
      actorRole: typeof p.actor_role === "string" ? p.actor_role : "owner",
      reason: typeof p.reason === "string" ? p.reason : null,
      changes: Array.isArray(p.changes)
        ? (p.changes as Array<{ field: string; old: unknown; new: unknown }>)
        : [],
    };
  });

  return { ok: true, chain };
}

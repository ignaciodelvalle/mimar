// Use-case: close stale lost_pet_episode cases (inactive >60d AND open >365d).
//
// Migrated from lib/case-closers/close-stale-lost-episodes.ts.
// The lib file becomes a thin re-export shim (strangler pattern).
//
// pet-document-redesign ADR-18: staleAfterDays raised 180 -> 365 so a lost
// pet can never silently expire in under a year. The 60-day inactivity
// guard is an ADDITIONAL AND-condition (both must hold), so the effective
// minimum age before any auto-close is >= 1 year.
//
// Scan: lost_pet_episode cases with status='open', opened_at < now-365d,
// AND no pet_events attached in the last 60 days.
// Process: in ONE tx — UPDATE status='closed', closed_reason='auto_expired'
// (guarded AND status='open'); if 0 rows → return (anti-race); if
// primaryPetId then insert note_added(category=system, Spanish copy).
//
// Auth: none (system-initiated cron). No user authz inside.

import { and, asc, eq, gt, lt, sql } from "drizzle-orm";

import { cases, db, petEvents } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";

export interface CloseStaleLostEpisodesOptions {
  now?: Date;
  /** Days a case must have been open before becoming eligible. Default 365 (ADR-18). */
  staleAfterDays?: number;
  /** Days of inactivity required to consider a case stale. Default 60. */
  inactivityDays?: number;
  /** Keyset cursor: only return cases whose id sorts after this value. */
  afterId?: string | null;
  /** Max rows to return (keyset page size). Omit for no limit. */
  limit?: number;
}

export interface CloseStaleLostEpisodesCandidate {
  id: string;
  primaryPetId: string | null;
  publicCode: string;
}

export async function findStaleLostEpisodes(
  options?: CloseStaleLostEpisodesOptions,
): Promise<CloseStaleLostEpisodesCandidate[]> {
  const now = options?.now ?? new Date();
  const staleAfterMs = (options?.staleAfterDays ?? 365) * 24 * 60 * 60 * 1000;
  const inactivityMs = (options?.inactivityDays ?? 60) * 24 * 60 * 60 * 1000;
  const openedBefore = new Date(now.getTime() - staleAfterMs);
  const inactiveSince = new Date(now.getTime() - inactivityMs);

  const inactiveSinceIso = inactiveSince.toISOString();
  const base = db
    .select({
      id: cases.id,
      primaryPetId: cases.primaryPetId,
      publicCode: cases.publicCode,
    })
    .from(cases)
    .where(
      and(
        eq(cases.caseKind, "lost_pet_episode"),
        eq(cases.status, "open"),
        lt(cases.openedAt, openedBefore),
        ...(options?.afterId ? [gt(cases.id, options.afterId)] : []),
        sql`NOT EXISTS (
          SELECT 1 FROM ${petEvents}
          WHERE ${petEvents.caseId} = ${cases.id}
            AND ${petEvents.occurredAt} >= ${inactiveSinceIso}::timestamptz
        )`,
      ),
    )
    .orderBy(asc(cases.id));

  const rows = options?.limit ? await base.limit(options.limit) : await base;

  return rows;
}

export async function closeStaleLostEpisode(
  candidate: CloseStaleLostEpisodesCandidate,
  options?: { now?: Date },
): Promise<void> {
  const now = options?.now ?? new Date();

  await db.transaction(async (tx) => {
    // Anti-race: only close if still open.
    const updated = await tx
      .update(cases)
      .set({
        status: "closed",
        closedReason: "auto_expired",
        closedAt: now,
        updatedAt: now,
      })
      .where(and(eq(cases.id, candidate.id), eq(cases.status, "open")))
      .returning({ id: cases.id });
    if (updated.length === 0) return;

    if (candidate.primaryPetId) {
      const payload = validateEventPayload("note_added", {
        category: "system",
        text: "Caso cerrado automáticamente por inactividad. La mascota sigue marcada perdida; el dueño puede reactivar reportándola encontrada o marcándola nuevamente como perdida.",
      });
      await tx.insert(petEvents).values({
        petId: candidate.primaryPetId,
        eventType: "note_added",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: null,
        authorRole: "system",
        authorOrganizationId: null,
        authorVerified: false,
        payload,
        caseId: candidate.id,
      });
    }
  });
}

// Notification ↔ state reconciliation (projection-time, read-only).
//
// Some owner notifications are "act now, your pet is out there" signals that
// only make sense while the related pet is actively `lost`. Once the owner
// marks the pet found (pets.status → 'active') or the pet is recorded deceased,
// those alerts are stale: showing "Avistaje de Panchita — URGENTE" for a pet
// already home erodes trust (PO QA §2, 2026-07-05).
//
// We reconcile at READ time rather than mutating stored rows — events and their
// derived notifications stay append-only (invariant #2). The same rule is
// expressed twice, both derived from LOST_ACTIVE_NOTIFICATION_TYPES so they
// cannot drift on the type set:
//   - `isResolvedLostEpisodeNotification` — pure predicate, unit-tested, the
//     documented contract.
//   - `excludeResolvedLostEpisodeSql` — a Drizzle `sql` fragment composed into
//     every owner-inbox WHERE so the list, the tab counts, and the unread count
//     all reconcile against current pet state consistently.

import { notifications } from "@/db";
import { sql } from "drizzle-orm";

// NOTE: `ownerships` is referenced by raw table name inside
// excludeStaleWelcomeSql's correlated EXISTS (same pattern as `pets rp`
// below) so the fragment composes into both query-builder and raw SQL uses.

/**
 * Notification types that are only meaningful while the related pet is `lost`.
 * A sighting report, a zone broadcast, and a stranger-in-possession alert all
 * become moot the moment the pet is no longer lost.
 *
 * The recovery notices (`lost_episode_resolved_owner` /
 * `lost_episode_resolved_broadcast`) are deliberately NOT listed — those are
 * the good-news signal that MUST persist after the pet is found.
 */
export const LOST_ACTIVE_NOTIFICATION_TYPES = [
  "pet_sighting", // "Avistaje de {pet}" — someone SAW the pet (report-pet-sighting)
  "pet_found_report", // "Alguien encontró a {pet}" (notify-owner-of-found-pet; also pre-taxonomy sighting rows)
  "lost_pet_broadcast", // zone broadcast to covering org members (lost-pet-broadcast)
  "pet_in_possession", // a finder reports holding the pet (/p/[token]/encontre)
  "anonymous_reports_overflow", // "Muchos avisos sobre {pet}" — the once-an-hour notice that finder reports stopped ringing (anonymous-report-limits.ts)
] as const;

export type LostActiveNotificationType = (typeof LOST_ACTIVE_NOTIFICATION_TYPES)[number];

/**
 * Pure projection rule: a lost-active notification is stale when its subject
 * pet has moved on from `lost` (found → 'active', or 'deceased'). Rows with no
 * related pet, or whose pet is still lost, are kept.
 */
export function isResolvedLostEpisodeNotification(input: {
  notificationType: string;
  petStatus: string | null | undefined;
}): boolean {
  if (!input.petStatus) return false; // no subject pet to reconcile against
  if (
    !LOST_ACTIVE_NOTIFICATION_TYPES.includes(input.notificationType as LostActiveNotificationType)
  ) {
    return false; // not a lost-active signal — never reconciled away
  }
  return input.petStatus !== "lost";
}

// Comma-separated bound literals for the IN list, driven by the constant above.
const lostActiveTypeList = sql.join(
  LOST_ACTIVE_NOTIFICATION_TYPES.map((t) => sql`${t}`),
  sql`, `,
);

/**
 * Read-time filter mirroring `isResolvedLostEpisodeNotification`. Keep a row
 * UNLESS it is a lost-active notification whose related pet is no longer `lost`.
 * Uses a correlated EXISTS with an `rp` alias so it composes cleanly even when
 * the outer query already joins `pets`. References the base `notifications`
 * table, so it works both in the Drizzle query builder and inside a raw
 * `db.execute(sql\`... FROM notifications ...\`)`.
 */
export const excludeResolvedLostEpisodeSql = sql`(
  ${notifications.notificationType} NOT IN (${lostActiveTypeList})
  OR ${notifications.relatedPetId} IS NULL
  OR EXISTS (
    SELECT 1 FROM pets rp
    WHERE rp.id = ${notifications.relatedPetId}
      AND rp.status = 'lost'
  )
)`;

// ---------------------------------------------------------------------------
// Stale welcome reconcile — ciclo-perdido tester fix #8
// ---------------------------------------------------------------------------

/**
 * Pure projection rule for the onboarding `welcome` notification: its CTA
 * ("Registrá tu primera mascota" → /mis-mascotas/nueva) is moot the moment
 * the user actively owns a pet. Reconciled at READ time — same append-only
 * rationale as the lost-episode rule above; no migration, old rows untouched.
 */
export function isStaleWelcomeNotification(input: {
  notificationType: string;
  activeOwnedPetCount: number;
}): boolean {
  if (input.notificationType !== "welcome") return false;
  return input.activeOwnedPetCount > 0;
}

/**
 * Read-time filter mirroring `isStaleWelcomeNotification`. Keep a row UNLESS
 * it is a `welcome` notification whose user has at least one ACTIVE owner
 * tenure (role='owner', ended_at IS NULL — matches the partial index on
 * ownerships). Composes into every owner-inbox WHERE alongside
 * `excludeResolvedLostEpisodeSql` so the list, tab counts, and unread badge
 * agree.
 */
export const excludeStaleWelcomeSql = sql`(
  ${notifications.notificationType} <> 'welcome'
  OR NOT EXISTS (
    SELECT 1 FROM ownerships wo
    WHERE wo.owner_user_id = ${notifications.userId}
      AND wo.role = 'owner'
      AND wo.ended_at IS NULL
  )
)`;

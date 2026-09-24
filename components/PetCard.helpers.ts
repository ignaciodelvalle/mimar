// Pure logic for which badge a PetCard should surface on the right side.
//
// Priority (top wins):
//   1. status === "lost"      → "URGENTE · perdido"  (danger, pulse)
//   2. status === "deceased"  → "En memoria"          (neutral)
//   3. vaccineReminderState   → vaccine variant badge
//   4. (none)
//
// Reminder variants `success` and unknown are ignored — they don't warrant
// surfacing a chip on the card.

import type { Pet } from "@/db";
import type { ReminderVariant } from "@/lib/domain/vaccine-reminder-state";

export type PriorityBadge =
  | { kind: "lost" }
  | { kind: "deceased" }
  | { kind: "vaccine"; variant: ReminderVariant }
  | { kind: "none" };

export function getPriorityBadge(
  petStatus: Pet["status"],
  vaccineReminderState: { variant: ReminderVariant } | undefined,
): PriorityBadge {
  if (petStatus === "lost") return { kind: "lost" };
  if (petStatus === "deceased") return { kind: "deceased" };
  if (vaccineReminderState) {
    const v = vaccineReminderState.variant;
    if (v === "upcoming" || v === "due_soon" || v === "overdue" || v === "overdue_critical") {
      return { kind: "vaccine", variant: v };
    }
  }
  return { kind: "none" };
}

/**
 * Whether a personal-list ownership row is a tránsito (not-a-definitive-owner)
 * placement. Two distinct DB shapes both count (AGENTS.md "Shelter custody is
 * temporary by definition"):
 *
 *  - `role='foster'` — an org-linked foster placement. The org's
 *    `shelter_custody` row stays active alongside this one.
 *  - `role='shelter_custody'` — the vecino-helps-stray case: a citizen who
 *    picked up a stray and registered it (or self-declared custody via the
 *    alta's CustodyKindToggle), with NO organization involved.
 *
 * Both "Mis mascotas" and the pet profile page join ownerships scoped to
 * `ownerUserId = user.id`, so a `shelter_custody` row reaching this predicate
 * is guaranteed to be the vecino case — an org-held `shelter_custody` row has
 * `ownerUserId = null` (polymorphic-holder CHECK) and can never join into a
 * user-scoped query. Restored 2026-07-21: a prior fix (AF-H2) assumed
 * `shelter_custody` was always org-level and narrowed this to `foster` only,
 * which silently made the alta's "la estoy cuidando" registration invisible
 * as "En tránsito" everywhere in the citizen-facing UI.
 */
export function isTransitRole(ownershipRole: string): boolean {
  return ownershipRole === "foster" || ownershipRole === "shelter_custody";
}

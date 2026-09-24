// Pure classification helpers for welfare reports.
// Extracted from app/actions/welfare.ts — MALTREATMENT_KINDS set and
// bridgeEventTypeFor logic; derivePrimarySubjectKind logic extracted from
// the welfare.ts transaction body. Zero external imports.
//
// These functions are used by both create-welfare-report and
// create-org-welfare-report use-cases.

import type { WelfareReportKind, WelfareReportSubjectKind } from "./types";

// ---------------------------------------------------------------------------
// Maltreatment kinds
// ---------------------------------------------------------------------------

/**
 * Welfare report kinds that map to the `maltreatment_reported` pet event.
 * `abandonment` uses its own event type; `other` emits no event.
 * Kept as a Set for O(1) lookup at the insert hot path.
 */
export const MALTREATMENT_KINDS: ReadonlySet<WelfareReportKind> = new Set([
  "physical_abuse",
  "neglect",
  "chained",
  "no_shelter",
  "hoarding",
  "dog_fighting",
  "trafficking",
] as WelfareReportKind[]);

// ---------------------------------------------------------------------------
// Pet-event bridge
// ---------------------------------------------------------------------------

/**
 * Returns the pet event type to emit for the given welfare report kind, or
 * null when no bridge event should be emitted (kind=other or unknown).
 */
export function bridgeEventTypeFor(
  kind: WelfareReportKind | string,
): "abandonment_reported" | "maltreatment_reported" | null {
  if (kind === "abandonment") return "abandonment_reported";
  if (MALTREATMENT_KINDS.has(kind as WelfareReportKind)) return "maltreatment_reported";
  return null;
}

// ---------------------------------------------------------------------------
// Subject kind derivation for cases system (primarySubjectKind)
// ---------------------------------------------------------------------------

/**
 * Derive the `primarySubjectKind` value required by openCase().
 *
 * Cases system (Fase D1) rules from welfare.ts:
 *   - registered_pet + resolved petId → "registered_pet"
 *   - unowned_animal → "unowned_animal"
 *   - location + both coordinates present → "location"
 *   - anything else (general, or location without coords) → "general"
 *
 * The `cases_subject_location_consistency` CHECK requires that location-kind
 * subjects have non-null coordinates; subjects without coords fall back to
 * "general" to keep the constraint satisfied.
 */
export function derivePrimarySubjectKind(
  subjectKind: WelfareReportSubjectKind | string,
  petId: string | null,
  locationLat: number | string | null,
  locationLng: number | string | null,
): "registered_pet" | "unowned_animal" | "location" | "general" {
  if (subjectKind === "registered_pet" && petId != null) return "registered_pet";
  if (subjectKind === "unowned_animal") return "unowned_animal";
  if (subjectKind === "location" && locationLat != null && locationLng != null) return "location";
  return "general";
}

// ---------------------------------------------------------------------------
// Reporter / author role derivation
// ---------------------------------------------------------------------------

/**
 * The reporter role in the pet event payload: owner if the reporter owns the
 * subject pet, witness otherwise. Used in abandonment_reported /
 * maltreatment_reported events.
 */
export function deriveReporterRole(isOwnerOfSubjectPet: boolean): "owner" | "witness" {
  return isOwnerOfSubjectPet ? "owner" : "witness";
}

/**
 * The author role in the pet event: owner if the reporter owns the subject pet,
 * scanner (=someone who scanned the chip/profile) otherwise.
 */
export function deriveAuthorRole(isOwnerOfSubjectPet: boolean): "owner" | "scanner" {
  return isOwnerOfSubjectPet ? "owner" : "scanner";
}

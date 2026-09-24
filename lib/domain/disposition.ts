// Disposition-method bucket map + traceability predicate (Ley CABA 5470).
//
// The death_recorded event carries `disposition_method` (lib/event-schemas.ts)
// and `facility` in its payload. This module is the single source of truth that
// keeps the DeathRecordForm option list and the /gob/mortalidad dashboard in
// agreement: bucketOf() collapses the raw method into the five buckets the
// disposition-mix tile shows, and isTraceable() encodes the Ley 5470 headline
// (a death is traceable when its disposition method is known AND the facility
// that handled it is recorded).
//
// Pure module — no DB, no React. Unit-tested in disposition.test.ts against the
// full enum so a new form option can never be silently dropped.

/** The raw disposition_method enum (matches deathRecorded schema + form options). */
export type DispositionMethod =
  | "cremation_collective"
  | "cremation_individual_ashes"
  | "authorized_cemetery"
  | "owner_burial"
  | "household_waste"
  | "rendering"
  | "unknown";

/**
 * Normalized bucket for the disposition-mix tile (D3).
 *
 * "burial" used to merge authorized_cemetery and owner_burial into one bar —
 * hiding exactly the split the surveillance beat needs (an authorized
 * cemetery IS a compliant channel; a backyard burial is not). Honest split
 * (surveillance-disposal slice, S4): authorized_burial vs home_burial.
 */
export type DispositionBucket =
  | "cremation"
  | "authorized_burial"
  | "home_burial"
  | "rendering"
  | "other";

/**
 * Bucket assignment for every known method. Anything not listed (a null method,
 * 'unknown', or a future form value the map doesn't yet cover) falls to 'other'
 * in bucketOf — never undefined.
 */
export const DISPOSITION_BUCKETS: Record<DispositionMethod, DispositionBucket> = {
  cremation_collective: "cremation",
  cremation_individual_ashes: "cremation",
  authorized_cemetery: "authorized_burial",
  owner_burial: "home_burial",
  rendering: "rendering",
  household_waste: "other",
  unknown: "other",
};

/**
 * Collapse a raw disposition_method into its display bucket.
 * `null` (no method recorded) and any unrecognized value → 'other'.
 */
export function bucketOf(method: DispositionMethod | null | undefined): DispositionBucket {
  if (!method) return "other";
  return DISPOSITION_BUCKETS[method] ?? "other";
}

/**
 * Non-recommended disposal methods — the DeathRecordForm "No recomendadas"
 * optgroup. Shared by the rabies-observation disposal warning (DeathRecordForm)
 * and the /admin/observaciones disposal chip, so "non-recommended" can never
 * drift between what the citizen is warned about and what the authority sees.
 */
export function isNonRecommendedDisposition(method: string | null | undefined): boolean {
  return method === "owner_burial" || method === "household_waste";
}

/**
 * A disposition is traceable (Ley CABA 5470) when the method is a concrete,
 * known value (not null and not 'unknown') AND a handling facility is recorded.
 *
 * This is the B3 numerator predicate. It is duplicated in SQL inside
 * fetchMortalityDisposition for aggregate performance; both must agree, and the
 * truth table in disposition.test.ts pins the contract.
 */
export function isTraceable(
  method: DispositionMethod | null | undefined,
  facility: string | null | undefined,
): boolean {
  if (!method || method === "unknown") return false;
  if (!facility || facility.trim() === "") return false;
  return true;
}

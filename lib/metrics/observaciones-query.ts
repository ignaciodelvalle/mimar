// Query builder for /admin/observaciones — rabies-observation rows in
// progress or recently closed. Extracted from the page component (which
// previously had NO filters at all — PO: "observaciones directamente no
// tiene filtro") so the new Estado/Provincia/Localidad filters are
// unit/integration-testable in isolation, and so each filter provably
// narrows the result set (F-migration 2026-07-21, OpFilterBar sweep tail).
//
// Scope contract mirrors every other govt/admin surface: govt is fenced to
// its (already narrowed-by-selection) jurisdiction assignments; admin is
// universal, with an optional province/locality drill applied as an explicit
// predicate (the same admin-drill shape resolveJurisdictionScope hands back
// as adminSelectedProvince/adminSelectedLocality — see
// lib/analytics/jurisdiction-scope.ts). The caller is responsible for
// resolving that scope (via resolveJurisdictionScope) BEFORE calling this
// function — this module only applies it, it never re-derives the fence.

import { and, eq, inArray, or, sql } from "drizzle-orm";

import { db, petEvents, pets } from "@/db";
import type { DashboardJurisdiction } from "@/lib/metrics/context";
import { jurisdictionPairClause, withoutSyntheticRows } from "@/lib/metrics/scope";
import {
  OPEN_OBSERVATION_STATUSES,
  RABIES_OBSERVATION_STATUSES,
  type RabiesObservationStatus,
} from "@/src/modules/surveillance/domain/rabies-observation";

const DAY_MS = 24 * 60 * 60 * 1000;

/** `status IN ('in_progress','window_expired_unclosed')` — an observation with
 *  no clinical outcome asserted by anyone. Derived from the domain constant so
 *  the list cannot drift from the state machine. A function, not a const: this
 *  predicate is embedded twice per query (WHERE and ORDER BY) and drizzle SQL
 *  nodes are not meant to be shared across chunk positions. */
const openObservationClause = () =>
  inArray(pets.rabiesObservationStatus, [...OPEN_OBSERVATION_STATUSES]);
const RECENT_COMPLETED_WINDOW_DAYS = 30;
export const OBSERVACIONES_ROW_LIMIT = 500;

export type ObservacionesFilters = {
  /** null = default composite view (open OR completed in the last
   * RECENT_COMPLETED_WINDOW_DAYS days) — genuinely "all", not one status. */
  status: RabiesObservationStatus | null;
};

export type ObservacionesScope =
  | { role: "admin"; province: string | null; locality: string | null }
  | { role: "govt"; jurisdictions: readonly DashboardJurisdiction[] };

/** Parses the raw `status` searchParam. Unknown/absent → null (default composite view). */
export function parseObservacionEstado(raw: string | undefined): RabiesObservationStatus | null {
  return raw && (RABIES_OBSERVATION_STATUSES as readonly string[]).includes(raw)
    ? (raw as RabiesObservationStatus)
    : null;
}

/**
 * Rows for the observaciones list. Default view (no `status` filter) = pets
 * whose observation is still OPEN (`in_progress` or `window_expired_unclosed`)
 * OR with a `rabies_observation_ended` event in the last 30 days. A specific
 * `status` filter narrows to
 * exactly that status, with NO time bound ("every pet whose CURRENT status is
 * X" — e.g. every historically negative-closed observation, not just recent
 * ones); the row cap below still bounds the result size.
 */
export async function fetchObservaciones(scope: ObservacionesScope, filters: ObservacionesFilters) {
  if (scope.role === "govt" && scope.jurisdictions.length === 0) return [];

  const conditions = [];

  if (filters.status) {
    conditions.push(eq(pets.rabiesObservationStatus, filters.status));
  } else {
    const since30 = new Date(Date.now() - RECENT_COMPLETED_WINDOW_DAYS * DAY_MS);
    // OPEN, not just running: an observation whose window expired with no
    // professional closure is the row this screen most needs to show — it is the
    // only one that requires an operator to act. Dropping it from the default
    // view would hide the entire queue the 2026-08-17 change creates.
    conditions.push(
      or(
        openObservationClause(),
        sql`EXISTS (
        SELECT 1 FROM ${petEvents}
        WHERE ${petEvents.petId} = ${pets.id}
          AND ${petEvents.eventType} = 'rabies_observation_ended'
          AND ${petEvents.occurredAt} >= ${since30.toISOString()}
      )`,
      ) ?? sql`false`,
    );
  }

  if (scope.role === "govt") {
    // jurisdictionPairClause applies whole-province subsumption (a CABA-wide
    // assignment matches every barrio, not just the sentinel locality string)
    // — see lib/metrics/scope.ts. Raw per-assignment pairs would under-scope a
    // whole-province operator (fail-closed but wrong; pre-push review 2026-07-21).
    // scope.jurisdictions.length === 0 already returned [] above, so this is
    // never null here, but the `?? sql\`false\`` keeps the fail-closed contract.
    conditions.push(
      jurisdictionPairClause(
        [...scope.jurisdictions],
        sql`${pets.jurisdictionProvince}`,
        sql`${pets.jurisdictionLocality}`,
      ) ?? sql`false`,
    );
  }
  // T1-P1: synthetic (seed-tagged) animals are not a govt/national reader's
  // observations. Admin keeps them for demos.
  const synthetic = withoutSyntheticRows(scope.role, "pets", null);
  if (synthetic) conditions.push(synthetic);
  if (scope.role !== "govt") {
    if (scope.province) conditions.push(eq(pets.jurisdictionProvince, scope.province));
    if (scope.locality) conditions.push(eq(pets.jurisdictionLocality, scope.locality));
  }

  const rows = await db
    .select({
      petId: pets.id,
      petPublicToken: pets.publicToken,
      petName: pets.name,
      species: pets.species,
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
      status: pets.rabiesObservationStatus,
    })
    .from(pets)
    .where(and(...conditions))
    // W1: open observations must LEAD — they are the only rows that need a
    // professional cierre (see the page for the full rationale). "Open" now
    // includes window_expired_unclosed, which needs it MORE, not less.
    .orderBy(sql`(${openObservationClause()}) DESC`, pets.name)
    .limit(OBSERVACIONES_ROW_LIMIT);

  return rows.map((r) => ({
    ...r,
    status: (r.status ?? "in_progress") as RabiesObservationStatus,
  }));
}

export type ObservacionRow = Awaited<ReturnType<typeof fetchObservaciones>>[number];

// Panorama infrastructure repository — SHARED scope/shaping kernel.
//
// Extracted mechanically from repository.ts (file-size split, behavior-preserving):
// the scope-clause helpers, event predicates, and province/geo shaping helpers
// reused across the points / choropleth / by-unit / unit-history query groups.
// No logic changed — declarations that were module-private gained an `export`
// keyword ONLY so sibling repository-*.ts files can import them.

import { type SQL, and, sql } from "drizzle-orm";

import { cases, organizations, petEvents, pets, welfareReports } from "@/db";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import {
  type DashboardActor,
  type DashboardJurisdiction,
  buildProjectionContext,
  jurisdictionPairClause,
  petEventsScopeClause as metricsPetEventsScopeClause,
  petsScopeClause as metricsPetsScopeClause,
  withoutSyntheticRows,
} from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { PROVINCE_REPRESENTATIVE_POINTS } from "@/src/modules/panorama/domain/geo-representative-points";
import type { TimeBasis } from "@/src/modules/panorama/domain/time-scrub";

// Per-layer hard cap. Each loader limits at this; when the row count equals the
// cap the result is (potentially) truncated and the envelope says so.
/**
 * Is this custody_episode an actual DECOMISO (Ley 14.346 seizure)?
 *
 * There is no `decomiso` case_kind — the seizure is materialised as a
 * `custody_episode` (see execute-decomiso.ts). But the reverse does not hold:
 * org intakes, foster placements and lost-pet custody share the kind, so
 * filtering on the kind alone plots non-seizures as seizures.
 *
 * The marker is the OPENED REASON, and it exists in two forms. The writer in
 * production and in the seed emits the legacy TEXT grammar
 * (`auto: decomiso motivo=… judicial_ref=…`, mapped for display in
 * opened-reason-legacy.ts); the newer structured `opened_reason_code` column
 * carries the same fact for callers that set it. Both are accepted so this
 * neither misses today's rows nor breaks when the structured column takes over.
 *
 * MEASURED 2026-07-25 — read this before "simplifying" the predicate: of 2.051
 * seeded custody episodes, 2.049 ARE decomisos by the text marker and 0 carry
 * the structured code. A code-only filter empties the layer on the DEFAULT
 * vista while looking like a tightening.
 */
export function isDecomisoCase(): SQL {
  return sql`(
    ${cases.openedReason} LIKE 'auto: decomiso motivo=%'
    OR ${cases.openedReason} LIKE 'auto: decomiso handoff aceptado%'
    OR ${cases.openedReasonCode} IN ('decomiso_executed', 'decomiso_handoff_accepted')
  )`;
}

export const PER_LAYER_CAP = 2000;

/**
 * task #77 bitemporal — the pet_events window column for a replay basis.
 *   - "valid"       → occurred_at (when the fact happened). DEFAULT.
 *   - "transaction" → recorded_at (when the State/system learned it).
 * The gap between the two surfaces reporting lag / territorial-presence blind
 * spots. Only the pet_events-backed temporal layers (perdidas, mordeduras,
 * zoonosis) carry a true bitemporal pair; denuncias (welfare_reports.created_at =
 * intake time) and decomisos (cases) have no distinct recorded_at, so they ignore
 * the basis and replay by their single timestamp in both modes.
 *
 * PERF: recorded_at IS indexed — migration 0142 added the composite
 * pet_events_event_type_recorded_at_idx (event_type, recorded_at). Every
 * transaction-basis query filters by a specific event_type (or a BitmapOr over a
 * small set of them, e.g. perdidas/mordeduras) and THEN windows on recorded_at,
 * so this composite (event_type leading) serves the replay range scan directly.
 * A standalone recorded_at index would be redundant: no transaction-basis query
 * windows recorded_at without an event_type predicate.
 */
export function eventWindowCol(basis: TimeBasis) {
  return basis === "transaction" ? petEvents.recordedAt : petEvents.occurredAt;
}

/** Every loader returns its rows plus whether the cap clipped the result. */
export type LayerRows<Row> = {
  rows: Row[];
  /** True when the query hit PER_LAYER_CAP (more rows may exist server-side). */
  truncated: boolean;
};

// ---------------------------------------------------------------------------
// Scope clauses — reuse the canonical lib/metrics helpers (tested).
// ---------------------------------------------------------------------------

/** pets-table scope (province/locality columns).
 * admin → null (national) OR province predicate when adminProvince is set.
 * See ProjectionContext.adminProvince for the security invariant. */
export function petsScope(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): SQL | null {
  // Drizzle's `and()` has a declared return type of SQL | undefined (even with
  // non-null args). Normalize to SQL | null to match rollupPetsPerLocality/Province.
  return (
    metricsPetsScopeClause(
      buildProjectionContext(actor, jurisdictions, windows.trailing12m(), {
        adminProvince,
        adminLocality,
      }),
    ) ?? null
  );
}

/** pet_events scope (JSONB payload jurisdiction).
 * admin → null (national) OR payload province predicate when adminProvince is set. */
export function petEventsScope(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
) {
  return metricsPetEventsScopeClause(
    buildProjectionContext(actor, jurisdictions, windows.trailing12m(), {
      adminProvince,
      adminLocality,
    }),
  );
}

/** The tables that share the same (province name, locality name) jurisdiction
 * columns, and that the panorama loaders scope directly. */
export type JurisdictionColumnsTable = "welfareReports" | "cases" | "organizations";

const JURISDICTION_COLUMNS = {
  welfareReports: {
    province: sql`${welfareReports.jurisdictionProvince}`,
    locality: sql`${welfareReports.jurisdictionLocality}`,
  },
  cases: {
    province: sql`${cases.jurisdictionProvince}`,
    locality: sql`${cases.jurisdictionLocality}`,
  },
  organizations: {
    province: sql`${organizations.jurisdictionProvince}`,
    locality: sql`${organizations.jurisdictionLocality}`,
  },
} as const;

/** welfare_reports / cases / organizations share the same (province name, locality
 * name) jurisdiction columns. Build an OR of pair-matches against the named
 * table's province/locality columns.
 *
 * - admin, no province → null (no restriction)
 * - admin + province   → province (and optionally locality) predicate
 * - govt, no assignments → false (match nothing)
 * - govt, with assignments → OR of (province=X AND locality=Y) pairs
 *
 * The TABLE is named, not its two columns, because the clause also carries the
 * synthetic-row exclusion (T1-P1, lib/metrics/scope.ts) and that exclusion is
 * table-specific: a seed-tagged welfare report, a case over a seed-tagged pet
 * or report. Organizations carry no seed marker, so they pass through
 * unchanged — the seeded refugios/clínicas are a known, reported gap.
 *
 * SECURITY: the admin province branch fires ONLY for a national-read role.
 * Govt users must NOT pass adminProvince — their scope is enforced by
 * the jurisdictions pairs (same invariant as buildMaltratoListConditions).
 */
export function jurisdictionColumnsScope(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  table: JurisdictionColumnsTable,
  adminProvince?: string,
  adminLocality?: string,
): SQL | null {
  const clause = jurisdictionColumnsOnly(
    actor,
    jurisdictions,
    JURISDICTION_COLUMNS[table].province,
    JURISDICTION_COLUMNS[table].locality,
    adminProvince,
    adminLocality,
  );
  return table === "organizations" ? clause : withoutSyntheticRows(actor.role, table, clause);
}

function jurisdictionColumnsOnly(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  provinceCol: SQL,
  localityCol: SQL,
  adminProvince?: string,
  adminLocality?: string,
): SQL | null {
  if (hasNationalReadScope(actor.role)) {
    if (!adminProvince) return null;
    if (adminLocality) {
      return and(
        sql`${provinceCol} = ${adminProvince}`,
        sql`${localityCol} = ${adminLocality}`,
      ) as SQL;
    }
    return sql`${provinceCol} = ${adminProvince}`;
  }
  return (
    // synthetic: covered — jurisdictionColumnsScope and biteIncidentScope wrap this with withoutSyntheticRows.
    jurisdictionPairClause(jurisdictions, sql`${provinceCol}`, sql`${localityCol}`) ?? sql`false`
  );
}

// Normalize a name column the same way lib/ar-localidades.ts normalize() does
// (NFD-strip accents, lowercase, drop dots, collapse whitespace) so the
// jurisdiction free-text locality on the source table buckets identically to
// ar_localities.locality_name when we join for the centroid.
export function normNameSql(col: SQL): SQL {
  return sql`btrim(regexp_replace(lower(translate(unaccent(${col}), '.', '')), '\\s+', ' ', 'g'))`;
}

// ---------------------------------------------------------------------------
// pet_events:lost (perdidas) — production event predicate + attribution.
//
// The perdidas layer surfaces lost-and-found activity. Production writes TWO
// distinct events — NOT a payload 'kind' discriminator (no writer emits one;
// the note_added zod enum never even had a 'pet_found_sighting' value):
//   - a pet marked lost   → status_changed with payload.to_status = 'lost'
//                           (set-pet-lost-use-case.ts)
//   - a sighting reported → note_added with payload.kind = 'sighting'
//                           (app/actions/pet-sighting.ts; updateLostLastSeen)
// Neither carries jurisdiction in its payload — geography is attributed by the
// JOIN to pets (pets.jurisdiction_province/locality), the pet's home unit, which
// is also the correct product semantics. This replaced the demo-only
// `payload->>'kind' IN ('pet_lost','pet_found_sighting')` predicate that ONLY the
// raw-insert seed produced (the event-schema-drift pre-pilot blocker: real
// lost/sighting events were invisible on the map + unit history).
export function perdidasEventPredicate(): SQL {
  return sql`(
    (${petEvents.eventType} = 'status_changed' AND (${petEvents.payload}->>'to_status') = 'lost')
    OR (${petEvents.eventType} = 'note_added' AND (${petEvents.payload}->>'kind') = 'sighting')
  )`;
}

// panorama-event-points Slice 1 — SIGHTINGS-ONLY predicate (review A3).
//
// The near-zoom real-dot loader (loadPerdidasEvents) is deliberately NARROWER
// than perdidasEventPredicate (which also matches status_changed→lost). It
// matches ONLY `note_added` with payload kind='sighting' — an anonymous finder's
// report, ~100% coord coverage (report-pet-sighting.ts writes with
// requireCoords:true). The lost-MARK coordinate is the owner's last-seen governed
// by discloseLastLocationWhenLost — NOT unconditionally public — so it is EXCLUDED
// from Slice 1 dots (deferred until the disclosure-pref interplay is designed).
// Keeping the dot source to public-by-consent sightings makes the k-anon-bypass
// justification (an individual dot on a k-suppressed cell) uniformly airtight.
export function sightingEventPredicate(): SQL {
  return sql`(${petEvents.eventType} = 'note_added' AND (${petEvents.payload}->>'kind') = 'sighting')`;
}

// Synthetic type discriminator for the event-detail list: reproduce the old
// pet_lost / pet_found_sighting types from the REAL event type without a payload
// 'kind' field. note_added ⇒ pet_found_sighting (Avistaje); a status_changed
// to_status='lost' ⇒ pet_lost (Mascota perdida).
export function perdidasKindExpr(): SQL<string> {
  return sql<string>`CASE WHEN ${petEvents.eventType} = 'note_added' THEN 'pet_found_sighting' ELSE 'pet_lost' END`;
}

// Bite incidents — the incident_type discriminator IS real (event-schemas.ts
// incidentReported). Geography: see biteIncidentProvinceSql below — a bite is
// attributed to where it OCCURRED, not to the biting animal's home.
export function mordedurasEventPredicate(): SQL {
  return sql`(${petEvents.eventType} = 'incident_reported' AND (${petEvents.payload}->>'incident_type') IN ('bite_inflicted', 'bite_suffered'))`;
}

// ---------------------------------------------------------------------------
// Bite geography — A BITE COUNTS WHERE IT OCCURRED (PO 2026-09-08; localidad
// plan L2·3, pilot item T1-G2).
//
// Both bite writers (report-bite.ts, report-bite-from-org.ts) stamp the
// incident's own place into the `incident_reported` payload as
// `jurisdiction_province` / `jurisdiction_locality` (event-schemas.ts), and open
// the bite case there, falling back to the pet's home jurisdiction FIELD BY
// FIELD (`input.eventJurisdictionProvince ?? pet.jurisdictionProvince`, and the
// same for the locality) when the reporter dropped no pin. These expressions
// are the SQL spelling of exactly that fallback — COALESCE is `??` — so the map
// and the case queue agree about where a bite happened. A CABA dog that bites
// in Córdoba is Córdoba's bite, in the case AND on the map.
//
// Used by loadBiteEvents and loadMordedurassByUnit; `pets` must be in FROM (the
// fallback half, and the synthetic-row exclusion, read it).
// ---------------------------------------------------------------------------

export function biteIncidentProvinceSql(): SQL<string | null> {
  return sql<
    string | null
  >`COALESCE((${petEvents.payload}->>'jurisdiction_province'), ${pets.jurisdictionProvince})`;
}

export function biteIncidentLocalitySql(): SQL<string | null> {
  return sql<
    string | null
  >`COALESCE((${petEvents.payload}->>'jurisdiction_locality'), ${pets.jurisdictionLocality})`;
}

/**
 * The viewer scope for a bite query, over the incident's place (above) rather
 * than the pet's home. Same contract as jurisdictionColumnsScope (admin
 * universal / admin drill / govt pairs / govt without assignments → false),
 * plus the synthetic-row exclusion on the biting pet (T1-P1).
 */
export function biteIncidentScope(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): SQL | null {
  return withoutSyntheticRows(
    actor.role,
    "pets",
    jurisdictionColumnsOnly(
      actor,
      jurisdictions,
      biteIncidentProvinceSql(),
      biteIncidentLocalitySql(),
      adminProvince,
      adminLocality,
    ),
  );
}

/** Internal raw rollup row before suppression. */
export type RollupRow = {
  key: string;
  province: string;
  locality: string;
  centroidLat: string | null;
  centroidLng: string | null;
  /** INDEC 5-digit department code (from ar_localities) for the departamento
   * roll-up on the map. Null when the locality has no matching ar_localities row
   * (the cell then falls back to its centroid circle, never a polygon fill).
   * OPTIONAL: only the locality-CHOROPLETH rollup carries it; the aggregated
   * point rollups (perdidas/mordeduras/…) share this row shape and omit it
   * (they render as centroid circles, never a division fill). */
  departmentCode?: string | null;
  /** Department display name for the division popup/legend (choropleth only). */
  departmentName?: string | null;
  count: number;
};

/** Map a canonical province NAME column to its ISO code via a CASE expression.
 * ar_localities stores the ISO code; welfare/cases/pets store the display name. */
export function provinceIsoMapSql(provinceCol: SQL): SQL {
  const pairs = Object.entries(PROVINCE_ISO).map(
    ([name, code]) => sql`WHEN ${provinceCol} = ${name} THEN ${code}`,
  );
  return sql`(CASE ${sql.join(pairs, sql` `)} ELSE '' END)`;
}

// Canonical province display name → ISO 3166-2:AR code (mirrors the map in
// lib/govt-dashboards.ts; duplicated locally to keep this module self-contained
// and free of a govt-dashboards import cycle).
export const PROVINCE_ISO: Record<string, string> = {
  "Buenos Aires": "AR-B",
  CABA: "AR-C",
  Catamarca: "AR-K",
  Chaco: "AR-H",
  Chubut: "AR-U",
  Córdoba: "AR-X",
  Corrientes: "AR-W",
  "Entre Ríos": "AR-E",
  Formosa: "AR-P",
  Jujuy: "AR-Y",
  "La Pampa": "AR-L",
  "La Rioja": "AR-F",
  Mendoza: "AR-M",
  Misiones: "AR-N",
  Neuquén: "AR-Q",
  "Río Negro": "AR-R",
  Salta: "AR-A",
  "San Juan": "AR-J",
  "San Luis": "AR-D",
  "Santa Cruz": "AR-Z",
  "Santa Fe": "AR-S",
  "Santiago del Estero": "AR-G",
  "Tierra del Fuego": "AR-V",
  Tucumán: "AR-T",
};

/**
 * Representative point for a province-level aggregated marker, resolved from
 * its canonical display NAME (as stored on pets/welfareReports/petEvents
 * payloads) via PROVINCE_ISO → the precomputed point-on-surface lookup
 * (domain/geo-representative-points.ts).
 *
 * Replaces a runtime `AVG(ar_localities.latitude/longitude)` over the
 * province's member localities, which has no guarantee of landing inside the
 * province polygon for a concave/multi-part geography — confirmed failure:
 * Tierra del Fuego (AR-V) is a MultiPolygon (Isla Grande + the
 * Malvinas/Georgias claim + minor islands); averaging locality coordinates
 * across those parts drifted the marker into the South Atlantic. The
 * precomputed point is the pole of inaccessibility of the province's LARGEST
 * polygon part, so it is guaranteed to sit on that unit's own landmass.
 *
 * Placement-only: does not affect which provinces get a marker (still driven
 * by the real count query), does not touch k-anon, and is not jitter (one
 * deterministic point per province, not noise). Returns nulls (no marker
 * position — matches the prior "no centroid resolved" fallback) if the name
 * doesn't map to a known ISO code, which should not happen for a
 * NOT NULL jurisdiction_province column.
 */
export function provinceRepresentativeCentroid(provinceName: string | null | undefined): {
  centroidLat: string | null;
  centroidLng: string | null;
} {
  const iso = provinceName ? PROVINCE_ISO[provinceName] : undefined;
  const point = iso ? PROVINCE_REPRESENTATIVE_POINTS[iso] : undefined;
  return point
    ? { centroidLat: String(point.lat), centroidLng: String(point.lng) }
    : { centroidLat: null, centroidLng: null };
}

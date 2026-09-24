// Panorama infrastructure repository — POINT layers (mordeduras, denuncias,
// zoonosis outbreak signals, refugios, clinicas, decomisos).
//
// Extracted mechanically from repository.ts (file-size split, behavior-
// preserving): every loader here is unchanged, only moved. Scope-clause and
// event-predicate helpers now live in ./repository-scope.

import { type SQL, and, count, eq, gte, isNotNull, lte, sql } from "drizzle-orm";

import { cases, analyticsDb as db, organizations, petEvents, pets, welfareReports } from "@/db";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";
import { findDisease } from "@/lib/reference/diseases";
import type {
  BiteRow,
  DecomisoRow,
  DenunciaCentroidRow,
  OutbreakRow,
  ShelterRow,
} from "@/src/modules/panorama/application/build-features";
import type { TimeBasis } from "@/src/modules/panorama/domain/time-scrub";

import {
  type LayerRows,
  PER_LAYER_CAP,
  biteIncidentScope,
  eventWindowCol,
  jurisdictionColumnsScope,
  mordedurasEventPredicate,
  normNameSql,
  petEventsScope,
  provinceIsoMapSql,
} from "./repository-scope";

// ---------------------------------------------------------------------------
// pet_events:bite (mordeduras) — individual bite incident_reported events.
// ---------------------------------------------------------------------------

export async function loadBiteEvents(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  since: Date,
  asOf?: Date,
  adminProvince?: string,
  adminLocality?: string,
  // task #77 bitemporal: "valid" (occurred_at, default) or "transaction" (recorded_at).
  basis: TimeBasis = "valid",
): Promise<LayerRows<BiteRow> & { noCoordCount: number }> {
  // task #77: the replay-basis window column (occurred_at vs recorded_at).
  const tcol = eventWindowCol(basis);
  // Base scope+period predicate shared by the dot query and the residual COUNT.
  const base: SQL[] = [
    // bite_inflicted | bite_suffered are the two bite variants (event-schemas.ts).
    mordedurasEventPredicate(),
    gte(tcol, since),
  ];
  // F4 temporal reproduction: upper-bound the event window so the layer can be
  // reconstructed "as of t" while the TimeScrubber plays.
  if (asOf) base.push(lte(tcol, asOf));
  // A bite counts where it OCCURRED: incident_reported carries the incident's own
  // jurisdiction_province/_locality in its payload (event-schemas.ts), and the
  // scope reads it, falling back to the pet's home field by field exactly like the
  // bite case does (biteIncidentScope, repository-scope.ts). NOT petEventsScope —
  // that one reads outbreak_signal's pet_jurisdiction_* snapshot, which this event
  // never carries, and filtered out every real bite for scoped govt users.
  // PRIVACY (Slice 2): this scope binding is the operator-jurisdiction gate — a govt
  // user physically cannot fetch a bite outside their scope; admins must have drilled
  // into a province (server-authoritative points gate in get-layer-features/route).
  const scope = biteIncidentScope(actor, jurisdictions, adminProvince, adminLocality);
  if (scope) base.push(sql`(${scope})`);

  const rows = await db
    .select({
      id: petEvents.id,
      locationLat: petEvents.locationLat,
      locationLng: petEvents.locationLng,
      incidentType: sql<string>`(${petEvents.payload}->>'incident_type')`,
      severity: sql<string | null>`(${petEvents.payload}->>'severity')`,
      occurredAt: petEvents.occurredAt,
    })
    .from(petEvents)
    .innerJoin(pets, eq(petEvents.petId, pets.id))
    // Located events only — a point layer never plots a null coordinate.
    .where(and(...base, isNotNull(petEvents.locationLat)))
    // Most-recent-first (by the active basis) so a capped result keeps the
    // freshest incidents — most-recently-recorded under transaction basis.
    .orderBy(sql`${tcol} DESC`)
    .limit(PER_LAYER_CAP);

  // Residual: in-scope bites with NO columnar coordinate (older events written
  // before Slice 2's map-pin capture). Surfaced as an honest "sin ubicación
  // exacta" count — never plotted as a fake centroid dot (fallback honesty, §5).
  const [residual] = await db
    .select({ n: count() })
    .from(petEvents)
    .innerJoin(pets, eq(petEvents.petId, pets.id))
    .where(and(...base, sql`${petEvents.locationLat} IS NULL`));

  return {
    rows: rows.map((r) => ({
      id: r.id,
      locationLat: r.locationLat,
      locationLng: r.locationLng,
      incidentType: r.incidentType,
      severity: r.severity,
      occurredAt: r.occurredAt ? r.occurredAt.toISOString() : null,
    })),
    truncated: rows.length >= PER_LAYER_CAP,
    noCoordCount: residual?.n ?? 0,
  };
}

// ---------------------------------------------------------------------------
// welfare_reports (denuncias) — COARSE: snap to the locality centroid.
//
// The exact welfare_reports.location_lat/lng is NEVER SELECTed. We resolve the
// centroid from ar_localities by matching the report's jurisdiction
// (province name → ISO code, normalized locality name). Reports whose locality
// cannot be matched to a centroid are dropped (no coordinate to coarsen to).
// ---------------------------------------------------------------------------

export async function loadDenunciaCentroids(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  since: Date,
  asOf?: Date,
  adminProvince?: string,
  adminLocality?: string,
): Promise<LayerRows<DenunciaCentroidRow>> {
  const conditions = [
    gte(welfareReports.createdAt, since),
    // Hide moderation-flagged-not-resolved rows (same rule as /gob/maltrato).
    sql`(${welfareReports.flaggedAt} IS NULL OR ${welfareReports.moderationResolvedAt} IS NOT NULL)`,
    isNotNull(welfareReports.jurisdictionLocality),
  ];
  // F4: upper-bound the report window for temporal reproduction.
  if (asOf) conditions.push(lte(welfareReports.createdAt, asOf));
  const scope = jurisdictionColumnsScope(
    actor,
    jurisdictions,
    "welfareReports",
    adminProvince,
    adminLocality,
  );
  if (scope) conditions.push(sql`(${scope})`);

  // Resolve the locality centroid via SCALAR correlated subqueries (MIN over the
  // matching ar_localities rows) rather than a JOIN — a join fans out when an
  // INDEC (province, name) pair is ambiguous, which would over-plot a report.
  // The subquery yields exactly ONE centroid per report (deterministic via MIN).
  // The exact welfare_reports.location_lat/lng is NEVER selected.
  const centroidLat = sql<string | null>`(
    SELECT MIN(al.latitude) FROM ar_localities al
    WHERE al.province_code = ${provinceIsoMapSql(sql`${welfareReports.jurisdictionProvince}`)}
      AND ${sql`al.locality_name_norm`} = ${normNameSql(sql`${welfareReports.jurisdictionLocality}`)}
      AND al.removed_at IS NULL
  )`;
  const centroidLng = sql<string | null>`(
    SELECT MIN(al.longitude) FROM ar_localities al
    WHERE al.province_code = ${provinceIsoMapSql(sql`${welfareReports.jurisdictionProvince}`)}
      AND ${sql`al.locality_name_norm`} = ${normNameSql(sql`${welfareReports.jurisdictionLocality}`)}
      AND al.removed_at IS NULL
  )`;

  const rows = await db
    .select({
      reportLat: centroidLat,
      reportLng: centroidLng,
      province: welfareReports.jurisdictionProvince,
      locality: welfareReports.jurisdictionLocality,
      severity: welfareReports.severity,
      kind: welfareReports.kind,
      createdAt: welfareReports.createdAt,
    })
    .from(welfareReports)
    .where(and(...conditions))
    .limit(PER_LAYER_CAP);

  return {
    // Drop reports whose locality could not be matched to a centroid (the pure
    // build-features transform also drops null-geometry, but filter early so the
    // count reflects plottable reports).
    rows: rows
      .filter((r) => r.reportLat !== null && r.reportLng !== null)
      .map((r) => ({
        // Snapped centroid only — never the exact report coordinate.
        centroidLat: r.reportLat,
        centroidLng: r.reportLng,
        province: r.province,
        locality: r.locality,
        severity: r.severity,
        kind: r.kind,
        createdAt: r.createdAt ? r.createdAt.toISOString() : null,
      })),
    truncated: rows.length >= PER_LAYER_CAP,
  };
}

// ---------------------------------------------------------------------------
// outbreak_signals (zoonosis) — outbreak_signal pet_events with coords.
// ---------------------------------------------------------------------------

export async function loadOutbreakSignals(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  since: Date,
  asOf?: Date,
  adminProvince?: string,
  adminLocality?: string,
): Promise<LayerRows<OutbreakRow>> {
  const conditions = [
    eq(petEvents.eventType, "outbreak_signal"),
    gte(petEvents.occurredAt, since),
    isNotNull(petEvents.locationLat),
  ];
  // F4: upper-bound the outbreak-signal window for temporal reproduction.
  if (asOf) conditions.push(lte(petEvents.occurredAt, asOf));
  // outbreak_signal stores its own jurisdiction keys; reuse the payload scope.
  const scope = petEventsScope(actor, jurisdictions, adminProvince, adminLocality);
  if (scope) conditions.push(sql`(${scope})`);

  const rows = await db
    .select({
      id: petEvents.id,
      locationLat: petEvents.locationLat,
      locationLng: petEvents.locationLng,
      diseaseCode: sql<string | null>`(${petEvents.payload}->>'disease_code')`,
      diseaseLabel: sql<string | null>`(${petEvents.payload}->>'disease_label')`,
      occurredAt: petEvents.occurredAt,
    })
    .from(petEvents)
    .where(and(...conditions))
    .limit(PER_LAYER_CAP);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      locationLat: r.locationLat,
      locationLng: r.locationLng,
      diseaseCode: r.diseaseCode,
      diseaseLabel: r.diseaseLabel ?? findDisease(r.diseaseCode)?.label ?? null,
      occurredAt: r.occurredAt ? r.occurredAt.toISOString() : null,
    })),
    truncated: rows.length >= PER_LAYER_CAP,
  };
}

// ---------------------------------------------------------------------------
// organizations:shelter (refugios) — shelter orgs with coords.
// ---------------------------------------------------------------------------

export async function loadShelters(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): Promise<LayerRows<ShelterRow>> {
  const conditions = [
    eq(organizations.orgType, "shelter"),
    eq(organizations.status, "active"),
    isNotNull(organizations.locationLat),
  ];
  const scope = jurisdictionColumnsScope(
    actor,
    jurisdictions,
    "organizations",
    adminProvince,
    adminLocality,
  );
  if (scope) conditions.push(sql`(${scope})`);

  const rows = await db
    .select({
      id: organizations.id,
      publicToken: organizations.publicToken,
      displayName: organizations.displayName,
      locationLat: organizations.locationLat,
      locationLng: organizations.locationLng,
      verified: organizations.verified,
    })
    .from(organizations)
    .where(and(...conditions))
    .limit(PER_LAYER_CAP);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      publicToken: r.publicToken,
      displayName: r.displayName,
      locationLat: r.locationLat,
      locationLng: r.locationLng,
      verified: r.verified,
    })),
    truncated: rows.length >= PER_LAYER_CAP,
  };
}

// ---------------------------------------------------------------------------
// organizations:clinic (clinicas) — verified veterinary clinics with coords.
//
// DISJOINT FROM refugios: loadShelters filters orgType='shelter', this filters
// orgType='clinic', so a given org pins on at most one reference layer (no
// double-pinning). Clinics additionally require verified=true — a funcionario-
// facing directory of official veterinary clinics, not unverified self-listings.
// ---------------------------------------------------------------------------

export async function loadClinics(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): Promise<LayerRows<ShelterRow>> {
  const conditions = [
    eq(organizations.orgType, "clinic"),
    eq(organizations.status, "active"),
    eq(organizations.verified, true),
    isNotNull(organizations.locationLat),
  ];
  const scope = jurisdictionColumnsScope(
    actor,
    jurisdictions,
    "organizations",
    adminProvince,
    adminLocality,
  );
  if (scope) conditions.push(sql`(${scope})`);

  const rows = await db
    .select({
      id: organizations.id,
      publicToken: organizations.publicToken,
      displayName: organizations.displayName,
      locationLat: organizations.locationLat,
      locationLng: organizations.locationLng,
      verified: organizations.verified,
    })
    .from(organizations)
    .where(and(...conditions))
    .limit(PER_LAYER_CAP);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      publicToken: r.publicToken,
      displayName: r.displayName,
      locationLat: r.locationLat,
      locationLng: r.locationLng,
      verified: r.verified,
    })),
    truncated: rows.length >= PER_LAYER_CAP,
  };
}

// ---------------------------------------------------------------------------
// cases:decomiso (decomisos) — custody_episode cases at their locality centroid.
//
// The decomiso (Ley 14.346 seizure) case_kind is 'custody_episode' (see
// app/gob/decomisos). A registered-pet case stores NO point
// (cases_subject_location_consistency biconditional), so each case plots at the
// centroid of its jurisdiction locality — coarse, resolved like loadDenunciaCentroids.
// ---------------------------------------------------------------------------

export async function loadDecomisos(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  since: Date,
  asOf?: Date,
  adminProvince?: string,
  adminLocality?: string,
): Promise<LayerRows<DecomisoRow>> {
  const conditions = [
    eq(cases.caseKind, "custody_episode"),
    gte(cases.openedAt, since),
    isNotNull(cases.jurisdictionLocality),
  ];
  // F4: upper-bound the decomiso (custody_episode) window for temporal reproduction.
  if (asOf) conditions.push(lte(cases.openedAt, asOf));
  const scope = jurisdictionColumnsScope(
    actor,
    jurisdictions,
    "cases",
    adminProvince,
    adminLocality,
  );
  if (scope) conditions.push(sql`(${scope})`);

  // One centroid per case (scalar MIN subqueries), same pattern as denuncias.
  const centroidLat = sql<string | null>`(
    SELECT MIN(al.latitude) FROM ar_localities al
    WHERE al.province_code = ${provinceIsoMapSql(sql`${cases.jurisdictionProvince}`)}
      AND ${sql`al.locality_name_norm`} = ${normNameSql(sql`${cases.jurisdictionLocality}`)}
      AND al.removed_at IS NULL
  )`;
  const centroidLng = sql<string | null>`(
    SELECT MIN(al.longitude) FROM ar_localities al
    WHERE al.province_code = ${provinceIsoMapSql(sql`${cases.jurisdictionProvince}`)}
      AND ${sql`al.locality_name_norm`} = ${normNameSql(sql`${cases.jurisdictionLocality}`)}
      AND al.removed_at IS NULL
  )`;

  const rows = await db
    .select({
      id: cases.id,
      publicCode: cases.publicCode,
      status: cases.status,
      centroidLat,
      centroidLng,
      openedAt: cases.openedAt,
    })
    .from(cases)
    .where(and(...conditions))
    .limit(PER_LAYER_CAP);

  return {
    rows: rows
      .filter((r) => r.centroidLat !== null && r.centroidLng !== null)
      .map((r) => ({
        id: r.id,
        publicCode: r.publicCode,
        status: r.status,
        centroidLat: r.centroidLat,
        centroidLng: r.centroidLng,
        openedAt: r.openedAt ? r.openedAt.toISOString() : null,
      })),
    truncated: rows.length >= PER_LAYER_CAP,
  };
}

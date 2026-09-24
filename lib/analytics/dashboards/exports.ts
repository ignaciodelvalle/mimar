// Export fetchers — E6.
//
// Lightweight queries that return the exact fields declared in the Zod schemas
// in lib/govt-exports.ts. Each fetcher returns raw objects; the server action
// runs anonymizeRows() on the output before serialization.
//
// Period filtering: optional `since` / `until` bounds applied to the row's
// relevant timestamp column.
//
// Split out of lib/analytics/govt-dashboards.ts (engram refactor/govt-dashboards-split).

import { and, eq, sql } from "drizzle-orm";

import { cases, analyticsDb as db, organizations, petEvents, pets } from "@/db";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";
import {
  casesScopeClause,
  organizationsScopeClause,
  petsCurrentJurisdictionClause,
  petsScopeClause,
} from "./_scope";

export type ExportPeriod = { since?: Date; until?: Date };

/** Raw pets rows for the export pipeline. */
export type RawPetExportRow = {
  publicToken: string;
  species: string;
  acquisitionMethod: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  status: string;
  /** YYYY-MM derived from createdAt. */
  registeredAtMonth: string;
};

export async function fetchPetsForExport(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  period: ExportPeriod = {},
  adminProvince?: string,
  adminLocality?: string,
): Promise<RawPetExportRow[]> {
  if (actor.role === "govt" && jurisdictions.length === 0) return [];

  const conditions: ReturnType<typeof sql>[] = [];
  const scope = petsScopeClause(actor, jurisdictions, adminProvince, adminLocality);
  if (scope) conditions.push(sql`(${scope})`);
  // Bind dates as ISO strings — a raw JS Date in sql`` crashes postgres-js
  // (prepare:false) with ERR_INVALID_ARG_TYPE; the comparison casts to timestamptz.
  if (period.since) conditions.push(sql`${pets.createdAt} >= ${period.since.toISOString()}`);
  if (period.until) conditions.push(sql`${pets.createdAt} <= ${period.until.toISOString()}`);

  const rows = await db
    .select({
      publicToken: pets.publicToken,
      species: pets.species,
      acquisitionMethod: pets.acquisitionMethod,
      jurisdictionProvince: pets.jurisdictionProvince,
      jurisdictionLocality: pets.jurisdictionLocality,
      status: pets.status,
      createdAt: pets.createdAt,
    })
    .from(pets)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .limit(50_000);

  return rows.map((r) => ({
    publicToken: r.publicToken,
    species: r.species,
    acquisitionMethod: r.acquisitionMethod ?? null,
    jurisdictionProvince: r.jurisdictionProvince ?? null,
    jurisdictionLocality: r.jurisdictionLocality ?? null,
    status: r.status,
    registeredAtMonth: r.createdAt.toISOString().slice(0, 7),
  }));
}

/** Raw pet_events rows for the export pipeline. */
export type RawEventExportRow = {
  petPublicToken: string;
  eventType: string;
  /** YYYY-MM derived from occurredAt. */
  occurredAtMonth: string;
};

export async function fetchEventsForExport(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  period: ExportPeriod = {},
  adminProvince?: string,
  adminLocality?: string,
): Promise<RawEventExportRow[]> {
  if (actor.role === "govt" && jurisdictions.length === 0) return [];

  const conditions: ReturnType<typeof sql>[] = [];
  // This export spans ALL event types, but only outbreak_signal carries the payload
  // jurisdiction snapshot — so scoping by petEventsScopeClause zeroed every non-
  // outbreak event for a scoped-govt export (the ghost-payload bug). Scope by the
  // pet's CURRENT jurisdiction (pets columns) against the pets INNER JOIN below;
  // this is also the payload-drift guard the sibling fetchers got in the 2026-07-04
  // scope review. Admin with no province selected → null (universal export);
  // admin with a province/locality selected → drill-down predicate (export
  // honors the active filter, Fase C 2026-07-21).
  const petsScope = petsCurrentJurisdictionClause(
    actor,
    jurisdictions,
    adminProvince,
    adminLocality,
  );
  if (petsScope) conditions.push(sql`(${petsScope})`);
  // Bind dates as ISO strings (see fetchPetsForExport) — raw Date in sql`` crashes postgres-js.
  if (period.since) conditions.push(sql`${petEvents.occurredAt} >= ${period.since.toISOString()}`);
  if (period.until) conditions.push(sql`${petEvents.occurredAt} <= ${period.until.toISOString()}`);

  const rows = await db
    .select({
      petPublicToken: pets.publicToken,
      eventType: petEvents.eventType,
      occurredAt: petEvents.occurredAt,
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .limit(100_000);

  return rows.map((r) => ({
    petPublicToken: r.petPublicToken,
    eventType: r.eventType,
    occurredAtMonth: r.occurredAt.toISOString().slice(0, 7),
  }));
}

/** Raw cases rows for the export pipeline. */
export type RawCaseExportRow = {
  publicCode: string;
  caseKind: string;
  status: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  /** YYYY-MM derived from createdAt. */
  createdAtMonth: string;
};

export async function fetchCasesForExport(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  period: ExportPeriod = {},
  adminProvince?: string,
  adminLocality?: string,
): Promise<RawCaseExportRow[]> {
  if (actor.role === "govt" && jurisdictions.length === 0) return [];

  const conditions: ReturnType<typeof sql>[] = [];
  const scope = casesScopeClause(actor, jurisdictions, adminProvince, adminLocality);
  if (scope) conditions.push(sql`(${scope})`);
  // Bind dates as ISO strings (see fetchPetsForExport) — raw Date in sql`` crashes postgres-js.
  if (period.since) conditions.push(sql`${cases.createdAt} >= ${period.since.toISOString()}`);
  if (period.until) conditions.push(sql`${cases.createdAt} <= ${period.until.toISOString()}`);

  const rows = await db
    .select({
      publicCode: cases.publicCode,
      caseKind: cases.caseKind,
      status: cases.status,
      jurisdictionProvince: cases.jurisdictionProvince,
      jurisdictionLocality: cases.jurisdictionLocality,
      createdAt: cases.createdAt,
    })
    .from(cases)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .limit(50_000);

  return rows.map((r) => ({
    publicCode: r.publicCode,
    caseKind: r.caseKind,
    status: r.status,
    jurisdictionProvince: r.jurisdictionProvince ?? null,
    jurisdictionLocality: r.jurisdictionLocality ?? null,
    createdAtMonth: r.createdAt.toISOString().slice(0, 7),
  }));
}

/** Raw organizations rows for the export pipeline. */
export type RawOrganizationExportRow = {
  publicToken: string;
  displayName: string;
  orgType: string;
  verified: boolean;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
};

export async function fetchOrganizationsForExport(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): Promise<RawOrganizationExportRow[]> {
  const conditions: ReturnType<typeof sql>[] = [];

  // Orgs are scoped by their primary jurisdiction. Govt sees only orgs whose
  // jurisdiction_province / locality matches one of their assignments; admin's
  // province/locality drill-down narrows the export to the ACTIVE filter (Fase
  // C 2026-07-21). Both branches resolved by the ONE shared helper (C3, ONE
  // VIEWSCOPE) — admin with no drill → null → unrestricted, exactly as before.
  if (actor.role === "govt" && jurisdictions.length === 0) return [];
  const scope = organizationsScopeClause(actor, jurisdictions, adminProvince, adminLocality);
  if (scope) conditions.push(sql`(${scope})`);

  const rows = await db
    .select({
      publicToken: organizations.publicToken,
      displayName: organizations.displayName,
      orgType: organizations.orgType,
      verified: organizations.verified,
      jurisdictionProvince: organizations.jurisdictionProvince,
      jurisdictionLocality: organizations.jurisdictionLocality,
    })
    .from(organizations)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .limit(10_000);

  return rows.map((r) => ({
    publicToken: r.publicToken,
    displayName: r.displayName,
    orgType: r.orgType,
    verified: r.verified,
    jurisdictionProvince: r.jurisdictionProvince ?? null,
    jurisdictionLocality: r.jurisdictionLocality ?? null,
  }));
}

// The finder's plan-B list — the one server-side read (P4, migration 0292;
// design note docs/superpowers/specs/2026-10-p4-receptoras-cercanas.md §4).
//
// Every query here is a READ over Drizzle (BYPASSRLS), like every public org
// read since 0278–0280 closed the anon surface. Three rules hold for all of it:
//
//   1. THE POINT ARRIVES COARSE. Callers hand in a point already snapped by
//      coarsenPoint(); the org end is snapped HERE, in SQL, before the
//      distance (round(…, 2) — the same 0.01° grid). Nothing finer is measured.
//   2. WHO IS LISTED IS DECIDED IN THE QUERY (privacy checklist §4). Receivers:
//      the intake switch AND verified AND active AND an allowed type — the SQL
//      twin of isListedReceiver(). Vets: the public directory's own predicate,
//      publicDirectoryVisible(), narrowed to clinics — the directory's rule,
//      reused, not restated.
//   3. NOTHING IS WRITTEN AND NOTHING IS LOGGED. No insert, no update, no
//      reportError carrying the point. The test runs these in a transaction and
//      asserts no transaction id was ever assigned.
//
// Distance: the equirectangular expression lib/infra/ar-localidades.ts uses
// for the same purpose (the local stack has no PostGIS) — exact enough at the
// tens-of-kilometres scale of a 50 km radius. An org with no pin falls back to
// its catalogue locality's centroid (organizations.locality_id); with neither
// it cannot be ranked and is not listed.

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { arLocalities, db, orgFoundAnimalIntake, organizations } from "@/db";
import { publicDirectoryVisible } from "@/lib/infra/org-directory";
import { CABA_CITY_NAME } from "@/lib/place/authority-units-plan";
import { OFFICIAL_LOCAL_GOVERNMENTS } from "@/lib/place/local-governments";
import { provinceByCode } from "@/lib/reference/ar-provincias";
import {
  FOUND_ANIMAL_INTAKE_ORG_TYPES,
  FOUND_HELP_ORG_TYPE_LABELS,
  INTAKE_CAPACITY_LABELS,
  INTAKE_CONTACT_KIND_LABELS,
  intakeContactHref,
  isIntakeCapacityStatus,
  isIntakeContactKind,
} from "@/src/modules/organizations/domain/found-animal-intake";
import {
  type GeoPoint,
  NEARBY_RADIUS_KM,
  type NearbyOrgCard,
  RECEIVER_LIMIT,
  VET_LIMIT,
  distanceLabel,
  rankNearby,
} from "@/src/modules/organizations/domain/nearby-help";
import { isListedInPublicDirectory } from "@/src/modules/organizations/domain/public-directory";

type OrgType = (typeof organizations.orgType.enumValues)[number];
type Executor = Pick<typeof db, "select">;

const RECEIVER_TYPES = [...FOUND_ANIMAL_INTAKE_ORG_TYPES] as OrgType[];

/** Kilometres per degree of latitude (mean Earth radius 6371 km). */
const KM_PER_DEGREE = 111.195;

/** The org's coordinates on the 0.01° grid: its pin, else its locality's centroid. */
const orgLat = sql<number>`round(coalesce(${organizations.locationLat}, ${arLocalities.latitude})::numeric, 2)::float8`;
const orgLng = sql<number>`round(coalesce(${organizations.locationLng}, ${arLocalities.longitude})::numeric, 2)::float8`;

function distanceKmSql(point: GeoPoint) {
  return sql<number>`(${KM_PER_DEGREE} * sqrt(
    power(${orgLat} - ${point.lat}::float8, 2) +
    power((${orgLng} - ${point.lng}::float8) * cos(radians(${point.lat}::float8)), 2)
  ))`;
}

const hasCoordinates = sql`coalesce(${organizations.locationLat}, ${arLocalities.latitude}) IS NOT NULL
  AND coalesce(${organizations.locationLng}, ${arLocalities.longitude}) IS NOT NULL`;

/** The org columns every card is built from. Coordinates are NOT among them. */
const orgCardColumns = {
  publicToken: organizations.publicToken,
  displayName: organizations.displayName,
  orgType: organizations.orgType,
  verified: organizations.verified,
  status: organizations.status,
  publicDirectoryOptIn: organizations.publicDirectoryOptIn,
  jurisdictionLocality: organizations.jurisdictionLocality,
};

type OrgCardRow = {
  publicToken: string;
  displayName: string;
  orgType: string;
  verified: boolean;
  status: string;
  publicDirectoryOptIn: boolean;
  jurisdictionLocality: string | null;
};

type IntakeCardRow = {
  capacityStatus: string;
  publicContactKind: string | null;
  publicContactValue: string | null;
  publicHours: string | null;
};

function profileHref(row: OrgCardRow): string | null {
  return isListedInPublicDirectory(row) ? `/refugios/${row.publicToken}` : null;
}

function receiverCard(row: OrgCardRow & IntakeCardRow, distance: string): NearbyOrgCard {
  const kind = row.publicContactKind;
  const value = row.publicContactValue;
  const contact =
    kind && value && isIntakeContactKind(kind)
      ? { label: INTAKE_CONTACT_KIND_LABELS[kind], value, href: intakeContactHref(kind, value) }
      : null;
  return {
    profileHref: profileHref(row),
    displayName: row.displayName,
    typeLabel: FOUND_HELP_ORG_TYPE_LABELS[row.orgType] ?? "Organización",
    locality: row.jurisdictionLocality,
    distanceLabel: distance,
    capacityLabel: isIntakeCapacityStatus(row.capacityStatus)
      ? INTAKE_CAPACITY_LABELS[row.capacityStatus]
      : null,
    contact,
    hours: row.publicHours,
  };
}

function vetCard(row: OrgCardRow, distance: string): NearbyOrgCard {
  return {
    profileHref: profileHref(row),
    displayName: row.displayName,
    typeLabel: FOUND_HELP_ORG_TYPE_LABELS[row.orgType] ?? "Veterinaria",
    locality: row.jurisdictionLocality,
    distanceLabel: distance,
    capacityLabel: null,
    contact: null,
    hours: null,
  };
}

const intakeCardColumns = {
  capacityStatus: orgFoundAnimalIntake.capacityStatus,
  publicContactKind: orgFoundAnimalIntake.publicContactKind,
  publicContactValue: orgFoundAnimalIntake.publicContactValue,
  publicHours: orgFoundAnimalIntake.publicHours,
};

/** The SQL twin of isListedReceiver(). */
function listedReceiver() {
  return and(
    eq(orgFoundAnimalIntake.accepting, true),
    eq(organizations.verified, true),
    eq(organizations.status, "active"),
    inArray(organizations.orgType, RECEIVER_TYPES),
  );
}

/**
 * Receiving organizations near a COARSE point, nearest first, within the
 * radius, at most RECEIVER_LIMIT.
 */
export async function queryNearbyReceivers(
  point: GeoPoint,
  executor: Executor = db,
): Promise<NearbyOrgCard[]> {
  const distance = distanceKmSql(point);
  const rows = await executor
    .select({ ...orgCardColumns, ...intakeCardColumns, distanceKm: distance })
    .from(orgFoundAnimalIntake)
    .innerJoin(organizations, eq(organizations.id, orgFoundAnimalIntake.organizationId))
    .leftJoin(
      arLocalities,
      and(eq(arLocalities.id, organizations.localityId), isNull(arLocalities.removedAt)),
    )
    .where(and(listedReceiver(), hasCoordinates, sql`${distance} <= ${NEARBY_RADIUS_KM}`))
    .orderBy(asc(distance), asc(organizations.displayName))
    .limit(RECEIVER_LIMIT);
  return rankNearby(
    rows.map((r) => ({ ...r, distanceKm: Number(r.distanceKm) })),
    RECEIVER_LIMIT,
  ).map((r) => receiverCard(r, distanceLabel(r.distanceKm)));
}

/**
 * The public directory's opted-in clinics near a COARSE point (0283's rule,
 * reused), nearest first, at most VET_LIMIT. A clinic's coordinates never
 * leave this function: only the coarse distance label does.
 */
export async function queryNearbyVets(
  point: GeoPoint,
  executor: Executor = db,
): Promise<NearbyOrgCard[]> {
  const distance = distanceKmSql(point);
  const rows = await executor
    .select({ ...orgCardColumns, distanceKm: distance })
    .from(organizations)
    .leftJoin(
      arLocalities,
      and(eq(arLocalities.id, organizations.localityId), isNull(arLocalities.removedAt)),
    )
    .where(
      and(
        publicDirectoryVisible(),
        eq(organizations.orgType, "clinic"),
        hasCoordinates,
        sql`${distance} <= ${NEARBY_RADIUS_KM}`,
      ),
    )
    .orderBy(asc(distance), asc(organizations.displayName))
    .limit(VET_LIMIT);
  return rankNearby(
    rows.map((r) => ({ ...r, distanceKm: Number(r.distanceKm) })),
    VET_LIMIT,
  ).map((r) => vetCard(r, distanceLabel(r.distanceKm)));
}

// ---------------------------------------------------------------------------
// The place — a catalogue locality, by id or nearest to a coarse point
// ---------------------------------------------------------------------------

export type HelpPlace = {
  localityId: string;
  provinceCode: string;
  provinceName: string | null;
  localityName: string;
  indecId: string | null;
  /** The centroid, coarse. Null when the catalogue row has none. */
  point: GeoPoint | null;
};

async function placeById(localityId: string, executor: Executor): Promise<HelpPlace | null> {
  const [row] = await executor
    .select({
      id: arLocalities.id,
      provinceCode: arLocalities.provinceCode,
      localityName: arLocalities.localityName,
      indecId: arLocalities.indecId,
      lat: sql<number | null>`round(${arLocalities.latitude}, 2)::float8`,
      lng: sql<number | null>`round(${arLocalities.longitude}, 2)::float8`,
    })
    .from(arLocalities)
    .where(and(eq(arLocalities.id, localityId), isNull(arLocalities.removedAt)))
    .limit(1);
  if (!row) return null;
  return {
    localityId: row.id,
    provinceCode: row.provinceCode,
    provinceName: provinceByCode(row.provinceCode)?.name ?? null,
    localityName: row.localityName,
    indecId: row.indecId,
    point:
      row.lat === null || row.lng === null ? null : { lat: Number(row.lat), lng: Number(row.lng) },
  };
}

/** A catalogue locality picked by the finder. Null when the id names none. */
export function readHelpPlaceById(
  localityId: string,
  executor: Executor = db,
): Promise<HelpPlace | null> {
  return placeById(localityId, executor);
}

/**
 * The catalogue locality nearest a COARSE point (for the empty state's cascade
 * and the /perdidas link). Same expression as lib/infra/ar-localidades.ts →
 * nearestLocalities, run on the caller's executor so the whole lookup stays
 * inside one read-only transaction in the no-writes test.
 */
export async function readHelpPlaceNear(
  point: GeoPoint,
  executor: Executor = db,
): Promise<HelpPlace | null> {
  const distance = sql<number>`(${KM_PER_DEGREE} * sqrt(
    power(${arLocalities.latitude}::float8 - ${point.lat}::float8, 2) +
    power((${arLocalities.longitude}::float8 - ${point.lng}::float8) * cos(radians(${point.lat}::float8)), 2)
  ))`;
  const [nearest] = await executor
    .select({ id: arLocalities.id })
    .from(arLocalities)
    .where(
      and(
        isNull(arLocalities.removedAt),
        sql`${arLocalities.latitude} IS NOT NULL`,
        sql`${arLocalities.longitude} IS NOT NULL`,
      ),
    )
    .orderBy(asc(distance))
    .limit(1);
  return nearest ? placeById(nearest.id, executor) : null;
}

// ---------------------------------------------------------------------------
// The empty state — the jurisdiction cascade
// ---------------------------------------------------------------------------

/**
 * An opted-in, verified municipal service for the place, at ANY distance:
 * its locality first, else its province. Null when there is none.
 */
export async function queryMunicipalService(
  place: HelpPlace,
  executor: Executor = db,
): Promise<NearbyOrgCard | null> {
  const base = and(listedReceiver(), eq(organizations.orgType, "sanitary_authority"));
  const select = () =>
    executor
      .select({ ...orgCardColumns, ...intakeCardColumns })
      .from(orgFoundAnimalIntake)
      .innerJoin(organizations, eq(organizations.id, orgFoundAnimalIntake.organizationId));

  const [inLocality] = await select()
    .where(and(base, eq(organizations.localityId, place.localityId)))
    .orderBy(asc(organizations.displayName))
    .limit(1);
  if (inLocality) return receiverCard(inLocality, "en tu localidad");

  if (!place.provinceName) return null;
  const [inProvince] = await select()
    .where(and(base, eq(organizations.jurisdictionProvince, place.provinceName)))
    .orderBy(asc(organizations.displayName))
    .limit(1);
  return inProvince ? receiverCard(inProvince, "en tu provincia") : null;
}

/**
 * The governing local government's NAME, from the official reference — never
 * a phone number nobody verified. Null when the reference has no answer (a
 * disputed or unmapped locality).
 */
export function localGovernmentName(place: HelpPlace): string | null {
  if (place.provinceCode === "AR-C") return CABA_CITY_NAME;
  if (!place.indecId) return null;
  if (OFFICIAL_LOCAL_GOVERNMENTS.disputed[place.indecId]) return null;
  const governmentId = OFFICIAL_LOCAL_GOVERNMENTS.localities[place.indecId];
  const government = governmentId ? OFFICIAL_LOCAL_GOVERNMENTS.governments[governmentId] : null;
  if (!government) return null;
  const [, category, name] = government;
  return `${category} de ${name}`;
}

// lib/org-census.ts — Shelter census & occupancy projection (Wave 3 Item 16)
//
// D2 (closed): Occupancy = pure projection over the event log.
// Count of ACTIVE shelter_custody ownership rows per species.
// Nothing is denormalized except the declared capacity (config, mutable — not an event).
//
// Usage:
//   const census = await fetchOrgCensus(organizationId);
//   const occupancy = computeOccupancyBreakdown(census, capacity);
//
// Item 17 (panel KPI "Ocupación") should import computeOccupancyBreakdown from here
// and pass the org's capacity columns.

import { and, count, eq, isNull } from "drizzle-orm";

// POOL: analyticsDb (session pooler), NOT the OLTP transaction pooler — these are
// read-only multi-statement dashboard aggregates. supavisor transaction mode (6543)
// has a measured >100x pathology for this fan-out shape (db/index.ts); session mode
// serves it normally. Locally analyticsDb falls back to DATABASE_URL (identical dev/test).
import { analyticsDb as db, ownerships, pets } from "@/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Count of animals per species currently under shelter_custody for an org. */
export type SpeciesCounts = {
  dogs: number;
  cats: number;
  other: number;
  total: number;
};

/** Declared per-species and total capacity (all nullable). */
export type OrgCapacity = {
  capacityDogs: number | null;
  capacityCats: number | null;
  capacityOther: number | null;
  capacityTotal: number | null;
};

/** Per-species occupancy with optional % when capacity is declared. */
export type SpeciesOccupancy = {
  count: number;
  /** Declared capacity for this slot, or null if not configured. */
  capacity: number | null;
  /** Occupancy % (0–100+), or null when capacity is not declared. */
  pct: number | null;
  /** True when count > capacity and capacity is declared. */
  overCapacity: boolean;
};

export type OccupancyBreakdown = {
  dogs: SpeciesOccupancy;
  cats: SpeciesOccupancy;
  other: SpeciesOccupancy;
  total: SpeciesOccupancy;
  /** True when ANY slot is over capacity. */
  anyOverCapacity: boolean;
  /** True when no capacity column is configured (all null). */
  noCapacityDeclared: boolean;
};

// ---------------------------------------------------------------------------
// Projection — active shelter_custody rows per species
// ---------------------------------------------------------------------------

/**
 * Count active shelter_custody ownerships per species for an organization.
 *
 * "Active" means ended_at IS NULL.
 * Only rows with owner_organization_id = organizationId are counted
 * (individual vecino-in-transit rows are scoped to owner_user_id, not org).
 */
export async function fetchOrgCensus(organizationId: string): Promise<SpeciesCounts> {
  // Query active shelter_custody rows for this org, grouped by species.
  const rows = await db
    .select({ species: pets.species, n: count() })
    .from(ownerships)
    .innerJoin(pets, eq(pets.id, ownerships.petId))
    .where(
      and(
        eq(ownerships.ownerOrganizationId, organizationId),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
        // Art. 16: erasure soft-deletes the pet but not the ownership rows —
        // an erased pet must not keep a seat in the census.
        isNull(pets.deletedAt),
      ),
    )
    .groupBy(pets.species);

  let dogs = 0;
  let cats = 0;
  let other = 0;

  for (const row of rows) {
    const n = Number(row.n);
    if (row.species === "dog") dogs += n;
    else if (row.species === "cat") cats += n;
    else other += n;
  }

  return { dogs, cats, other, total: dogs + cats + other };
}

// ---------------------------------------------------------------------------
// Compute occupancy breakdown (pure, no DB access)
// ---------------------------------------------------------------------------

function slotOccupancy(count: number, capacity: number | null): SpeciesOccupancy {
  if (capacity === null) {
    return { count, capacity: null, pct: null, overCapacity: false };
  }
  const pct = capacity > 0 ? Math.round((count / capacity) * 100) : 0;
  return { count, capacity, pct, overCapacity: count > capacity };
}

/**
 * Combine live census counts with declared capacity to produce the occupancy breakdown.
 * This is a pure function — useful for tests and for Item 17's panel KPI.
 */
export function computeOccupancyBreakdown(
  census: SpeciesCounts,
  capacity: OrgCapacity,
): OccupancyBreakdown {
  const dogs = slotOccupancy(census.dogs, capacity.capacityDogs);
  const cats = slotOccupancy(census.cats, capacity.capacityCats);
  const other = slotOccupancy(census.other, capacity.capacityOther);
  const total = slotOccupancy(census.total, capacity.capacityTotal);

  const noCapacityDeclared =
    capacity.capacityDogs === null &&
    capacity.capacityCats === null &&
    capacity.capacityOther === null &&
    capacity.capacityTotal === null;

  return {
    dogs,
    cats,
    other,
    total,
    anyOverCapacity:
      dogs.overCapacity || cats.overCapacity || other.overCapacity || total.overCapacity,
    noCapacityDeclared,
  };
}

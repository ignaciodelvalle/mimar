// Read-side helper for the §4.20 physical-tag-interest placeholder.
//
// The card on /mis-mascotas/[publicToken] needs to know whether THIS user
// already expressed interest in a physical QR tag for THIS pet. One row
// per (pet, user). The interest is "active" iff `cancelled_at IS NULL`.

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db, pets, physicalTagInterest } from "@/db";

export interface PhysicalTagInterestState {
  interested: boolean;
  /** Set when the user has an active (non-cancelled) row. */
  requestedAt: Date | null;
}

export async function getPhysicalTagInterest(
  petId: string,
  userId: string,
): Promise<PhysicalTagInterestState> {
  const [row] = await db
    .select({
      createdAt: physicalTagInterest.createdAt,
      cancelledAt: physicalTagInterest.cancelledAt,
    })
    .from(physicalTagInterest)
    .where(and(eq(physicalTagInterest.petId, petId), eq(physicalTagInterest.userId, userId)))
    .limit(1);
  if (!row || row.cancelledAt) {
    return { interested: false, requestedAt: null };
  }
  return { interested: true, requestedAt: row.createdAt };
}

// ---------------------------------------------------------------------------
// Ops read side — the half that was missing
// ---------------------------------------------------------------------------

/**
 * Active physical-tag interest, aggregated by the PET's jurisdiction.
 *
 * WHY THIS EXISTS (audit 2026-08-04). The sheet told owners "te avisamos cuando
 * estén disponibles" and the row it wrote was readable by exactly one query:
 * `getPhysicalTagInterest(petId, userId)` — a per-pet, per-user check that
 * answers "did YOU already ask?". Nothing could list who asked. The promise had
 * no mechanism behind it, the same shape as the shelter contact form whose
 * messages nobody could open (fixed the same day).
 *
 * Aggregated by jurisdiction rather than listed per person on purpose. The
 * decision this feeds is not "email these 40 people" — it is the manufacturer
 * and distribution call that blocks the physical-tag work (A1, D4/D5 in the
 * spec), and that call is made per municipality. Names would be PII on an
 * executive screen that does not need them; a count per locality is the
 * signal. When a channel actually opens somewhere, the per-locality rows are
 * the query you extend to reach those owners.
 *
 * Counts DISTINCT owners, not rows: one person with four pets is one customer
 * for a distribution decision, not four.
 */
export interface PhysicalTagDemandRow {
  province: string | null;
  locality: string | null;
  pets: number;
  owners: number;
  firstRequestedAt: Date | null;
}

export async function getPhysicalTagDemand(limit = 25): Promise<{
  rows: PhysicalTagDemandRow[];
  totalPets: number;
  totalOwners: number;
}> {
  const rows = await db
    .select({
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
      pets: sql<number>`count(*)::int`,
      owners: sql<number>`count(distinct ${physicalTagInterest.userId})::int`,
      firstRequestedAt: sql<Date | null>`min(${physicalTagInterest.createdAt})`,
    })
    .from(physicalTagInterest)
    .innerJoin(pets, eq(pets.id, physicalTagInterest.petId))
    .where(isNull(physicalTagInterest.cancelledAt))
    .groupBy(pets.jurisdictionProvince, pets.jurisdictionLocality)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  const [totals] = await db
    .select({
      totalPets: sql<number>`count(*)::int`,
      totalOwners: sql<number>`count(distinct ${physicalTagInterest.userId})::int`,
    })
    .from(physicalTagInterest)
    .where(isNull(physicalTagInterest.cancelledAt));

  return {
    rows,
    totalPets: totals?.totalPets ?? 0,
    totalOwners: totals?.totalOwners ?? 0,
  };
}

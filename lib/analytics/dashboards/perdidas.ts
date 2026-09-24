// Pérdidas (lost pets) dashboard fetchers — E3.
// Split out of lib/analytics/govt-dashboards.ts (engram refactor/govt-dashboards-split).

import { and, count, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import { analyticsDb as db, ownerships, petEvents, pets, profiles } from "@/db";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";
import { likeContains } from "@/lib/utils/like-helpers";
import { DAY_MS, petsScopeClause } from "./_scope";

export type LostPetRow = {
  petId: string;
  petPublicToken: string;
  petName: string;
  species: string;
  /** Current pet status. Used to show a status badge when displaying non-lost rows. */
  petStatus: string;
  province: string | null;
  locality: string | null;
  markedLostAt: Date | null;
  lastSeenLat: number | null;
  lastSeenLng: number | null;
  ownerDisplayName: string | null;
};

/** Valid values for the `status` filter. `null` / `undefined` defaults to `'lost'`. */
export const PET_STATUS_VALUES = ["active", "lost", "deceased"] as const;
export type PetStatusFilter = (typeof PET_STATUS_VALUES)[number] | "all";

/**
 * How long back "recovered" looks. Mirrors `recoveredMonth`'s own window so the
 * KPI and the list it drills into can never disagree about the period.
 */
export const RECOVERED_WINDOW_DAYS = 30;

/**
 * Selector for the /gob/perdidas list. A pet STATUS is not enough to express
 * "recovered": recovery is a TRANSITION (lost → active) that lives in the
 * spine, and `status='active'` matches every living animal that was never lost.
 * That is exactly what shipped — the tab labelled "Recuperadas" listed the
 * whole padrón (260 rows) beside a KPI reading 2 (live review 2026-07-28).
 */
export type PetListSelector = PetStatusFilter | "recovered";

/** The rows this dashboard will pull before it stops. See `fetchCap`. */
const LOST_PETS_FETCH_CAP = 500;

export async function fetchLostPets(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  filters: {
    since?: Date;
    species?: string;
    status?: PetListSelector | null;
    q?: string | null;
    /**
     * Admin province drill-down (mirrors fetchPerdidasMetrics). Only set when
     * actor.role === "admin" and a province was selected via the URL. Govt
     * callers must NOT pass this — their scope is already enforced by the
     * jurisdiction pairs applied below.
     */
    adminProvince?: string;
    adminLocality?: string;
    /**
     * THE FETCH CAP, INJECTABLE FOR ONE REASON: so the ordering can be probed.
     *
     * Mirrors `queryLostListing`'s `fetchCap`, and for the identical argument
     * (`__tests__/lost-listing-order-above-cap.test.ts`): reproducing an
     * unordered window at the real 500 needs 500+ pets AND 500+ spine events,
     * and `pet_events` cannot be torn down — the append-only trigger refuses,
     * so teardown would have to go through the audited mutation hatch and leave
     * 500 override rows in `audit_log` per run. The defect is about ORDERING,
     * which is indifferent to the constant, so it is probed at a handful.
     *
     * Production callers never pass it.
     */
    fetchCap?: number;
  } = {},
): Promise<LostPetRow[]> {
  // Default to 'lost' only — preserves backward-compat for metrics and
  // any other caller that omits the status filter.
  const statusFilter = filters.status ?? "lost";
  // "recovered" is EVENT-SOURCED, not a status: pets that went lost → active
  // inside the window. Built from the same predicate `recoveredMonth` uses
  // (`from_status='lost' AND to_status='active'`, see the KPI's own docblock)
  // so the count and this list can never describe different populations.
  //
  // A lost pet later marked `deceased` is a BAJA, not a recovery — the
  // to_status guard keeps it out, matching the PO decision behind the KPI
  // ("don't conflate the metric with its label", 2026-07-19).
  // ISO string + explicit ::timestamptz below. A bare Date inside a raw sql``
  // fragment reaches the driver untyped and fails at EXECUTION with
  // ERR_INVALID_ARG_TYPE — the same shape that bit the SLA CASE clause.
  const recoveredSince = new Date(Date.now() - RECOVERED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const conditions =
    statusFilter === "recovered"
      ? [
          sql`EXISTS (
            SELECT 1 FROM ${petEvents} rec
            WHERE rec.pet_id = ${pets.id}
              AND rec.event_type = 'status_changed'
              AND (rec.payload->>'from_status') = 'lost'
              AND (rec.payload->>'to_status') = 'active'
              AND rec.occurred_at >= ${recoveredSince.toISOString()}::timestamptz
          )`,
        ]
      : statusFilter === "all"
        ? [sql`${pets.status} IN ('active', 'lost', 'deceased')`]
        : [eq(pets.status, statusFilter)];
  if (filters.species) conditions.push(eq(pets.species, filters.species));

  // Govt scope filters on the pet's own jurisdiction columns. Pets without a
  // declared jurisdiction are excluded from the govt view (no way to scope-match)
  // but visible to admin. Admin has no assignments to narrow, so its URL
  // province/locality selection becomes the drill predicate instead — BOTH
  // resolved by the ONE shared helper (C3, ONE VIEWSCOPE).
  if (!hasNationalReadScope(actor.role) && jurisdictions.length === 0) return [];
  const petsScope = petsScopeClause(
    actor,
    jurisdictions,
    filters.adminProvince,
    filters.adminLocality,
  );
  if (petsScope) conditions.push(sql`(${petsScope})`);

  // Push `q` (text search) and `since` (lost-event window) into SQL so the
  // 500-row cap is applied AFTER filtering, not before. Previously the full
  // 500 rows were fetched and then reduced in JS — silently missing matches
  // that fell beyond the cap.
  //
  // `q` matches pets.name OR the active owner's displayName (ilike contains).
  // `since` requires a `status_changed → lost` event with occurredAt >= since.

  if (filters.since) {
    // Restrict to pets where the most recent "became lost" event is >= since.
    // Cast the Date to an ISO string so postgres.js serialises it correctly
    // inside the raw sql`` template (Drizzle operators handle Date natively,
    // but raw template parameters need explicit casting).
    const sinceIso = filters.since.toISOString();
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM pet_events pe_since
        WHERE pe_since.pet_id = ${pets.id}
          AND pe_since.event_type = 'status_changed'
          AND (pe_since.payload->>'to_status') = 'lost'
          AND pe_since.occurred_at >= ${sinceIso}::timestamptz
      )`,
    );
  }

  if (filters.q) {
    const pattern = likeContains(filters.q);
    // Match pet name or active owner's display name.
    // Use sql template for the OR to keep strict TypeScript happy (or() has an
    // undefined return when invoked with zero args; this variant always has two).
    // unaccent() on both column and pattern so "gonzalez" finds "González";
    // likeContains() already escapes % and _ (wildcard injection safe).
    conditions.push(
      sql`(
        unaccent(${pets.name}) ILIKE unaccent(${pattern}) ESCAPE '\'
        OR EXISTS (
          SELECT 1 FROM ownerships o_q
          JOIN profiles pr_q ON pr_q.id = o_q.owner_user_id
          WHERE o_q.pet_id = ${pets.id}
            AND o_q.role = 'owner'
            AND o_q.ended_at IS NULL
            AND unaccent(pr_q.display_name) ILIKE unaccent(${pattern}) ESCAPE '\'
        )
      )`,
    );
  }

  const baseRows = await db
    .select({
      petId: pets.id,
      petPublicToken: pets.publicToken,
      petName: pets.name,
      species: pets.species,
      petStatus: pets.status,
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
    })
    .from(pets)
    .where(and(...conditions))
    // A CAP WITHOUT AN ORDER IS NOT A TOP-500, IT IS AN ARBITRARY 500.
    //
    // This had `.limit(500)` and no `orderBy` since it was written. Postgres is
    // then free to return any five hundred matching rows, and it does: the plan
    // decides, so the same jurisdiction can answer with a different set of
    // animals on two consecutive loads, and a pet that went missing an hour ago
    // may simply not be on the page. On a screen a sanitary authority acts on,
    // "which five hundred" is not an implementation detail.
    //
    // Found on 2026-09-11 through `govt-dashboards.test.ts`, which passed alone
    // and failed inside the full suite once the local database had accumulated
    // more than 500 lost pets across runs — the seeded row fell outside the
    // arbitrary window. The flake was the symptom; this is the defect.
    //
    // `updatedAt` DESC, because the question this dashboard answers is "what is
    // happening now": a status change, a sighting or a jurisdiction move all
    // touch the row, so the most recently active cases surface first. `id` is
    // the tiebreaker, so the page is stable when timestamps collide — which
    // they do in seeds and in batch imports, the two places a wobbling list
    // would be noticed last.
    .orderBy(desc(pets.updatedAt), pets.id)
    .limit(filters.fetchCap ?? LOST_PETS_FETCH_CAP);

  if (baseRows.length === 0) return [];

  // Pull the latest status_changed → 'lost' event per pet to get markedLostAt
  // and last-seen coords (from the event row's location_point columns).
  const petIds = baseRows.map((r) => r.petId);
  const lostEvents = await db
    .select({
      petId: petEvents.petId,
      occurredAt: petEvents.occurredAt,
      locationLat: petEvents.locationLat,
      locationLng: petEvents.locationLng,
    })
    .from(petEvents)
    .where(
      and(
        inArray(petEvents.petId, petIds),
        eq(petEvents.eventType, "status_changed"),
        sql`(${petEvents.payload}->>'to_status') = 'lost'`,
      ),
    )
    .orderBy(desc(petEvents.occurredAt));

  const lostMetaByPet = new Map<
    string,
    { occurredAt: Date; locationLat: string | null; locationLng: string | null }
  >();
  for (const e of lostEvents) {
    if (!lostMetaByPet.has(e.petId)) {
      lostMetaByPet.set(e.petId, {
        occurredAt: e.occurredAt,
        locationLat: e.locationLat,
        locationLng: e.locationLng,
      });
    }
  }

  // Owner last-seen updates (fresh-review F5, QA 2026-08-03): "actualizar
  // última ubicación" appends an owner-authored note_added(kind='sighting')
  // event; the CURRENT pin for the map may live there, not on the
  // status_changed origin. Applied atomically per pet when the update is
  // newer than its latest mark-lost event (updates of a previous episode
  // necessarily predate it): the update's coords win even when it has none
  // (text-only update → the old pin no longer describes the current
  // last-seen record). Same semantics as fetchLostEpisodeForPet.
  const ownerUpdateRows = await db
    .select({
      petId: petEvents.petId,
      occurredAt: petEvents.occurredAt,
      locationLat: petEvents.locationLat,
      locationLng: petEvents.locationLng,
    })
    .from(petEvents)
    .where(
      and(
        inArray(petEvents.petId, petIds),
        eq(petEvents.eventType, "note_added"),
        eq(petEvents.authorRole, "owner"),
        sql`${petEvents.payload}->>'kind' = 'sighting'`,
        sql`(${petEvents.payload}->>'location_description' IS NOT NULL OR ${petEvents.locationLat} IS NOT NULL)`,
      ),
    )
    .orderBy(desc(petEvents.occurredAt));

  const ownerUpdateByPet = new Map<
    string,
    { occurredAt: Date; locationLat: string | null; locationLng: string | null }
  >();
  for (const e of ownerUpdateRows) {
    if (!ownerUpdateByPet.has(e.petId)) {
      ownerUpdateByPet.set(e.petId, {
        occurredAt: e.occurredAt,
        locationLat: e.locationLat,
        locationLng: e.locationLng,
      });
    }
  }

  // Resolve the active owner's display name via ownerships → profiles.
  const ownerMap = new Map<string, string>();
  const activeOwnerRows = await db
    .select({
      petId: ownerships.petId,
      ownerUserId: ownerships.ownerUserId,
      displayName: profiles.displayName,
    })
    .from(ownerships)
    .innerJoin(profiles, eq(profiles.id, ownerships.ownerUserId))
    .where(
      and(
        inArray(ownerships.petId, petIds),
        isNull(ownerships.endedAt),
        eq(ownerships.role, "owner"),
      ),
    );
  for (const r of activeOwnerRows) ownerMap.set(r.petId, r.displayName);

  // Both `q` and `since` are now pushed into SQL (see conditions above).
  // Sort by markedLostAt DESC so the most recently lost pets appear first.
  return baseRows
    .map((r): LostPetRow => {
      const meta = lostMetaByPet.get(r.petId);
      const update = ownerUpdateByPet.get(r.petId);
      // Current-episode owner update supersedes the origin coords atomically.
      const current =
        meta && update && update.occurredAt.getTime() >= meta.occurredAt.getTime() ? update : meta;
      return {
        petId: r.petId,
        petPublicToken: r.petPublicToken,
        petName: r.petName,
        species: r.species,
        petStatus: r.petStatus,
        province: r.province,
        locality: r.locality,
        markedLostAt: meta?.occurredAt ?? null,
        lastSeenLat: current?.locationLat ? Number(current.locationLat) : null,
        lastSeenLng: current?.locationLng ? Number(current.locationLng) : null,
        ownerDisplayName: ownerMap.get(r.petId) ?? null,
      };
    })
    .sort((a, b) => (b.markedLostAt?.getTime() ?? 0) - (a.markedLostAt?.getTime() ?? 0));
}

// ============================================================================
// Pérdidas metrics — E3
// ============================================================================

export type PerdidasMetrics = {
  /** Pets in scope currently in status='lost'. */
  activeCount: number;
  /**
   * Pets in scope that TRULY recovered — went from 'lost' back to 'active' —
   * in the last 30 days. Detected via `status_changed` events where payload
   * `from_status = 'lost'` and `to_status = 'active'` and the event was
   * recorded within 30d.
   *
   * Deliberately narrower than "any exit from lost": a lost pet later marked
   * `deceased` is a BAJA, not a recovery, and must not inflate this KPI (PO
   * decision — "don't conflate the metric with its label", 2026-07-19). In
   * practice this exclusion is currently a no-op for volume: every writer of
   * `status_changed` with `from_status='lost'` — setPetFound
   * (src/modules/events/application/lifecycle/set-pet-found-use-case.ts) and
   * owner-accept-return (src/modules/return-to-owner/application/owner-accept-return.ts)
   * — always pairs it with `to_status='active'`. Death is recorded via a
   * separate `death_recorded` event + direct `updateDeceased()` projection
   * write (src/modules/events/application/lifecycle/death-record-use-case.ts);
   * it never emits a `status_changed` event, so lost→deceased status_changed
   * rows do not occur today. The `to_status='active'` predicate below is a
   * forward-guard, not a fix for an observed inflation.
   *
   * Payload convention: `{ from_status: string, to_status: string, ... }`
   * Canonical source: lib/events/event-schemas.ts `statusChanged` + AGENTS.md §Events table.
   */
  recoveredMonth: number;
  /**
   * Average number of days currently-lost pets have been lost (now -
   * markedLostAt). Derived from the occurredAt of the pet's most recent
   * `status_changed` event where `to_status = 'lost'`. Returns 0 if there are
   * no active lost pets in scope.
   */
  avgDaysActive: number;
};

/**
 * Compute perdidas metrics using a pre-fetched LostPetRow array.
 *
 * `opts.lostPets` — pass ONLY when the array represents the UNFILTERED
 * in-scope lost pets (i.e. no q / since / species / non-default status
 * filters were applied). avgDaysActive is a population metric that must
 * reflect ALL currently-lost pets in scope, not just those matching the
 * current display filters. When any display filter is active, omit opts so
 * fetchPerdidasMetrics calls fetchLostPets() internally without filters,
 * accepting the extra DB round-trip as semantically required.
 *
 * activeCount and recoveredMonth are always computed via independent COUNT
 * queries; they are unaffected by opts.lostPets.
 *
 * KPI: not yet in lib/metrics/kpi-catalog.ts (no cross-surface label
 * ambiguity reported for "Pérdidas activas" — documented here directly).
 *   NUMERATOR (activeCount):    COUNT pets WHERE status = 'lost', in scope.
 *   NUMERATOR (recoveredMonth): COUNT status_changed events where
 *     payload.from_status='lost' AND payload.to_status='active' (true
 *     recovery only — excludes lost→deceased/other exits, which are BAJAS,
 *     not recoveries), trailing 30d.
 *   NUMERATOR (avgDaysActive):  average of (now − markedLostAt) over
 *     currently-lost pets, in days.
 *   DENOMINATOR: n/a for all three — absolute counts / an average, not ratios.
 *   SOURCE:      pets, pet_events (status_changed).
 *   CADENCE:     activeCount/avgDaysActive are "now" snapshots; recoveredMonth
 *                is trailing 30 days.
 *   SUPPRESSION: none.
 */
export async function fetchPerdidasMetrics(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  opts?: {
    lostPets?: LostPetRow[];
    /**
     * Count-only fast path (perf audit 2026-07-19 qw#6): return just `activeCount`
     * via a single COUNT, skipping fetchLostPets (≤500 rows, 3 queries) and the
     * recovered-count join. `recoveredMonth` / `avgDaysActive` come back 0. The
     * /gob home renders ONLY activeCount, so it opts in; /gob/perdidas does not.
     */
    countOnly?: boolean;
    /**
     * Admin province drill-down (Panorama). Only set when actor.role === "admin"
     * and a province was selected. Never set from govt page code.
     */
    adminProvince?: string;
    adminLocality?: string;
  },
): Promise<PerdidasMetrics> {
  const now = Date.now();
  const since30d = new Date(now - 30 * DAY_MS);
  const adminProvince = opts?.adminProvince;
  const adminLocality = opts?.adminLocality;

  // 1. Count active lost pets in scope.
  const activeConditions = [eq(pets.status, "lost")];
  // ONE pets-scope predicate — govt jurisdiction pairs OR the admin
  // province/locality drill. Reused for the recovered-count query below, so the
  // two numbers can never disagree about what "in scope" means.
  const petsScope = petsScopeClause(actor, jurisdictions, adminProvince, adminLocality);
  if (petsScope) activeConditions.push(sql`(${petsScope})`);

  // Count-only fast path (qw#6): the /gob home shows only activeCount. Serve it
  // with the single COUNT above and skip the recovered join + fetchLostPets.
  if (opts?.countOnly) {
    const [activeRows] = await db
      .select({ n: count() })
      .from(pets)
      .where(and(...activeConditions));
    return { activeCount: activeRows?.n ?? 0, recoveredMonth: 0, avgDaysActive: 0 };
  }

  // 2. Count `status_changed` events where `from_status = 'lost'` AND
  // `to_status = 'active'` within 30d in scope — a TRUE recovery. A lost pet
  // later marked deceased (or any other non-active exit) is a BAJA, not a
  // recovery, and must not be counted here (PO decision 2026-07-19). We
  // scope-match on the pet's own jurisdiction columns, not the event payload,
  // because status_changed events may not carry jurisdiction in their payload
  // (it is present in outbreak_signal but not status_changed).
  const recoveredConditions = [
    eq(petEvents.eventType, "status_changed"),
    sql`(${petEvents.payload}->>'from_status') = 'lost'`,
    sql`(${petEvents.payload}->>'to_status') = 'active'`,
    gte(petEvents.occurredAt, since30d),
  ];
  // Apply scope by joining to pets — the SAME petsScope predicate the active
  // count uses. The pets join is added below (needsRecoveredJoin).
  if (!hasNationalReadScope(actor.role) && jurisdictions.length === 0) {
    // No assignments — return zeros immediately.
    return { activeCount: 0, recoveredMonth: 0, avgDaysActive: 0 };
  }
  if (petsScope) recoveredConditions.push(sql`(${petsScope})`);

  // 3. Average days active: average of (now - occurredAt) for the most recent
  // `status_changed → lost` event per pet, for pets currently in status='lost'.
  // We compute this in JS using the per-pet markedLostAt timestamps from
  // fetchLostPets. If the caller already holds the lostPets array (e.g. /gob/perdidas
  // fetches it in parallel), pass it via opts.lostPets to avoid a redundant DB call.
  // The internal fetch carries the SAME admin drill this function received (C3,
  // ONE VIEWSCOPE). Before, it was called un-drilled and the province narrowing
  // happened in JS BELOW — but fetchLostPets caps at 500 rows, so an admin
  // drilled into a small province averaged over whatever slice of the NATIONAL
  // top-500 happened to fall in it, not over that province's lost pets.

  const lostPetsPromise =
    opts?.lostPets !== undefined
      ? Promise.resolve(opts.lostPets)
      : fetchLostPets(actor, jurisdictions, { adminProvince, adminLocality });

  // Whether to join the pets table for the recovered-count query.
  // Govt always joins (to apply jurisdiction pairs on pets columns).
  // Admin+province also needs the join to apply the province predicate.
  const needsRecoveredJoin = !hasNationalReadScope(actor.role) || !!adminProvince;

  const [activeRows, recoveredRows, lostPetsRaw] = await Promise.all([
    db
      .select({ n: count() })
      .from(pets)
      .where(and(...activeConditions)),
    needsRecoveredJoin
      ? db
          .select({ n: count() })
          .from(petEvents)
          .innerJoin(pets, eq(pets.id, petEvents.petId))
          .where(and(...recoveredConditions))
      : db
          .select({ n: count() })
          .from(petEvents)
          .where(and(...recoveredConditions)),
    lostPetsPromise,
  ]);

  // Defensive narrowing for a CALLER-SUPPLIED array (opts.lostPets), whose
  // provenance this function cannot verify. Idempotent for the internally
  // fetched rows above — those are already drilled in SQL.
  const lostPets =
    hasNationalReadScope(actor.role) && adminProvince
      ? lostPetsRaw.filter(
          (p) => p.province === adminProvince && (!adminLocality || p.locality === adminLocality),
        )
      : lostPetsRaw;

  const activeCount = activeRows[0]?.n ?? 0;
  const recoveredMonth = recoveredRows[0]?.n ?? 0;

  // Compute average days from markedLostAt for currently-lost pets.
  const withDate = lostPets.filter((p) => p.markedLostAt !== null);
  const avgDaysActive =
    withDate.length === 0
      ? 0
      : Math.round(
          withDate.reduce(
            (sum, p) => sum + (now - (p.markedLostAt?.getTime() ?? now)) / DAY_MS,
            0,
          ) / withDate.length,
        );

  return { activeCount, recoveredMonth, avgDaysActive };
}

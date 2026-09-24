// lib/outreach-pipelines.ts — Actionable outreach pipelines for /gob/outreach.
//
// Item 21 — "del dato a la acción": converts KPIs into target lists that
// government operators can export for contact campaigns.
//
// Three pipelines (v1):
//   (a) fetchOverdueRabiesVaccine   — pets with overdue antirrábica, by jurisdiction
//   (b) fetchStrayDensityAreas      — barrios with rising stray-scan density
//   (c) fetchSterilizationVetRanking — vets by sterilization throughput (recognition)
//
// PII contract (MANDATORY per spec):
//   Every call to the three fetch functions logs a pii_queried audit row via
//   logOutreachPiiQuery. These lists are OPERATIONAL (jurisdiction-scoped PII),
//   NOT k-anonymized public aggregates — distinct from Item 0–4 KPIs.
//   The export route also calls logOutreachPiiQuery with the export context.
//
// Scope model (identical to Pattern-B fetchers):
//   admin  → global (no WHERE restriction)
//   govt   → jurisdiction-scoped (province + locality pairs from govt_assignments)
//
// Note on SQL scope clauses: these fetchers use raw SQL with aliased tables
// (e.g. `pets p`). We build raw SQL scope clauses directly rather than using
// petsScopeClause() from lib/metrics/scope, which generates Drizzle qualified
// column references (e.g. "pets"."jurisdiction_province") that Postgres rejects
// when the table is aliased in raw SQL context.
//
// No schema changes — pure projection over existing events + pets tables.

import { sql } from "drizzle-orm";

import { auditLog, db } from "@/db";
import { amendedPayloadText } from "@/lib/infra/amendment-sql";
import type { ProjectionContext } from "@/lib/metrics";
import { seesSyntheticRows } from "@/lib/metrics/scope";

// ---------------------------------------------------------------------------
// PII audit log helper
// ---------------------------------------------------------------------------

/**
 * Write a mandatory pii_queried audit row on every outreach-pipeline list view.
 * surface is always "outreach_pipeline"; pipeline identifies which of the three
 * fetchers was called. Fire-and-forget — callers do not need to await.
 *
 * `zone` (PO decision 3, "Operativos geo-first", 2026-07-23): for the
 * overdue_rabies pipeline the Alcance screen now opens with locality
 * AGGREGATES (not row-level PII) and only reveals the named pet list after an
 * operator explicitly expands one zone — see aggregateOverdueByLocality below
 * and app/gob/outreach/AlcanceScreen.tsx. The audit row for that pipeline
 * fires on THAT expansion, not on the aggregate page load, and carries which
 * zone was expanded so the trail says WHERE the PII was viewed, not just how
 * many rows.
 */
export async function logOutreachPiiQuery(
  actorUserId: string,
  pipeline: "overdue_rabies" | "stray_density" | "sterilization_ranking",
  resultCount: number,
  zone?: { province: string | null; locality: string | null },
): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId,
    action: "pii_queried",
    payload: {
      surface: "outreach_pipeline",
      pipeline,
      result_count: resultCount,
      ...(zone ? { zone_province: zone.province, zone_locality: zone.locality } : {}),
    },
  });
}

/**
 * Write a mandatory audit row for the outreach "Enviar recordatorio(s)"
 * write action (lib/infra/outreach-reminders.ts) — the write-path companion
 * to logOutreachPiiQuery's read-path row. One row per invocation (single-row
 * "Recordar" or the bulk "Enviar recordatorios (N)"), never per notification,
 * mirroring the (actor, pipeline, count) shape the read-log already uses.
 */
export async function logOutreachReminderSent(
  actorUserId: string,
  pipeline: "overdue_rabies",
  counts: {
    requested: number;
    sent: number;
    alreadyNotified: number;
    // Required, not optional. This is the compliance record of a rabies
    // campaign, and a caller that forgets to pass the failures produces a row
    // asserting everyone was reached. A missing field would read as zero.
    deliveryFailed: number;
    noOwner: number;
    outOfScope: number;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId,
    action: "outreach_reminder_sent",
    payload: {
      surface: "outreach_pipeline",
      pipeline,
      requested_count: counts.requested,
      sent_count: counts.sent,
      already_notified_count: counts.alreadyNotified,
      delivery_failed_count: counts.deliveryFailed,
      no_owner_count: counts.noOwner,
      out_of_scope_count: counts.outOfScope,
    },
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Number of days after which a rabies vaccine is considered overdue. */
const RABIES_OVERDUE_DAYS = 365;

function overdueVaccineCutoff(): Date {
  return new Date(Date.now() - RABIES_OVERDUE_DAYS * 86400_000);
}

/**
 * Build a raw SQL jurisdiction scope clause for use in raw-SQL queries that
 * alias the pets table as `p`. Returns null for admin (no restriction) and
 * a false-literal fragment when there are no assigned jurisdictions (empty result).
 *
 * NOTE: We cannot reuse petsScopeClause() from lib/metrics because it generates
 * Drizzle ORM qualified column references ("pets"."jurisdiction_province") that
 * Postgres rejects when the table appears under a different alias.
 */
function rawPetsScopeClause(ctx: ProjectionContext): ReturnType<typeof sql> | null | false {
  const jurisdiction = rawPetsJurisdictionClause(ctx);
  if (jurisdiction === false) return false;
  // T1-P1: synthetic (seed-tagged) pets are never an outreach target for a
  // non-admin reader — the raw-SQL twin of syntheticRowExclusion.pets()
  // (lib/metrics/scope.ts), spelled against the `p` alias.
  if (seesSyntheticRows(ctx.actor.role)) return jurisdiction;
  const synthetic = sql`p.seed_tag IS NULL`;
  return jurisdiction ? sql`(${jurisdiction}) AND ${synthetic}` : synthetic;
}

function rawPetsJurisdictionClause(ctx: ProjectionContext): ReturnType<typeof sql> | null | false {
  if (ctx.scope.kind === "global") return null;
  const { jurisdictions } = ctx.scope;
  if (jurisdictions.length === 0) return false;
  const pairs = jurisdictions.map(
    (j) =>
      sql`(p.jurisdiction_province = ${j.province} AND p.jurisdiction_locality = ${j.locality})`,
  );
  // Join pairs with OR.
  let combined = pairs[0];
  for (let i = 1; i < pairs.length; i++) {
    combined = sql`${combined} OR ${pairs[i]}`;
  }
  return combined;
}

// ---------------------------------------------------------------------------
// (a) Overdue antirrábica — pipeline
// ---------------------------------------------------------------------------

export type OverdueRabiesPet = {
  petId: string;
  petName: string;
  species: string;
  /** Needed to deep-link the owner straight to the vaccine registration form
   * (outreach reminder action, lib/infra/outreach-reminders.ts). */
  publicToken: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  /** Date of the most recent antirrábica vaccination event. */
  lastVaccineAt: Date;
};

export type OverdueRabiesResult = {
  pets: OverdueRabiesPet[];
  /** True when no pets matched the criterion in the operator's jurisdiction. */
  empty: boolean;
};

/**
 * Fetch the list of active pets in scope whose most recent antirrábica
 * vaccination occurred more than RABIES_OVERDUE_DAYS days ago.
 *
 * Query strategy: CTE finds the latest vaccination_administered event per pet
 * where vaccine_name contains "antirr" (case-insensitive). Pets LEFT JOIN the
 * CTE — those with no matching vaccine row (never vaccinated) or whose latest
 * vaccine predates the cutoff are returned as overdue.
 *
 * `petIdsFilter` (outreach reminder action, lib/infra/outreach-reminders.ts):
 * when provided, narrows the result to exactly those pet ids AND re-applies
 * the SAME jurisdiction-scope + overdue-criteria WHERE clauses — this is the
 * server-side re-derivation the reminder action uses so it NEVER trusts a
 * client-supplied pet list; a petId that is out of the operator's
 * jurisdiction, or no longer actually overdue, simply will not come back.
 *
 * The caller must write a pii_queried audit row via logOutreachPiiQuery.
 */
export async function fetchOverdueRabiesVaccine(
  ctx: ProjectionContext,
  petIdsFilter?: string[],
): Promise<OverdueRabiesResult> {
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    return { pets: [], empty: true };
  }
  if (petIdsFilter && petIdsFilter.length === 0) {
    return { pets: [], empty: true };
  }

  const scopeClause = rawPetsScopeClause(ctx);
  if (scopeClause === false) return { pets: [], empty: true };

  // Pass dates as ISO strings — db.execute raw SQL uses postgres.js which
  // requires typed serialization; Date objects in raw tagged-template positions
  // must be pre-serialized when `prepare: false` is active.
  const cutoff = overdueVaccineCutoff().toISOString();

  const rows = await db.execute<{
    pet_id: string;
    pet_name: string;
    species: string;
    public_token: string;
    jurisdiction_province: string | null;
    jurisdiction_locality: string | null;
    last_vaccine_at: string | null;
  }>(sql`
    WITH latest_rabies AS (
      SELECT
        pe.pet_id,
        MAX(pe.occurred_at) AS last_vaccine_at
      FROM pet_events pe
      WHERE
        pe.event_type = 'vaccination_administered'
        AND lower(${amendedPayloadText("vaccine_name", { id: sql`pe.id`, payload: sql`pe.payload` })}) LIKE '%antirr%'
      GROUP BY pe.pet_id
    )
    SELECT
      p.id               AS pet_id,
      p.name             AS pet_name,
      p.species,
      p.public_token,
      p.jurisdiction_province,
      p.jurisdiction_locality,
      lr.last_vaccine_at
    FROM pets p
    LEFT JOIN latest_rabies lr ON lr.pet_id = p.id
    WHERE
      p.status = 'active'
      ${scopeClause ? sql`AND (${scopeClause})` : sql``}
      ${
        petIdsFilter
          ? sql`AND p.id IN (${sql.join(
              petIdsFilter.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql``
      }
      AND (
        lr.last_vaccine_at IS NULL
        OR lr.last_vaccine_at < ${cutoff}
      )
    ORDER BY lr.last_vaccine_at ASC NULLS FIRST, p.name ASC
    LIMIT 500
  `);

  const petsResult: OverdueRabiesPet[] = rows.map((r) => ({
    petId: r.pet_id,
    petName: r.pet_name,
    species: r.species,
    publicToken: r.public_token,
    jurisdictionProvince: r.jurisdiction_province,
    jurisdictionLocality: r.jurisdiction_locality,
    lastVaccineAt: r.last_vaccine_at ? new Date(r.last_vaccine_at) : new Date(0),
  }));

  return { pets: petsResult, empty: petsResult.length === 0 };
}

export type OverdueRabiesLocalityAggregate = {
  province: string | null;
  locality: string | null;
  count: number;
};

/**
 * Aggregate an already-fetched overdue-rabies pet list by (province,
 * locality) — PO decision 3, "Operativos geo-first" (2026-07-23): the
 * Alcance screen must open with WHERE-to-intervene aggregates, not a
 * named-row dump. Pure in-memory fold over the SAME single query
 * fetchOverdueRabiesVaccine already ran (capped at 500 rows there) — no
 * second DB round-trip; judged cheap enough given that row ceiling. Sorted
 * desc by count (largest backlog first). Pets with no recorded locality (or
 * no recorded province) group under the `null` key so no overdue pet is
 * silently dropped from the aggregate.
 */
export function aggregateOverdueByLocality(
  pets: readonly OverdueRabiesPet[],
): OverdueRabiesLocalityAggregate[] {
  const map = new Map<string, OverdueRabiesLocalityAggregate>();
  for (const pet of pets) {
    const key = `${pet.jurisdictionProvince ?? ""}_${pet.jurisdictionLocality ?? ""}`;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      map.set(key, {
        province: pet.jurisdictionProvince,
        locality: pet.jurisdictionLocality,
        count: 1,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// (b) Stray-scan density by locality — pipeline
// ---------------------------------------------------------------------------

export type StrayDensityArea = {
  /** Locality name (pets.jurisdiction_locality). */
  locality: string;
  province: string | null;
  /** Number of credential_scanned events from non-self-scans in the period. */
  scanCount: number;
};

export type StrayDensityResult = {
  areas: StrayDensityArea[];
  empty: boolean;
};

/**
 * Fetch localities with elevated stray-scan density.
 *
 * "Stray" scan proxy: credential_scanned events where
 *   payload->>'is_self_scan' = 'false'
 * grouped by the scanned pet's jurisdiction_locality.
 *
 * The period from the ProjectionContext is used as the scan window.
 * Jurisdiction scope narrows to the operator's assigned pairs.
 *
 * The caller must write a pii_queried audit row via logOutreachPiiQuery.
 */
export async function fetchStrayDensityAreas(ctx: ProjectionContext): Promise<StrayDensityResult> {
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    return { areas: [], empty: true };
  }

  const scopeClause = rawPetsScopeClause(ctx);
  if (scopeClause === false) return { areas: [], empty: true };

  const rows = await db.execute<{
    locality: string | null;
    province: string | null;
    scan_count: string;
  }>(sql`
    SELECT
      p.jurisdiction_locality AS locality,
      p.jurisdiction_province AS province,
      COUNT(*)                AS scan_count
    FROM pet_events pe
    JOIN pets p ON p.id = pe.pet_id
    WHERE
      pe.event_type = 'credential_scanned'
      AND (pe.payload->>'is_self_scan')::boolean = false
      AND pe.occurred_at >= ${ctx.period.since.toISOString()}
      AND pe.occurred_at <= ${ctx.period.until.toISOString()}
      ${scopeClause ? sql`AND (${scopeClause})` : sql``}
    GROUP BY p.jurisdiction_locality, p.jurisdiction_province
    HAVING COUNT(*) > 0
    ORDER BY COUNT(*) DESC
    LIMIT 100
  `);

  const areas: StrayDensityArea[] = rows
    .filter((r) => r.locality !== null)
    .map((r) => ({
      locality: r.locality as string,
      province: r.province,
      scanCount: Number(r.scan_count),
    }));

  return { areas, empty: areas.length === 0 };
}

// ---------------------------------------------------------------------------
// (c) Sterilization throughput ranking by vet — pipeline
// ---------------------------------------------------------------------------

export type SterilizationVetRank = {
  /** Vet label from sterilization_performed payload.performed_by (nullable). */
  vetLabel: string;
  /** Clinic from payload.clinic (nullable). */
  clinic: string | null;
  /** Count of sterilization events attributed to this vet in scope+period. */
  count: number;
};

export type SterilizationVetRankingResult = {
  /** Named vets only, ranked by throughput — never includes the unattributed bucket. */
  vets: SterilizationVetRank[];
  /**
   * Sterilizations with no performed_by on record. Excluded from `vets` —
   * this is a RECOGNITION ranking (screenshot review finding #11): an
   * unattributed bucket landing at #1 with a "top performer" star reads as
   * rewarding the absence of a name. Surface it as a footnote instead.
   */
  unattributedCount: number;
  /** True only when there are NO sterilizations at all (named + unattributed). */
  empty: boolean;
};

/**
 * Rank vets by sterilization throughput (recognition pipeline).
 *
 * Groups sterilization_performed events by the AMENDED performed_by and
 * clinic payload fields (amendedPayloadText — corrections apply), scoped to
 * the operator's jurisdiction and the period. Rows with no performed_by are
 * grouped under "(sin registrar)" in SQL, then split OUT of the ranked
 * `vets` list into `unattributedCount` (see SterilizationVetRankingResult).
 *
 * The caller must write a pii_queried audit row via logOutreachPiiQuery.
 */
export async function fetchSterilizationVetRanking(
  ctx: ProjectionContext,
): Promise<SterilizationVetRankingResult> {
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    return { vets: [], unattributedCount: 0, empty: true };
  }

  const scopeClause = rawPetsScopeClause(ctx);
  if (scopeClause === false) return { vets: [], unattributedCount: 0, empty: true };

  // sterilization_performed is amendable — read performed_by/clinic through
  // the SQL amendment overlay so a corrected vet name ranks under the
  // CORRECTED value, not the original typo (event-sourcing integrity review
  // 2026-07-04 item 4).
  const amendedPerformedBy = amendedPayloadText("performed_by", {
    id: sql`pe.id`,
    payload: sql`pe.payload`,
  });
  const amendedClinic = amendedPayloadText("clinic", {
    id: sql`pe.id`,
    payload: sql`pe.payload`,
  });

  const rows = await db.execute<{
    vet_label: string | null;
    clinic: string | null;
    event_count: string;
  }>(sql`
    SELECT
      COALESCE(${amendedPerformedBy}, '(sin registrar)') AS vet_label,
      ${amendedClinic}                                    AS clinic,
      COUNT(*)                                            AS event_count
    FROM pet_events pe
    JOIN pets p ON p.id = pe.pet_id
    WHERE
      pe.event_type = 'sterilization_performed'
      AND pe.occurred_at >= ${ctx.period.since.toISOString()}
      AND pe.occurred_at <= ${ctx.period.until.toISOString()}
      ${scopeClause ? sql`AND (${scopeClause})` : sql``}
    GROUP BY vet_label, clinic
    ORDER BY event_count DESC
    LIMIT 50
  `);

  const UNATTRIBUTED_LABEL = "(sin registrar)";
  const vets: SterilizationVetRank[] = [];
  let unattributedCount = 0;
  for (const r of rows) {
    const vetLabel = r.vet_label ?? UNATTRIBUTED_LABEL;
    const count = Number(r.event_count);
    if (vetLabel === UNATTRIBUTED_LABEL) {
      unattributedCount += count;
    } else {
      vets.push({ vetLabel, clinic: r.clinic ?? null, count });
    }
  }

  return { vets, unattributedCount, empty: vets.length === 0 && unattributedCount === 0 };
}

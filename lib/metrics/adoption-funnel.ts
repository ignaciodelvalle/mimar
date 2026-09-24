// lib/metrics/adoption-funnel.ts — adoption APPLICATION funnel.
//
// Surfaces the `adoption_application_submitted` + `adoption_application_resolved`
// events (previously reaching NO dashboard) as a submitted → resolved funnel with
// a conversion rate on /gob/adopciones. This is the DEMAND side of the pipeline
// (postulaciones online), distinct from fetchCustodyFunnel's SUPPLY side
// (intake → foster → adoption_finalized).
//
// `adoption_application_resolved` carries an outcome enum:
//   approved  — the shelter accepted the application
//   rejected  — the shelter (or the finalize-cascade) declined it
//   withdrawn — the applicant retracted their own pending application
//
// SCOPE: neither event carries a payload jurisdiction snapshot (only
// outbreak_signal does), so scope is by the pet's HOME jurisdiction via
// petsScopeClause against the pets JOIN — never petEventsScopeClause.

import { and, count, eq, gte, lte, sql } from "drizzle-orm";

import { analyticsDb as db, petEvents, pets } from "@/db";

import type { ProjectionContext } from "./context";
import { petsScopeClause } from "./scope";

/** True when a govt actor has no assigned jurisdictions — queries return zeros. */
function isEmptyScope(ctx: ProjectionContext): boolean {
  return ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0;
}

/**
 * Approval conversion: approved applications / submitted applications.
 * Returns null when nothing was submitted in the period (no meaningful rate,
 * never divide by zero). Can exceed nothing meaningful — both counts are
 * independent windowed flows (see the caveat on fetchAdoptionApplicationFunnel).
 */
export function approvalRate(approved: number, submitted: number): number | null {
  if (submitted === 0) return null;
  return approved / submitted;
}

export type AdoptionFunnelResult = {
  /** adoption_application_submitted events in the period + scope. */
  submitted: number;
  /** adoption_application_resolved events in the period + scope (any outcome). */
  resolved: number;
  /** Resolved with outcome='approved'. */
  approved: number;
  /** Resolved with outcome='rejected'. */
  rejected: number;
  /** Resolved with outcome='withdrawn'. */
  withdrawn: number;
  /** approved / submitted, or null when submitted=0. */
  conversionRate: number | null;
};

/**
 * KPI: adoption_application_conversion (see lib/metrics/kpi-catalog.ts)
 *
 * NUMERATOR:   COUNT adoption_application_submitted events in ctx.period; the
 *              resolved breakdown counts adoption_application_resolved events by
 *              payload.outcome (approved / rejected / withdrawn).
 * DENOMINATOR: conversionRate = approved / submitted (null when submitted=0).
 * SOURCE:      pets, pet_events (adoption_application_submitted,
 *              adoption_application_resolved).
 * CADENCE:     matches the caller's ProjectionContext period.
 * SUPPRESSION: none — jurisdiction-level totals, not locality-grouped.
 *
 * CAVEAT: submitted and resolved are INDEPENDENT windowed counts, not a followed
 * cohort — a resolution in-period may reference an application submitted before
 * the period started. Same shape as custody_return_rate.
 *
 * @param ctx - ProjectionContext (actor + scope + period).
 */
export async function fetchAdoptionApplicationFunnel(
  ctx: ProjectionContext,
  opts?: { species?: string },
): Promise<AdoptionFunnelResult> {
  const empty: AdoptionFunnelResult = {
    submitted: 0,
    resolved: 0,
    approved: 0,
    rejected: 0,
    withdrawn: 0,
    conversionRate: null,
  };
  if (isEmptyScope(ctx)) return empty;

  const scope = petsScopeClause(ctx);

  const submittedConditions = [
    eq(petEvents.eventType, "adoption_application_submitted"),
    gte(petEvents.occurredAt, ctx.period.since),
    lte(petEvents.occurredAt, ctx.period.until),
  ];
  if (scope) submittedConditions.push(sql`(${scope})`);
  if (opts?.species) submittedConditions.push(eq(pets.species, opts.species));

  const resolvedConditions = [
    eq(petEvents.eventType, "adoption_application_resolved"),
    gte(petEvents.occurredAt, ctx.period.since),
    lte(petEvents.occurredAt, ctx.period.until),
  ];
  if (scope) resolvedConditions.push(sql`(${scope})`);
  if (opts?.species) resolvedConditions.push(eq(pets.species, opts.species));

  const [submittedRows, resolvedRows] = await Promise.all([
    db
      .select({ n: count() })
      .from(petEvents)
      .innerJoin(pets, eq(pets.id, petEvents.petId))
      .where(and(...submittedConditions)),

    // Single pass: total resolved + per-outcome sub-counts via conditional aggregation.
    db
      .select({
        total: count(),
        approved:
          sql<number>`count(*) filter (where (${petEvents.payload}->>'outcome') = 'approved')`.mapWith(
            Number,
          ),
        rejected:
          sql<number>`count(*) filter (where (${petEvents.payload}->>'outcome') = 'rejected')`.mapWith(
            Number,
          ),
        withdrawn:
          sql<number>`count(*) filter (where (${petEvents.payload}->>'outcome') = 'withdrawn')`.mapWith(
            Number,
          ),
      })
      .from(petEvents)
      .innerJoin(pets, eq(pets.id, petEvents.petId))
      .where(and(...resolvedConditions)),
  ]);

  const submitted = submittedRows[0]?.n ?? 0;
  const resolvedRow = resolvedRows[0];
  const approved = resolvedRow?.approved ?? 0;

  return {
    submitted,
    resolved: resolvedRow?.total ?? 0,
    approved,
    rejected: resolvedRow?.rejected ?? 0,
    withdrawn: resolvedRow?.withdrawn ?? 0,
    conversionRate: approvalRate(approved, submitted),
  };
}

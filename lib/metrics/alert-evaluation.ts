// lib/metrics/alert-evaluation.ts — Threshold alert evaluation for /admin/programa.
//
// Pure helper:
//   isBreaching(currentValue, direction, threshold) → boolean
//     null currentValue → false (no data → not breaching)
//     'above' → value > threshold
//     'below' → value < threshold
//     boundary (value === threshold) → not breaching
//
// DB-bound evaluator:
//   evaluateAlertSubscriptions(userId, baseActor, callerJurisdictions)
//     → EvaluatedSubscription[]
//     Loads is_active subscriptions for userId, fetches current metric values,
//     scopes each subscription to ITS OWN jurisdiction — intersected with the
//     caller's own mandate when the caller is not national-scope (govt) —
//     and dedupes metric fetches by (metricKey, province, locality).
//
// Metric registry:
//   active_zoonosis            → fetchActiveZoonosis(ctx).count
//   eno_sla_ontime_pct         → fetchEnoSla(ctx).onTimePct (null-safe)
//   queue_oldest_days          → fetchQueueHealth().oldestPendingDaysAgo (ALWAYS GLOBAL)
//   sterilization_coverage_pct → fetchSterilizationCoverage(ctx).rate
//   microchip_penetration_pct  → fetchMicrochipPenetration(ctx).ratePct
//   open_welfare_reports       → fetchOpenWelfareReportsCount(ctx).count
//
// NOTE — queue_oldest_days global caveat:
//   The approval queue has no jurisdiction dimension. The jurisdiction_province /
//   jurisdiction_locality fields on the subscription are IGNORED for this metric.
//   The metric is always fetched with a global (admin) context. This is documented
//   here and in the UI form label.

import { and, eq } from "drizzle-orm";

import { type AlertSubscription, alertSubscriptions, db } from "@/db";
import { fetchQueueHealth } from "@/lib/analytics/admin-metrics";
import { fetchMicrochipPenetration } from "@/lib/analytics/compliance-metrics";
import { fetchActiveZoonosis, fetchOpenWelfareReportsCount } from "@/lib/analytics/govt-home-kpis";
import { fetchEnoSla } from "@/lib/analytics/surveillance-metrics";
import {
  hasNationalReadScope,
  isWholeProvinceLocality,
  jurisdictionScopeContains,
} from "@/lib/domain/jurisdiction-canonical";
import { buildProjectionContext, windows } from "@/lib/metrics";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";
import { fetchSterilizationCoverage } from "@/lib/metrics/population-control";

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

/**
 * Returns true when the subscription threshold is breached.
 *
 * Null currentValue → false (no data means we cannot assert a breach).
 * Boundary (value === threshold) → not breaching (strict inequality only).
 */
export function isBreaching(
  currentValue: number | null,
  direction: "above" | "below",
  threshold: number,
): boolean {
  if (currentValue === null) return false;
  if (direction === "above") return currentValue > threshold;
  return currentValue < threshold;
}

// active_zoonosis + open_welfare_reports reuse the canonical fetchers from
// lib/govt-home-kpis (same numbers the /gob dashboard shows) — see the switch below.

// ---------------------------------------------------------------------------
// Evaluated subscription type
// ---------------------------------------------------------------------------

export type EvaluatedSubscription = AlertSubscription & {
  /** Current metric value (null = no data available). */
  currentValue: number | null;
  /** True when the current value breaches the threshold. */
  breaching: boolean;
};

// ---------------------------------------------------------------------------
// Dedup key type for metric cache
// ---------------------------------------------------------------------------

type MetricCacheKey = string; // `${metricKey}::${province ?? ""}::${locality ?? ""}`

function makeCacheKey(
  metricKey: string,
  province: string | null | undefined,
  locality: string | null | undefined,
): MetricCacheKey {
  // queue_oldest_days is always global — ignore jurisdiction for its cache key.
  if (metricKey === "queue_oldest_days") return "queue_oldest_days::global";
  return `${metricKey}::${province ?? ""}::${locality ?? ""}`;
}

// ---------------------------------------------------------------------------
// Caller-scope intersection (A10-G2)
// ---------------------------------------------------------------------------

/**
 * The jurisdictions a NON-national caller may see for one subscription: the
 * subscription's pair intersected with the caller's own mandate.
 *
 *   - national subscription (no province) → the caller's whole mandate;
 *   - pair inside one of the caller's assignments → exactly that pair;
 *   - whole-province pair over a caller holding barrios of that province →
 *     those barrios (the part of the province the caller governs);
 *   - anything else → [] (nothing — the caller evaluates no data).
 *
 * Exported for tests.
 */
export function intersectWithCallerScope(
  subProvince: string | null | undefined,
  subLocality: string | null | undefined,
  callerJurisdictions: readonly DashboardJurisdiction[],
): DashboardJurisdiction[] {
  if (!subProvince) return [...callerJurisdictions];
  const locality = subLocality ?? "";
  if (jurisdictionScopeContains(callerJurisdictions, subProvince, locality)) {
    return [{ province: subProvince, locality }];
  }
  if (isWholeProvinceLocality(subProvince, locality)) {
    return callerJurisdictions.filter((j) => j.province === subProvince);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

/**
 * Load a user's active alert subscriptions, fetch current metric values
 * (scoped per subscription), and return evaluated rows.
 *
 * @param userId    - The auth user id (resolved by the page from auth, NOT from actor).
 * @param baseActor - The actor to use for projection (typically { role: "admin" }).
 * @param callerJurisdictions - The caller's OWN active assignments. Consulted
 *   only for a non-national-scope actor (govt): each subscription's pair is
 *   intersected with it, so a govt never evaluates outside its mandate. A
 *   govt passing none evaluates nothing (fail closed).
 */
export async function evaluateAlertSubscriptions(
  userId: string,
  baseActor: DashboardActor,
  callerJurisdictions: readonly DashboardJurisdiction[] = [],
): Promise<EvaluatedSubscription[]> {
  const nationalCaller = hasNationalReadScope(baseActor.role);
  // 1. Load active subscriptions for this user.
  const subs = await db
    .select()
    .from(alertSubscriptions)
    .where(and(eq(alertSubscriptions.actorUserId, userId), eq(alertSubscriptions.isActive, true)));

  if (subs.length === 0) return [];

  const period = windows.trailing12m();

  // 2. Dedupe metric fetches: build a map of (metricKey, province, locality) → Promise<number|null>.
  const fetchCache = new Map<MetricCacheKey, Promise<number | null>>();

  for (const sub of subs) {
    const key = makeCacheKey(sub.metricKey, sub.jurisdictionProvince, sub.jurisdictionLocality);
    if (fetchCache.has(key)) continue;

    // Build a ProjectionContext scoped to this subscription's jurisdiction.
    //
    // National-scope actor (admin | national): buildProjectionScope DISCARDS
    // the jurisdictions array (global scope), so the subscription's pair must
    // travel on the admin drill-down channel (adminProvince/adminLocality),
    // which every fetcher honors — numbers-that-lie audit 2026-08-01: without
    // it every provincial subscription evaluated the NATIONAL value under its
    // provincial label.
    //
    // Govt actor (A10-G2): scope.kind is "jurisdictions" and the drill-down
    // channel is ignored, so the jurisdictions array IS the scope. It used to
    // be the subscription's own pair, i.e. a govt evaluated wherever its
    // subscription pointed. Now it is that pair intersected with the caller's
    // own assignments; an empty intersection evaluates to "no data".
    let ctx: ReturnType<typeof buildProjectionContext> | null;
    if (nationalCaller) {
      const jurisdictions: DashboardJurisdiction[] = sub.jurisdictionProvince
        ? [{ province: sub.jurisdictionProvince, locality: sub.jurisdictionLocality ?? "" }]
        : [];
      ctx = buildProjectionContext(
        baseActor,
        jurisdictions,
        period,
        sub.jurisdictionProvince
          ? {
              adminProvince: sub.jurisdictionProvince,
              adminLocality: sub.jurisdictionLocality ?? undefined,
            }
          : undefined,
      );
    } else {
      const scoped = intersectWithCallerScope(
        sub.jurisdictionProvince,
        sub.jurisdictionLocality,
        callerJurisdictions,
      );
      ctx = scoped.length > 0 ? buildProjectionContext(baseActor, scoped, period) : null;
    }

    if (ctx === null) {
      fetchCache.set(key, Promise.resolve(null));
      continue;
    }

    let promise: Promise<number | null>;

    switch (sub.metricKey) {
      case "active_zoonosis":
        promise = fetchActiveZoonosis(ctx).then((r) => r.count);
        break;

      case "eno_sla_ontime_pct":
        promise = fetchEnoSla(ctx).then((r) => r.onTimePct);
        break;

      case "queue_oldest_days":
        // ALWAYS GLOBAL — province filter is ignored for this metric.
        promise = fetchQueueHealth().then((r) => r.oldestPendingDaysAgo);
        break;

      case "sterilization_coverage_pct":
        promise = fetchSterilizationCoverage(ctx).then((r) => r.rate);
        break;

      case "microchip_penetration_pct":
        promise = fetchMicrochipPenetration(ctx).then((r) => r.ratePct);
        break;

      case "open_welfare_reports":
        promise = fetchOpenWelfareReportsCount(ctx).then((r) => r.count);
        break;

      default: {
        // Exhaustive type guard — TypeScript will flag unhandled metric keys.
        const _exhaustive: never = sub.metricKey;
        promise = Promise.resolve(null);
        void _exhaustive;
        break;
      }
    }

    fetchCache.set(key, promise);
  }

  // 3. Await all cached promises in parallel.
  const resolvedCache = new Map<MetricCacheKey, number | null>();
  await Promise.all(
    Array.from(fetchCache.entries()).map(async ([k, p]) => {
      resolvedCache.set(k, await p);
    }),
  );

  // 4. Map subscriptions to evaluated rows.
  return subs.map((sub) => {
    const key = makeCacheKey(sub.metricKey, sub.jurisdictionProvince, sub.jurisdictionLocality);
    const currentValue = resolvedCache.get(key) ?? null;
    const breaching = isBreaching(
      currentValue,
      sub.direction as "above" | "below",
      Number(sub.threshold),
    );
    return { ...sub, currentValue, breaching };
  });
}

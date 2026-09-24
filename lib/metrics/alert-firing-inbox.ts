// lib/metrics/alert-firing-inbox.ts — read model + PII audit for /admin/alertas.
//
// fetchAlertFirings(filters) loads alert_firings rows for the inbox, applying
// the status / metric / jurisdiction / date-range filters. logAlertInboxView
// writes the mandatory pii_queried audit row (surface: "alert_inbox") per list
// view — same contract as the outreach + event-ledger surfaces, no enum change.

import { and, count, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import {
  type AlertFiring,
  type AlertFiringStatus,
  type AlertMetricKey,
  alertFirings,
  auditLog,
  db,
} from "@/db";

export type AlertInboxFilters = {
  status?: AlertFiringStatus | "open" | "all";
  metricKey?: AlertMetricKey;
  province?: string;
  /** Inclusive lower bound on fired_at (ISO date). */
  from?: string;
  /** Inclusive upper bound on fired_at (ISO date). */
  to?: string;
};

const OPEN_STATUSES: AlertFiringStatus[] = [
  "disparada",
  "reconocida",
  "en_investigacion",
  "autoridad_contactada",
];

/**
 * Load inbox rows newest-first, capped at 500. Status defaults to "open" (the
 * non-terminal set) so the inbox shows actionable alerts unless "all" or a
 * specific status is requested.
 */
export async function fetchAlertFirings(filters: AlertInboxFilters = {}): Promise<AlertFiring[]> {
  const conditions = [];

  const status = filters.status ?? "open";
  if (status === "open") {
    conditions.push(inArray(alertFirings.status, OPEN_STATUSES));
  } else if (status !== "all") {
    conditions.push(eq(alertFirings.status, status));
  }

  if (filters.metricKey) {
    conditions.push(eq(alertFirings.metricKey, filters.metricKey));
  }
  if (filters.province) {
    conditions.push(eq(alertFirings.jurisdictionProvince, filters.province));
  }
  if (filters.from) {
    conditions.push(gte(alertFirings.firedAt, new Date(filters.from)));
  }
  if (filters.to) {
    // Make the upper bound inclusive of the whole day.
    const end = new Date(filters.to);
    end.setHours(23, 59, 59, 999);
    conditions.push(lte(alertFirings.firedAt, end));
  }

  return db
    .select()
    .from(alertFirings)
    .where(conditions.length > 0 ? and(...conditions) : sql`true`)
    .orderBy(desc(alertFirings.firedAt))
    .limit(500);
}

/**
 * Count OPEN alert firings (status NOT IN resuelta/descartada) for the admin
 * rail badge — mirrors the outbox breach-badge pattern. Zero work beyond a
 * single indexed COUNT over (status, fired_at).
 */
export async function countOpenAlertFirings(): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(alertFirings)
    .where(inArray(alertFirings.status, OPEN_STATUSES));
  return Number(row?.n ?? 0);
}

/**
 * Mandatory pii_queried audit row on every inbox list view. surface is always
 * "alert_inbox"; the applied filters + result count answer "who looked at the
 * alert inbox, with what scope". Fire-and-forget — callers need not await.
 */
export async function logAlertInboxView(
  actorUserId: string,
  filters: AlertInboxFilters,
  resultCount: number,
  surface = "alert_inbox",
): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId,
    action: "pii_queried",
    payload: {
      surface,
      filters: {
        status: filters.status ?? "open",
        metric_key: filters.metricKey ?? null,
        province: filters.province ?? null,
        from: filters.from ?? null,
        to: filters.to ?? null,
      },
      result_count: resultCount,
    },
  });
}

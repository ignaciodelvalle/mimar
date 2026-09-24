// Server-only: this module queries the DB. A client import is a hard build error.
import "server-only";

// lib/metrics/novedades-feed.ts — "Novedades" operator-orientation feed.
//
// Session-start orientation on the /gob + /admin operator HOMEs: "esto cambió
// en tu jurisdicción desde tu última visita" (viz-suite Wave 1, plan
// dim-interno:docs/plans/viz-suite.md — "Novedades"). A compact, ledger-style projection
// over pet_events, filtered to the feed-relevant, operator-actionable event
// types, newest-first (by transaction time), above a per-user watermark.
//
// READ-ONLY. NO schema beyond the watermark table (migration 0143), NO new
// event types. The feed READS the append-only log; NOTHING here mutates
// pet_events. The watermark is per-user UI state, advanced only by an explicit
// user action (see app/actions/novedades.ts) — never on render.
//
// REUSE
// -----
//   - petsScopeClause(ctx) — jurisdiction scope by the pet's HOME jurisdiction,
//     THE single source of truth for scope SQL (lib/metrics/scope.ts). The SAME
//     helper the /admin/libro event-ledger and every govt dashboard route
//     through: admin → null (universal); govt → OR of pets.jurisdiction_* pairs.
//     Applied against the pets INNER JOIN. Because the feed spans multiple event
//     types it CANNOT use petEventsScopeClause (payload snapshot) — that matches
//     only outbreak_signal rows and would hide every other type from a scoped
//     govt viewer (the ghost-payload bug). Scoping by the pet's CURRENT
//     jurisdiction also closes the payload-drift hole (scope-security review
//     2026-07-04 A1), exactly as fetchEventLedger does.
//   - The composite (event_type, recorded_at) index (migration 0142) serves the
//     type-filtered, recorded_at-ordered scan: event_type IN (...) AND
//     recorded_at > watermark ORDER BY recorded_at DESC.
//
// PII GATING
// ----------
//   Feed rows carry NO owner-personal data and NOT EVEN the pet's public token —
//   only the coarse jurisdiction (province/locality, the same columns the home
//   KPI tiles already expose), the event-type, and the transaction time. The
//   per-item link routes to the operator's QUEUE by event type (not to a pet),
//   where the queue's own authz surfaces the item. This keeps the feed strictly
//   orientation-level (event-type label + jurisdiction + relative time), so —
//   unlike fetchEventLedger, which surfaces the public token — it writes NO
//   pii_queried audit row (it is home chrome, not a PII drill-down).

import { and, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";

import { db, operatorFeedWatermarks, petEvents, pets } from "@/db";
import type { EventType } from "@/db/schema";

import type { ProjectionContext } from "./context";
import { petsScopeClause } from "./scope";

// ---------------------------------------------------------------------------
// Feed-relevant event types + their operator queue route
// ---------------------------------------------------------------------------

/**
 * The event-type set + queue routing live in novedades-feed-links.ts (client-
 * safe — NovedadesCard needs feedQueueHref and this module is server-only).
 * Re-exported here so server callers keep their existing import path.
 *
 * Inclusion/exclusion rationale for FEED_EVENT_TYPES:
 *   - Surveillance / zoonosis → /gob/vigilancia
 *       outbreak_signal, disease_reported, rabies_observation_started
 *       (the three signals the /gob/vigilancia KPIs already read), plus
 *       incident_reported (bites/attacks — the mordeduras queue).
 *   - Custody governance → /gob/casos?expediente=disputas (F6 fusion, 2026-07-22)
 *       custody_dispute_raised (the disputes the Casos hub's Disputas tab works).
 *
 * Deliberately EXCLUDED (grounded in reality, not the plan's example list):
 *   - denuncias/welfare live in a SEPARATE table (welfare_reports), not
 *     pet_events, so they cannot come from this keyset scan.
 *   - custody_transfer_proposed is an owner-facing return handshake with no
 *     dedicated gob operator queue to route to.
 */
export {
  FEED_EVENT_TYPES,
  type FeedEventType,
  type FeedDestinationCapability,
  feedQueueHref,
  feedDestinationCapability,
  feedDestinationLabel,
  feedGroupLabel,
} from "./novedades-feed-links";

import { FEED_EVENT_TYPES, type FeedEventType } from "./novedades-feed-links";

/** First-visit fallback: with no watermark, show the last 7 days. */
export const FIRST_VISIT_WINDOW_DAYS = 7;
/** Compact feed — a session-start glance, not a browsable list. */
export const DEFAULT_NOVEDADES_LIMIT = 20;
/**
 * Grouped feed (home): distinct (type, locality) buckets. A session-start
 * glance, so a small cap — a jurisdiction rarely has more than a handful of
 * active type/locality combinations at once.
 */
export const DEFAULT_NOVEDADES_GROUP_LIMIT = 12;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NovedadesFeedRow = {
  /** pet_events.id — stable React key + keyset tiebreak. Not PII. */
  id: string;
  eventType: FeedEventType;
  /** Transaction time — when the system recorded the event. */
  recordedAt: Date;
  /** Coarse jurisdiction (pet HOME), same columns the home KPIs expose. */
  province: string | null;
  locality: string | null;
};

export type NovedadesFeed = {
  rows: NovedadesFeedRow[];
  /** true when filtered by an explicit watermark; false on the first-visit fallback. */
  sinceWatermark: boolean;
  /** The lower bound actually applied (the watermark, or now − 7d on first visit). */
  windowStart: Date;
};

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Fetch the feed for an EXPLICIT watermark (null = first visit → last 7 days).
 *
 * Ordering is (recorded_at DESC, id DESC) — newest transaction time first, id as
 * a stable tiebreak on equal timestamps. The watermark bound is STRICTLY
 * greater-than (an event AT the watermark instant was already acknowledged);
 * the first-visit fallback is inclusive (>=) on the now − 7d window start.
 *
 * @param ctx  - ProjectionContext (admin → global; govt → jurisdiction OR pairs).
 * @param opts - watermark (null = first visit) + optional page size.
 */
export async function fetchNovedadesFeedRows(
  ctx: ProjectionContext,
  opts: { watermark: Date | null; limit?: number } = { watermark: null },
): Promise<NovedadesFeed> {
  const limit = opts.limit ?? DEFAULT_NOVEDADES_LIMIT;
  const sinceWatermark = opts.watermark !== null;
  const windowStart =
    opts.watermark ?? new Date(Date.now() - FIRST_VISIT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Govt with zero jurisdictions → empty (petsScopeClause is sql`false`; we
  // short-circuit to skip a pointless query, matching fetchEventLedger).
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    return { rows: [], sinceWatermark, windowStart };
  }

  const conditions = [
    inArray(petEvents.eventType, FEED_EVENT_TYPES as unknown as EventType[]),
    // Strictly-greater on an explicit watermark; inclusive on the 7-day fallback.
    sinceWatermark ? gt(petEvents.recordedAt, windowStart) : gte(petEvents.recordedAt, windowStart),
  ];

  // Jurisdiction scope by the pet's HOME jurisdiction (see module header). Admin
  // → null (universal); govt → OR of pets.jurisdiction_* pairs.
  const scope = petsScopeClause(ctx);
  if (scope) conditions.push(sql`(${scope})`);

  const raw = await db
    .select({
      id: petEvents.id,
      eventType: petEvents.eventType,
      recordedAt: petEvents.recordedAt,
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...conditions))
    .orderBy(desc(petEvents.recordedAt), desc(petEvents.id))
    .limit(limit);

  const rows: NovedadesFeedRow[] = raw.map((r) => ({
    id: r.id,
    eventType: r.eventType as FeedEventType,
    recordedAt: r.recordedAt,
    province: r.province,
    locality: r.locality,
  }));

  return { rows, sinceWatermark, windowStart };
}

// ---------------------------------------------------------------------------
// Grouped feed (home) — Cowork M2
// ---------------------------------------------------------------------------
//
// The row-level feed showed 20 indistinguishable rows ("Incidente reportado /
// Tucumán / hace 5 días" x20) plus a visible duplicate. The home HOMEs render
// this GROUPED projection instead: one row per (event_type, province, locality)
// with a distinct-subject count. Two fixes in one query:
//   (a) dedup identical entries — COUNT(DISTINCT pet_id) counts each affected
//       pet once, so a re-inserted duplicate event does not inflate the tally.
//   (b) group same-type + same-locality items — GROUP BY (type, province,
//       locality) collapses the 20 rows into one countable row.
// The row-level fetcher above is UNCHANGED (its watermark/order/limit semantics
// are pinned by novedades-feed.test.ts and consumed elsewhere).

export type NovedadesFeedGroup = {
  /** Stable React key — composed from type + province + locality. */
  key: string;
  eventType: FeedEventType;
  province: string | null;
  locality: string | null;
  /** Distinct affected subjects (pets) in this type/locality bucket. */
  count: number;
  /** Newest recorded_at across the group — drives ordering + relative time. */
  latestRecordedAt: Date;
};

export type NovedadesGroupedFeed = {
  groups: NovedadesFeedGroup[];
  /** true when filtered by an explicit watermark; false on the first-visit fallback. */
  sinceWatermark: boolean;
  /** The lower bound actually applied (the watermark, or now − 7d on first visit). */
  windowStart: Date;
  /**
   * H17 (external red-team 2026-07-30) — WHICH emptiness an empty `groups` is.
   *
   * A govt actor with zero jurisdictions in scope short-circuits below without
   * ever running the query, and used to return the SAME `{ groups: [] }` as a
   * jurisdiction that was queried and genuinely had no events. The card then
   * said "Sin novedades en los últimos 7 días." — a claim about the world made
   * by a screen that never looked at it. Same lie class as the briefing's
   * blanket "dentro de rango" (see lib/metrics/briefing-alerts.ts's
   * BriefingCoverage, 2026-07-31): the fix is to carry the reason, not to
   * invent copy at the render site.
   *
   * true = nothing was queried (no scope). false = queried, answer was empty.
   */
  scopeEmpty: boolean;
};

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string);
}

/**
 * Grouped feed for an EXPLICIT watermark (null = first visit → last 7 days).
 * Groups by (event_type, province, locality); counts DISTINCT pets; orders by
 * the group's newest recorded_at DESC; caps the number of groups.
 */
export async function fetchNovedadesGroups(
  ctx: ProjectionContext,
  opts: { watermark: Date | null; limit?: number } = { watermark: null },
): Promise<NovedadesGroupedFeed> {
  const limit = opts.limit ?? DEFAULT_NOVEDADES_GROUP_LIMIT;
  const sinceWatermark = opts.watermark !== null;
  const windowStart =
    opts.watermark ?? new Date(Date.now() - FIRST_VISIT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    // H17: flagged, not silent — see NovedadesGroupedFeed.scopeEmpty.
    return { groups: [], sinceWatermark, windowStart, scopeEmpty: true };
  }

  const conditions = [
    inArray(petEvents.eventType, FEED_EVENT_TYPES as unknown as EventType[]),
    sinceWatermark ? gt(petEvents.recordedAt, windowStart) : gte(petEvents.recordedAt, windowStart),
  ];
  const scope = petsScopeClause(ctx);
  if (scope) conditions.push(sql`(${scope})`);

  const raw = await db
    .select({
      eventType: petEvents.eventType,
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
      count: sql<number>`count(distinct ${petEvents.petId})`,
      latestRecordedAt: sql<Date>`max(${petEvents.recordedAt})`,
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...conditions))
    .groupBy(petEvents.eventType, pets.jurisdictionProvince, pets.jurisdictionLocality)
    .orderBy(desc(sql`max(${petEvents.recordedAt})`))
    .limit(limit);

  const groups: NovedadesFeedGroup[] = raw.map((r) => ({
    key: `${r.eventType}|${r.province ?? ""}|${r.locality ?? ""}`,
    eventType: r.eventType as FeedEventType,
    province: r.province,
    locality: r.locality,
    count: Number(r.count),
    latestRecordedAt: toDate(r.latestRecordedAt),
  }));

  return { groups, sinceWatermark, windowStart, scopeEmpty: false };
}

/**
 * Page convenience: resolve the operator's watermark, then fetch the grouped
 * feed. Used by the /gob and /admin homes.
 */
export async function fetchNovedadesGroupedFeed(
  ctx: ProjectionContext,
  userId: string,
  limit: number = DEFAULT_NOVEDADES_GROUP_LIMIT,
): Promise<NovedadesGroupedFeed> {
  const watermark = await getFeedWatermark(userId);
  return fetchNovedadesGroups(ctx, { watermark, limit });
}

/**
 * Read an operator's feed watermark. Returns null when never marked (first
 * visit) — the caller then falls back to the last-7-days window.
 */
export async function getFeedWatermark(userId: string): Promise<Date | null> {
  const [row] = await db
    .select({ lastSeenRecordedAt: operatorFeedWatermarks.lastSeenRecordedAt })
    .from(operatorFeedWatermarks)
    .where(eq(operatorFeedWatermarks.userId, userId))
    .limit(1);
  return row?.lastSeenRecordedAt ?? null;
}

/**
 * Page convenience: resolve the operator's watermark, then fetch the feed.
 * Used by the /gob and /admin homes; tests target fetchNovedadesFeedRows with
 * explicit watermarks for deterministic boundary coverage.
 */
export async function fetchNovedadesFeed(
  ctx: ProjectionContext,
  userId: string,
  limit: number = DEFAULT_NOVEDADES_LIMIT,
): Promise<NovedadesFeed> {
  const watermark = await getFeedWatermark(userId);
  return fetchNovedadesFeedRows(ctx, { watermark, limit });
}

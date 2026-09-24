// Server-only: this module queries the DB. A client import is a hard build error.
import "server-only";

// lib/metrics/event-ledger.ts — WS-L "Libro de eventos" projection.
//
// Read-only projection over pet_events that powers /admin/libro. It makes the
// event-sourcing model tangible: an append-only, jurisdiction-scoped stream of
// what happened, with an amendment flag (corrections are NEW events, never
// edits) and the data needed for temporal replay deep-links.
//
// NO schema, NO new event types, NO migrations — pure projection.
//
// REUSE
// -----
//   - petsScopeClause(ctx)        — jurisdiction scope by the pet's HOME
//     jurisdiction (admin → null; govt → OR of pets.jurisdiction_* pairs),
//     applied against the pets INNER JOIN. The ledger spans ALL event types, so
//     it CANNOT use the payload-snapshot scope (petEventsScopeClause) — that only
//     matches outbreak_signal rows and would hide every other event from a scoped
//     govt viewer (ghost-payload bug). The province/locality the rows expose come
//     from the SAME pets columns the scope reads, so filtering and scoping agree.
//   - eventTypeLabel (lib/format) — single canonical es-AR label map (UI layer).
//   - logEventLedgerView          — modeled exactly on logOutreachPiiQuery.
//
// PAGINATION
// ----------
//   Keyset over (occurred_at DESC, id DESC) — no OFFSET. The (pet_id,
//   occurred_at) index plus the id tiebreak make a stable, gap-free cursor even
//   when many events share a timestamp.
//
// PII GATING
// ----------
//   Rows carry NO owner-personal data (no name / DNI / contact). Only the pet's
//   PUBLIC token (join to pets), the actor role/org, and coarse jurisdiction.

import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { auditLog, db, petEvents, pets } from "@/db";
import type { EventType } from "@/db/schema";

import type { ProjectionContext } from "./context";
import { petsScopeClause } from "./scope";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** authorRoleEnum values; kept as a string union for forward-compatibility. */
export type AuthorRole = "owner" | "scanner" | "finder" | "vet" | "shelter" | "govt" | "system";

export type EventLedgerFilters = {
  /** Restrict to these event types (combinable). */
  eventTypes?: EventType[];
  /** Coarse jurisdiction filter — reads the pet's CURRENT pets.jurisdiction_* (same columns the scope clause and the displayed rows use). */
  province?: string;
  locality?: string;
  /** Inclusive lower bound on occurred_at. */
  from?: Date;
  /** Inclusive upper bound on occurred_at. */
  to?: Date;
  /** Restrict to a single author role. */
  authorRole?: AuthorRole;
};

/** Opaque keyset cursor — the (occurredAt, id) of the LAST row of the prior page. */
export type LedgerCursor = {
  occurredAt: string; // ISO
  id: string;
};

export type EventLedgerRow = {
  id: string;
  /** Pet PUBLIC token (never the raw petId — PII gating). */
  petPublicToken: string;
  eventType: EventType;
  occurredAt: Date;
  recordedAt: Date;
  authorRole: AuthorRole;
  authorOrganizationId: string | null;
  authorVerified: boolean;
  province: string | null;
  locality: string | null;
  /** True when an event_amended row references this event (correction exists). */
  hasAmendment: boolean;
};

export type EventLedgerPage = {
  rows: EventLedgerRow[];
  nextCursor: LedgerCursor | null;
};

/** Default page size for the ledger. */
export const DEFAULT_LEDGER_LIMIT = 50;

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Fetch a keyset-paginated page of the event ledger, scoped to the viewer.
 *
 * @param ctx     - ProjectionContext (admin → global; govt → jurisdiction OR pairs).
 * @param filters - Optional, combinable filters.
 * @param cursor  - The keyset cursor returned as nextCursor by the prior page.
 * @param limit   - Page size (defaults to DEFAULT_LEDGER_LIMIT).
 */
export async function fetchEventLedger(
  ctx: ProjectionContext,
  filters: EventLedgerFilters = {},
  cursor?: LedgerCursor,
  limit: number = DEFAULT_LEDGER_LIMIT,
): Promise<EventLedgerPage> {
  // Govt with zero jurisdictions → empty (the scope clause is sql`false`, but we
  // short-circuit to avoid a pointless query, matching the Pattern-B fetchers).
  if (ctx.scope.kind === "jurisdictions" && ctx.scope.jurisdictions.length === 0) {
    return { rows: [], nextCursor: null };
  }

  const conditions = [];

  // 1. Jurisdiction scope by the pet's HOME jurisdiction (petsScopeClause against
  //    the pets INNER JOIN below). The ledger spans ALL event types, but only
  //    outbreak_signal carries the payload jurisdiction snapshot — so the former
  //    petEventsScopeClause evaluated to `false` for every non-outbreak row of a
  //    scoped-govt viewer (the ghost-payload bug), hiding the entire ledger. The
  //    pet's CURRENT jurisdiction is the correct scope and also closes the
  //    payload-drift hole a moved pet used to leave open (scope-security review
  //    2026-07-04 A1). Admin → null (universal) or the province drill-down predicate.
  const scope = petsScopeClause(ctx);
  if (scope) conditions.push(sql`(${scope})`);

  // 2. Filters.
  if (filters.eventTypes && filters.eventTypes.length > 0) {
    conditions.push(inArray(petEvents.eventType, filters.eventTypes));
  }
  if (filters.authorRole) {
    conditions.push(eq(petEvents.authorRole, filters.authorRole));
  }
  // Province/locality filters read the pet's CURRENT jurisdiction (pets columns),
  // NOT the payload snapshot — the displayed province/locality below come from the
  // same pets columns, so filtering and display agree for every event type.
  if (filters.province) {
    conditions.push(eq(pets.jurisdictionProvince, filters.province));
  }
  if (filters.locality) {
    conditions.push(eq(pets.jurisdictionLocality, filters.locality));
  }
  if (filters.from) conditions.push(gte(petEvents.occurredAt, filters.from));
  if (filters.to) conditions.push(lte(petEvents.occurredAt, filters.to));

  // 3. Keyset cursor: (occurred_at, id) strictly LESS than the cursor under the
  //    (occurred_at DESC, id DESC) order. Expressed as a row-value comparison so
  //    the tiebreak on equal timestamps is exact and gap-free.
  if (cursor) {
    // Serialize the cursor timestamp as an explicit ISO string + cast. A bare
    // Date object in a raw sql`` position is rendered with the driver's locale
    // (postgres.js, prepare:false), which Postgres rejects as a timestamp.
    conditions.push(
      sql`(${petEvents.occurredAt}, ${petEvents.id}) < (${cursor.occurredAt}::timestamptz, ${cursor.id})`,
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Fetch limit+1 to detect whether a further page exists.
  const raw = await db
    .select({
      id: petEvents.id,
      petPublicToken: pets.publicToken,
      eventType: petEvents.eventType,
      occurredAt: petEvents.occurredAt,
      recordedAt: petEvents.recordedAt,
      authorRole: petEvents.authorRole,
      authorOrganizationId: petEvents.authorOrganizationId,
      authorVerified: petEvents.authorVerified,
      // The pet's CURRENT jurisdiction (pets columns), not the payload snapshot:
      // for every non-outbreak event type the payload keys are NULL, so the old
      // payload projection rendered null province/locality for the whole ledger.
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(whereClause)
    .orderBy(desc(petEvents.occurredAt), desc(petEvents.id))
    .limit(limit + 1);

  const hasMore = raw.length > limit;
  const pageRows = hasMore ? raw.slice(0, limit) : raw;

  // 4. Batch-resolve hasAmendment for the page ids (no N+1).
  const amendedIds = await fetchAmendedEventIds(pageRows.map((r) => r.id));

  const rows: EventLedgerRow[] = pageRows.map((r) => ({
    id: r.id,
    petPublicToken: r.petPublicToken,
    eventType: r.eventType as EventType,
    occurredAt: r.occurredAt,
    recordedAt: r.recordedAt,
    authorRole: r.authorRole as AuthorRole,
    authorOrganizationId: r.authorOrganizationId,
    authorVerified: r.authorVerified,
    province: r.province,
    locality: r.locality,
    hasAmendment: amendedIds.has(r.id),
  }));

  const last = rows[rows.length - 1];
  const nextCursor: LedgerCursor | null =
    hasMore && last ? { occurredAt: last.occurredAt.toISOString(), id: last.id } : null;

  return { rows, nextCursor };
}

/**
 * Returns the set of event ids (from the provided list) that are referenced by
 * at least one event_amended row — i.e. the events that have a correction.
 *
 * Single batched query over the page ids; no per-row lookup (no N+1). The
 * payload->>'target_event_id' is the back-reference written by amendEventAction.
 */
async function fetchAmendedEventIds(eventIds: string[]): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();

  const rows = await db
    .select({
      targetEventId: sql<string | null>`${petEvents.payload}->>'target_event_id'`,
    })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.eventType, "event_amended"),
        inArray(sql`${petEvents.payload}->>'target_event_id'`, eventIds),
      ),
    );

  const out = new Set<string>();
  for (const r of rows) {
    if (r.targetEventId) out.add(r.targetEventId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Audit — modeled EXACTLY on logOutreachPiiQuery (lib/outreach-pipelines.ts)
// ---------------------------------------------------------------------------

/**
 * Write a mandatory pii_queried audit row on every ledger list view. surface is
 * "event_ledger"; the filter summary + result count let admins answer "who
 * looked at what". Fire-and-forget — callers do not need to await.
 *
 * The `surface` override exists for tests; production always uses the default.
 */
export async function logEventLedgerView(
  actorUserId: string,
  filters: EventLedgerFilters,
  resultCount: number,
  surface = "event_ledger",
): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId,
    action: "pii_queried",
    payload: {
      surface,
      filters: summarizeFilters(filters),
      result_count: resultCount,
    },
  });
}

/** Compact, log-safe summary of the active filters (no Date objects in JSONB). */
function summarizeFilters(filters: EventLedgerFilters): Record<string, unknown> {
  return {
    event_types: filters.eventTypes ?? null,
    province: filters.province ?? null,
    locality: filters.locality ?? null,
    author_role: filters.authorRole ?? null,
    from: filters.from ? filters.from.toISOString() : null,
    to: filters.to ? filters.to.toISOString() : null,
  };
}

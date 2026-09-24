// worklist-io — the bounded 3-domain fan-out behind /gob/acciones (G5).
//
// Each domain fetch reuses the domain's OWN published query primitive —
// fetchObservaciones, buildMaltratoListConditions, listCasesForGovt/Admin —
// never a parallel re-implementation, and each one is wrapped in withDbBudget
// (src/modules/panorama/application/db-budget.ts) with a per-domain budget +
// a degraded `null` fallback, so ONE slow domain degrades ALONE and the
// screen never hangs (task #74 death-spiral class; this file is enforced by
// scripts/check-db-budget.ts).
//
// SCOPE: the caller resolves jurisdiction through resolveJurisdictionScope
// (THE fence) and passes the result here as WorklistScope — this module only
// APPLIES it, it never re-derives the fence. Fail-closed: a govt scope with
// zero jurisdictions returns the empty worklist WITHOUT touching any fetcher
// (asserted by worklist-io.test.ts via injected fakes).
//
// DOMAINS DELIBERATELY OUT OF v1 (reported with the change):
//   - Outbox: govt cannot act on a stuck notification (no retry endpoint for
//     eno_authority — see the outbox screen's own honest state), so a row
//     here would carry NO resolution affordance, violating this screen's
//     premise that every row says how to resolve it. /gob/outbox (one nav
//     item away) already owns the breach lens for monitoring.
//   - Aprobaciones: has NO deadline concept (createdAt only). Fabricating a
//     dueAt to force it into a deadline ranking would be the exact
//     tier-vs-count class of dishonesty this screen exists to avoid; it
//     stays in its own count-ranked bandeja (/gob/cola).

import { and, asc, desc, eq, inArray, not } from "drizzle-orm";

import { db, petEvents, welfareReports } from "@/db";
import { buildMaltratoListConditions } from "@/lib/analytics/govt-dashboards";
import { listCasesForAdmin, listCasesForGovt } from "@/lib/infra/case-queries";
import { withDbBudget } from "@/lib/infra/db-budget";
import type { DashboardJurisdiction } from "@/lib/metrics";
import { fetchObservaciones } from "@/lib/metrics/observaciones-query";
import { CASE_KINDS_ROUTED_ELSEWHERE } from "@/src/modules/cases/domain/case-kinds";
import { resolveObservationDeadline } from "@/src/modules/surveillance/domain/rabies-observation";
import { TERMINAL_STATUSES } from "@/src/modules/welfare/domain/welfare-status-rules";

import {
  type WorklistItem,
  type WorklistLoadResult,
  buildWorklist,
  mapCaseRows,
  mapObservationRows,
  mapWelfareRows,
} from "./worklist-core";

/** Per-domain DB budget. Three parallel fetches → worst case the page waits
 *  ONE budget (they run concurrently), same ballpark as the sibling
 *  dashboard budgets (4–9s). */
const DOMAIN_BUDGET_MS = 6_000;

/** Per-domain query cap. Welfare fetches oldest-first (most overdue first),
 *  so its truncation drops the least urgent tail; observaciones carries the
 *  query's own 500-row cap; cases reuse listCases*'s newest-first contract,
 *  so a jurisdiction with more than this many OPEN cases may truncate its
 *  oldest — documented trade-off of reusing the shared query untouched. */
const WELFARE_FETCH_LIMIT = 200;
const CASES_FETCH_LIMIT = 500;

/** Same shape as ObservacionesScope — one scope vocabulary for the fan-out.
 *  Govt jurisdictions arrive ALREADY narrowed by resolveJurisdictionScope. */
export type WorklistScope =
  | { role: "admin"; province: string | null; locality: string | null }
  | { role: "govt"; jurisdictions: readonly DashboardJurisdiction[] };

// ---------------------------------------------------------------------------
// Real per-domain fetchers (injectable for tests — see WorklistFetchers)
// ---------------------------------------------------------------------------

async function fetchObservationItems(scope: WorklistScope, now: Date): Promise<WorklistItem[]> {
  const rows = await fetchObservaciones(scope, { status: "in_progress" });
  if (rows.length === 0) return [];

  // Resolve each observation's legal deadline from its started event —
  // byte-for-byte the /admin/observaciones pattern (T4.13): the payload's
  // observation_until when present/parseable, else startedAt + the 10-day
  // window via resolveObservationDeadline. Latest started event per pet wins.
  const petIds = rows.map((r) => r.petId);
  const startedEvents = await db
    .select({
      petId: petEvents.petId,
      occurredAt: petEvents.occurredAt,
      payload: petEvents.payload,
    })
    .from(petEvents)
    .where(
      and(inArray(petEvents.petId, petIds), eq(petEvents.eventType, "rabies_observation_started")),
    )
    .orderBy(desc(petEvents.occurredAt));
  const dueByPet = new Map<string, Date>();
  for (const e of startedEvents) {
    if (dueByPet.has(e.petId)) continue; // desc order → latest wins
    const payload = e.payload as Record<string, unknown>;
    dueByPet.set(e.petId, resolveObservationDeadline(payload?.observation_until, e.occurredAt));
  }

  return mapObservationRows(
    rows.map((r) => ({
      petId: r.petId,
      petPublicToken: r.petPublicToken,
      petName: r.petName,
      species: r.species,
      province: r.province,
      locality: r.locality,
      dueAt: dueByPet.get(r.petId) ?? null,
    })),
    now,
  );
}

async function fetchWelfareItems(
  scope: WorklistScope,
  currentUserId: string,
  now: Date,
): Promise<WorklistItem[]> {
  // The SAME condition builder the maltrato queue uses (scope intersection,
  // moderation exclusion, admin drill) with queue "all" (no workflow lens),
  // plus the non-terminal predicate — a closed/invalid/duplicate denuncia has
  // nothing left to expire.
  const conditions = buildMaltratoListConditions({
    actor: { role: scope.role },
    filteredJurisdictions: scope.role === "govt" ? [...scope.jurisdictions] : [],
    queue: "all",
    selectedProvince: scope.role === "admin" ? scope.province : null,
    selectedLocality: scope.role === "admin" ? scope.locality : null,
    currentUserId,
  });

  const rows = await db
    .select({
      id: welfareReports.id,
      referenceCode: welfareReports.referenceCode,
      kind: welfareReports.kind,
      severity: welfareReports.severity,
      createdAt: welfareReports.createdAt,
      jurisdictionProvince: welfareReports.jurisdictionProvince,
      jurisdictionLocality: welfareReports.jurisdictionLocality,
      assignedToUserId: welfareReports.assignedToUserId,
    })
    .from(welfareReports)
    .where(and(conditions, not(inArray(welfareReports.status, [...TERMINAL_STATUSES]))))
    // Oldest first — age IS the SLA pressure, so the cap drops the least
    // urgent tail, never the most overdue head.
    .orderBy(asc(welfareReports.createdAt), asc(welfareReports.id))
    .limit(WELFARE_FETCH_LIMIT);

  return mapWelfareRows(rows, now);
}

async function fetchCaseItems(scope: WorklistScope, now: Date): Promise<WorklistItem[]> {
  // The SAME filter object /gob/casos and the /gob home tile share: open
  // (closedAt IS NULL) and minus the kinds routed to their own screens.
  const filters = { status: "open" as const, excludeKinds: CASE_KINDS_ROUTED_ELSEWHERE };
  const rows =
    scope.role === "admin"
      ? await listCasesForAdmin({
          limit: CASES_FETCH_LIMIT,
          filters: { ...filters, province: scope.province, locality: scope.locality },
        })
      : await listCasesForGovt(scope.jurisdictions, { limit: CASES_FETCH_LIMIT, filters });
  return mapCaseRows(rows, now);
}

export type WorklistFetchers = {
  observaciones: (scope: WorklistScope, now: Date) => Promise<WorklistItem[]>;
  denuncias: (scope: WorklistScope, currentUserId: string, now: Date) => Promise<WorklistItem[]>;
  casos: (scope: WorklistScope, now: Date) => Promise<WorklistItem[]>;
};

const REAL_FETCHERS: WorklistFetchers = {
  observaciones: fetchObservationItems,
  denuncias: fetchWelfareItems,
  casos: fetchCaseItems,
};

/** Budget-bound one domain: over budget → degraded fallback (null); a real
 *  rejection BEFORE the budget also degrades (page semantics — the screen
 *  must render the other domains, not 500 on one). */
function bounded(promise: Promise<WorklistItem[]>, label: string): Promise<WorklistItem[] | null> {
  return withDbBudget<WorklistItem[] | null>(promise, DOMAIN_BUDGET_MS, label, null).catch(
    (err) => {
      console.error(`[gob/acciones] ${label} failed — rendering degraded:`, err);
      return null;
    },
  );
}

/**
 * Load the full worklist. Fail-closed FIRST: a govt operator with zero
 * jurisdiction assignments gets the empty result without any fetcher call.
 */
export async function loadWorklist(
  scope: WorklistScope,
  currentUserId: string,
  now: Date = new Date(),
  fetchers: WorklistFetchers = REAL_FETCHERS,
): Promise<WorklistLoadResult> {
  if (scope.role === "govt" && scope.jurisdictions.length === 0) {
    return {
      items: [],
      totalCount: 0,
      counts: { observaciones: 0, denuncias: 0, casos: 0 },
      degraded: { observaciones: false, denuncias: false, casos: false },
    };
  }

  const [observaciones, denuncias, casos] = await Promise.all([
    bounded(fetchers.observaciones(scope, now), "gob/acciones observaciones"),
    bounded(fetchers.denuncias(scope, currentUserId, now), "gob/acciones denuncias"),
    bounded(fetchers.casos(scope, now), "gob/acciones casos"),
  ]);

  const { items, totalCount } = buildWorklist([observaciones ?? [], denuncias ?? [], casos ?? []]);

  return {
    items,
    totalCount,
    counts: {
      observaciones: observaciones?.length ?? 0,
      denuncias: denuncias?.length ?? 0,
      casos: casos?.length ?? 0,
    },
    degraded: {
      observaciones: observaciones === null,
      denuncias: denuncias === null,
      casos: casos === null,
    },
  };
}

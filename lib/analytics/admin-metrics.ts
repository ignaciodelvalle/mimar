// Read-only aggregations for the /admin/sistema dashboard (Admin Fase 12).
// All metrics are computed live from the existing tables — no projections,
// no caching. The dashboard is admin-only so the query volume is bounded.
//
// POOL: analyticsDb (session pooler), NOT the OLTP transaction pooler. The
// /admin home + /admin/sistema loaders fan out into many aggregate statements
// per request (cockpit counts, the per-cron-name loop, decision windows), and
// supavisor transaction mode has a measured >100x pathology for exactly that
// shape (db/index.ts — the same >180s stall that hit the panorama fan-out).
// Staging 2026-07-17: both pages hung to the 300s function timeout through the
// transaction pooler while every individual query ran in <500ms. Session mode
// serves the burst normally; locally analyticsDb falls back to DATABASE_URL,
// so dev/test behavior is identical.

import { type SQL, and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import {
  approvalRequests,
  auditLog,
  cases,
  cronRuns,
  analyticsDb as db,
  govtAssignments,
  pets,
  profiles,
  welfareReports,
} from "@/db";
import { CRON_REGISTRY, cronScheduleFor } from "@/lib/infra/cron-registry";
import { countOutboxBreaches } from "@/lib/infra/outbox-queries";
import { isTestAccount } from "@/lib/infra/test-accounts";
import { countOpenAlertFirings } from "@/lib/metrics/alert-firing-inbox";
import { openObservationStatusSql } from "@/lib/metrics/observation-status";
import { jurisdictionPairClause } from "@/lib/metrics/scope";

const DAY_MS = 24 * 60 * 60 * 1000;

export type UserMetrics = {
  totalPersonal: number;
  totalInstitutionalActive: number;
  new24h: number;
  new7d: number;
  new30d: number;
};

export type QueueHealth = {
  pendingTotal: number;
  oldestPendingDaysAgo: number | null;
  pending14dPlus: number;
  pending30dPlus: number;
  pending60dPlus: number;
};

export type DecisionsMetrics = {
  approved7d: number;
  rejected7d: number;
  approved30d: number;
  rejected30d: number;
  revocations30d: number;
};

export type GovtActivityRow = {
  userId: string;
  displayName: string;
  localitiesCount: number;
  decisions30d: number;
  lastActionAt: Date | null;
};

export type CronRunRow = {
  cronName: string;
  lastRunAt: Date | null;
  lastStatus: "ok" | "failed" | "running" | null;
  itemsProcessed: number | null;
  /** Raw details JSONB from the most recent cron_run row. Populated on failure
   *  by the cron route handler (field: { errors: [{id, reason}] }). */
  lastDetails: Record<string, unknown> | null;
};

export async function fetchUserMetrics(): Promise<UserMetrics> {
  const now = Date.now();
  // The "Nuevos" counts are scoped to accountType='personal' so they share the
  // same population as `totalPersonal` (the headline number on the same card).
  // Counting ALL account types here produced the honesty bug flagged in PO QA
  // §7: institutional (admin-created) profiles inflated the windows so that
  // new7d/new30d could exceed totalPersonal ("new > total"), which is
  // impossible for a single population. Scoping guarantees
  // new24h ≤ new7d ≤ new30d ≤ totalPersonal. (A 7d == 30d equality is NOT a
  // window bug — it just means no personal signups landed between 7 and 30 days
  // ago; with demo seed data that clusters all created_at at seed time, that
  // equality is expected and is a seed-data artifact, not a counting error.)
  const [row] = await db
    .select({
      totalPersonal: sql<number>`count(*) filter (where ${profiles.accountType} = 'personal')`,
      totalInstitutionalActive: sql<number>`count(*) filter (where ${profiles.accountType} = 'institutional' and ${profiles.deactivatedAt} is null)`,
      new24h: sql<number>`count(*) filter (where ${profiles.accountType} = 'personal' and ${profiles.createdAt} >= ${new Date(now - DAY_MS).toISOString()})`,
      new7d: sql<number>`count(*) filter (where ${profiles.accountType} = 'personal' and ${profiles.createdAt} >= ${new Date(now - 7 * DAY_MS).toISOString()})`,
      new30d: sql<number>`count(*) filter (where ${profiles.accountType} = 'personal' and ${profiles.createdAt} >= ${new Date(now - 30 * DAY_MS).toISOString()})`,
    })
    .from(profiles);
  return {
    totalPersonal: Number(row.totalPersonal),
    totalInstitutionalActive: Number(row.totalInstitutionalActive),
    new24h: Number(row.new24h),
    new7d: Number(row.new7d),
    new30d: Number(row.new30d),
  };
}

export async function fetchQueueHealth(): Promise<QueueHealth> {
  const now = Date.now();
  const [row] = await db
    .select({
      pendingTotal: sql<number>`count(*) filter (where ${approvalRequests.status} = 'pending')`,
      oldestPendingMs: sql<
        number | null
      >`extract(epoch from (now() - min(${approvalRequests.createdAt}) filter (where ${approvalRequests.status} = 'pending'))) * 1000`,
      pending14dPlus: sql<number>`count(*) filter (where ${approvalRequests.status} = 'pending' and ${approvalRequests.createdAt} < ${new Date(now - 14 * DAY_MS).toISOString()})`,
      pending30dPlus: sql<number>`count(*) filter (where ${approvalRequests.status} = 'pending' and ${approvalRequests.createdAt} < ${new Date(now - 30 * DAY_MS).toISOString()})`,
      pending60dPlus: sql<number>`count(*) filter (where ${approvalRequests.status} = 'pending' and ${approvalRequests.createdAt} < ${new Date(now - 60 * DAY_MS).toISOString()})`,
    })
    .from(approvalRequests);
  return {
    pendingTotal: Number(row.pendingTotal),
    oldestPendingDaysAgo:
      row.oldestPendingMs != null ? Math.floor(Number(row.oldestPendingMs) / DAY_MS) : null,
    pending14dPlus: Number(row.pending14dPlus),
    pending30dPlus: Number(row.pending30dPlus),
    pending60dPlus: Number(row.pending60dPlus),
  };
}

const ZERO_QUEUE_HEALTH: QueueHealth = {
  pendingTotal: 0,
  oldestPendingDaysAgo: null,
  pending14dPlus: 0,
  pending30dPlus: 0,
  pending60dPlus: 0,
};

/**
 * Scoped variant of `fetchQueueHealth` for govt dashboards.
 *
 * Mirrors the global `fetchQueueHealth` (same buckets: pendingTotal,
 * oldestPending, 14d/30d/60d) but restricts to `approval_requests` rows
 * matching any of the caller's jurisdiction assignments via
 * `(jurisdictionProvince, jurisdictionLocality)` pairs.
 *
 * Takes the page's `ProjectionContext` — the SAME scope object every other
 * fetcher on the screen already receives — so the scope decision is read off
 * `ctx.scope.kind` and never re-derived from the shape of a jurisdiction list:
 *
 *   - `scope.kind === "global"` (admin / national read scope) → no jurisdiction
 *     clause, UNLESS `ctx.adminProvince` is set (Panorama-style drill-down —
 *     additive-only narrowing, mirrors `petsScopeClause`'s admin branch).
 *   - `scope.kind === "jurisdictions"` with assignments → OR of pairs.
 *   - `scope.kind === "jurisdictions"` with ZERO assignments → zeroed result,
 *     WITHOUT a query. Fail-closed, exactly like `petsScopeClause` compiling the
 *     same case to `sql\`false\``.
 *
 * WHY THE CONTEXT AND NOT A BARE LIST (A01-2, closed 2026-09-09). This used to
 * take `jurisdictions: DashboardJurisdiction[]` and treat `[]` as "admin,
 * universal" — the ONE resolver on the /gob surface that read an empty list as
 * scope-less instead of scope-empty. It was reachable: `resolveJurisdictionScope`
 * narrows a govt's mandate through `narrowGovtScope`, which returns `[]` for a
 * `?province=` outside the mandate, and the caller's `hasAccess` gate tested the
 * MANDATE, not the narrowed set. One out-of-mandate URL param on an assigned govt
 * yielded NATIONAL approval-queue counts. A list cannot say whether it is empty
 * because nothing is in scope or because everything is; the context can.
 */
export async function fetchQueueHealthScoped(
  ctx: import("@/lib/metrics").ProjectionContext,
): Promise<QueueHealth> {
  const now = Date.now();

  const conditions: SQL[] = [];
  if (ctx.scope.kind === "global") {
    // Admin / national province drill-down: universal scope by contract, so
    // this is the only restriction the caller gets. Never set for govt callers
    // (their scope.kind is "jurisdictions", so this branch is unreachable).
    if (ctx.adminProvince) {
      conditions.push(sql`${approvalRequests.jurisdictionProvince} = ${ctx.adminProvince}`);
      if (ctx.adminLocality) {
        conditions.push(sql`${approvalRequests.jurisdictionLocality} = ${ctx.adminLocality}`);
      }
    }
  } else {
    // A govt whose effective scope is EMPTY sees zero rows — fail closed
    // WITHOUT a query, the same short-circuit fetchCasesQueueAging and
    // countCasesForGovt apply. Empty means universal only for the global kind.
    if (ctx.scope.jurisdictions.length === 0) return ZERO_QUEUE_HEALTH;

    // The approval_requests table has indexed columns jurisdictionProvince /
    // jurisdictionLocality (see jurisIdx in schema.ts) so the OR fan-out is
    // covered by the existing partial index on status='pending'.
    //
    // Subsumption-aware (2026-07-08): a whole-province assignment (whole-CABA /
    // "Ciudad Autónoma de Buenos Aires") governs every barrio in it, so it must
    // match a barrio-tagged (Palermo) request on PROVINCE alone. Reuses
    // jurisdictionPairClause — the SAME predicate the /gob/cola queue
    // (visibleRequestsClause) uses — so this aging COUNTER and that queue can
    // never diverge (a whole-CABA operator's "cola pendiente" tile and their
    // queue show the same population). Exact pairs are kept for barrio operators.
    // synthetic: exempt — approval_requests carry no seed marker (T1-P1 report).
    const jurisClause = jurisdictionPairClause(
      ctx.scope.jurisdictions,
      sql`${approvalRequests.jurisdictionProvince}`,
      sql`${approvalRequests.jurisdictionLocality}`,
    );
    if (jurisClause) conditions.push(jurisClause);
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [row] = await db
    .select({
      pendingTotal: sql<number>`count(*) filter (where ${approvalRequests.status} = 'pending')`,
      oldestPendingMs: sql<
        number | null
      >`extract(epoch from (now() - min(${approvalRequests.createdAt}) filter (where ${approvalRequests.status} = 'pending'))) * 1000`,
      pending14dPlus: sql<number>`count(*) filter (where ${approvalRequests.status} = 'pending' and ${approvalRequests.createdAt} < ${new Date(now - 14 * DAY_MS).toISOString()})`,
      pending30dPlus: sql<number>`count(*) filter (where ${approvalRequests.status} = 'pending' and ${approvalRequests.createdAt} < ${new Date(now - 30 * DAY_MS).toISOString()})`,
      pending60dPlus: sql<number>`count(*) filter (where ${approvalRequests.status} = 'pending' and ${approvalRequests.createdAt} < ${new Date(now - 60 * DAY_MS).toISOString()})`,
    })
    .from(approvalRequests)
    .where(whereClause);

  return {
    pendingTotal: Number(row.pendingTotal),
    oldestPendingDaysAgo:
      row.oldestPendingMs != null ? Math.floor(Number(row.oldestPendingMs) / DAY_MS) : null,
    pending14dPlus: Number(row.pending14dPlus),
    pending30dPlus: Number(row.pending30dPlus),
    pending60dPlus: Number(row.pending60dPlus),
  };
}

// ---------------------------------------------------------------------------
// Queue-health cockpit (Epic D)
// ---------------------------------------------------------------------------
//
// The /admin home used to surface a SINGLE lumped "Cola pendiente" number
// (fetchQueueHealth → count of pending approval_requests), which implied "one
// queue" while the Novedades feed pointed at a different source (pet_events) and
// several genuinely-distinct operational queues stayed invisible. This cockpit
// breaks the approval queue out per type AND counts every other operational
// queue so the home reflects reality. All counts are read-only, bounded, and
// reuse the SAME single-source-of-truth helpers the nav badges / detail pages
// use (countOpenAlertFirings, countOutboxBreaches) so the home can never drift
// from those surfaces.

/** Per-type pending breakdown of the approval queue (approval_requests). */
export type ApprovalQueueByType = {
  /** Total pending approval requests (all three types). */
  pendingTotal: number;
  /** Age in days of the oldest pending request (null when none pending). */
  oldestPendingDaysAgo: number | null;
  /** Pending vet-matrícula upgrades. */
  roleUpgradeVet: number;
  /** Pending organization-verification requests. */
  organizationVerification: number;
  /** Pending RUPGA service-dog credential verifications. */
  serviceDogCredentialVerification: number;
};

/** Every operational queue an admin owns, counted for the home cockpit. */
export type QueueCockpit = {
  /** Approval queue, broken out per type. */
  approvals: ApprovalQueueByType;
  /** welfare_reports flagged for moderation and not yet resolved (/admin/moderacion). */
  moderationPending: number;
  /** Open (non-terminal) alert firings (/admin/alertas). */
  alertsOpen: number;
  /** Outbox rows in SLA breach: pending AND past their SLA deadline (/admin/outbox). */
  outboxBreaches: number;
  /** Cases not yet closed — closedAt IS NULL (/admin/casos). */
  casesOpen: number;
  /** Pets under an in-progress 10-day rabies observation (/admin/observaciones). */
  rabiesInProgress: number;
};

/**
 * Per-type pending breakdown of the approval queue in a single aggregate query.
 * Mirrors the total/oldest math of `fetchQueueHealth` (same partial index on
 * status='pending') but also splits the three request types out via filtered
 * counts so the home can show one tile per queue instead of one lumped number.
 */
export async function fetchApprovalQueueByType(): Promise<ApprovalQueueByType> {
  const [row] = await db
    .select({
      pendingTotal: sql<number>`count(*) filter (where ${approvalRequests.status} = 'pending')`,
      oldestPendingMs: sql<
        number | null
      >`extract(epoch from (now() - min(${approvalRequests.createdAt}) filter (where ${approvalRequests.status} = 'pending'))) * 1000`,
      roleUpgradeVet: sql<number>`count(*) filter (where ${approvalRequests.status} = 'pending' and ${approvalRequests.type} = 'role_upgrade_vet')`,
      organizationVerification: sql<number>`count(*) filter (where ${approvalRequests.status} = 'pending' and ${approvalRequests.type} = 'organization_verification')`,
      serviceDogCredentialVerification: sql<number>`count(*) filter (where ${approvalRequests.status} = 'pending' and ${approvalRequests.type} = 'service_dog_credential_verification')`,
    })
    .from(approvalRequests);
  return {
    pendingTotal: Number(row.pendingTotal),
    oldestPendingDaysAgo:
      row.oldestPendingMs != null ? Math.floor(Number(row.oldestPendingMs) / DAY_MS) : null,
    roleUpgradeVet: Number(row.roleUpgradeVet),
    organizationVerification: Number(row.organizationVerification),
    serviceDogCredentialVerification: Number(row.serviceDogCredentialVerification),
  };
}

/**
 * welfare_reports awaiting moderation. Predicate is identical to the
 * /admin/moderacion "Pendientes" filter (flagged by the heuristics AND not yet
 * resolved) so the home tile and that page can never disagree.
 */
async function countModerationPending(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(welfareReports)
    .where(and(isNotNull(welfareReports.flaggedAt), isNull(welfareReports.moderationResolvedAt)));
  return Number(row?.n ?? 0);
}

/**
 * Cases not yet closed. Same predicate as /admin/casos's default "Abiertos"
 * view (buildAdminCaseFilterClauses: closedAt IS NULL) so the home tile and
 * the page agree by construction, not by coincidence — a status-list mirror
 * would silently drift if a new non-terminal status (e.g. "merged") is wired.
 */
async function countOpenCases(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(cases)
    .where(isNull(cases.closedAt));
  return Number(row?.n ?? 0);
}

/**
 * Pets with an OPEN rabies observation — the queue /admin/observaciones shows.
 * Includes `window_expired_unclosed` (2026-08-17): those rows are the ones that
 * still need an operator, so a queue tile that dropped them would count down to
 * zero precisely as the backlog grew.
 */
async function countRabiesInProgress(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pets)
    .where(openObservationStatusSql());
  return Number(row?.n ?? 0);
}

/**
 * Fan out every operational-queue count in parallel for the /admin home
 * cockpit. Reuses the shared alert / outbox helpers rather than duplicating
 * their predicates, so all three surfaces (nav badge, detail page, home tile)
 * stay in lockstep.
 */
export async function fetchQueueCockpit(): Promise<QueueCockpit> {
  const [approvals, moderationPending, alertsOpen, outboxBreaches, casesOpen, rabiesInProgress] =
    await Promise.all([
      fetchApprovalQueueByType(),
      countModerationPending(),
      countOpenAlertFirings(),
      countOutboxBreaches(),
      countOpenCases(),
      countRabiesInProgress(),
    ]);
  return {
    approvals,
    moderationPending,
    alertsOpen,
    outboxBreaches,
    casesOpen,
    rabiesInProgress,
  };
}

// Decisions are sourced from audit_log because approvalRequests doesn't keep a
// timestamp for the decision itself — only the current status. Revocations
// (revoke_vet, revoke_org, revoke_govt) are all prefixed `revocation_` in
// audit_log.action; we count the whole family.
export async function fetchDecisionsMetrics(): Promise<DecisionsMetrics> {
  const now = Date.now();
  const since7 = new Date(now - 7 * DAY_MS);
  const since30 = new Date(now - 30 * DAY_MS);
  const [row] = await db
    .select({
      approved7d: sql<number>`count(*) filter (where ${auditLog.action} = 'request_approved' and ${auditLog.performedAt} >= ${since7.toISOString()})`,
      rejected7d: sql<number>`count(*) filter (where ${auditLog.action} = 'request_rejected' and ${auditLog.performedAt} >= ${since7.toISOString()})`,
      approved30d: sql<number>`count(*) filter (where ${auditLog.action} = 'request_approved' and ${auditLog.performedAt} >= ${since30.toISOString()})`,
      rejected30d: sql<number>`count(*) filter (where ${auditLog.action} = 'request_rejected' and ${auditLog.performedAt} >= ${since30.toISOString()})`,
      revocations30d: sql<number>`count(*) filter (where ${auditLog.action} like 'revocation_%' and ${auditLog.performedAt} >= ${since30.toISOString()})`,
    })
    .from(auditLog);
  return {
    approved7d: Number(row.approved7d),
    rejected7d: Number(row.rejected7d),
    approved30d: Number(row.approved30d),
    rejected30d: Number(row.rejected30d),
    revocations30d: Number(row.revocations30d),
  };
}

// Per-govt activity: localities under their scope, decisions made, last action
// (any). Three small queries are cheaper than one CTE here because Drizzle
// doesn't compose lateral joins well and the govt count is small.
export async function fetchGovtActivity(): Promise<GovtActivityRow[]> {
  const govtsRaw = await db
    .select({ id: profiles.id, displayName: profiles.displayName })
    .from(profiles)
    .where(
      and(
        eq(profiles.role, "govt"),
        eq(profiles.accountType, "institutional"),
        sql`${profiles.deactivatedAt} is null`,
      ),
    );

  // Test/smoke-account hygiene (red-team 2026-07-24 #9): the /admin/govts
  // roster already defaults these OUT (uc-cd-*, -gen-*, …), but this activity
  // table did not — dozens of `uc-cd-govt` rows flooded it and buried the real
  // operators. Same filter, same reasoning; production carries no such rows.
  const govts = govtsRaw.filter((g) => !isTestAccount(g.displayName));

  if (govts.length === 0) return [];

  const govtIds = govts.map((g) => g.id);
  const localitiesByGovt = new Map<string, number>();
  const decisionsByGovt = new Map<string, number>();
  const lastActionByGovt = new Map<string, Date>();

  const locRows = await db
    .select({
      userId: govtAssignments.userId,
      cnt: sql<number>`count(distinct (${govtAssignments.jurisdictionProvince}, ${govtAssignments.jurisdictionLocality}))`,
    })
    .from(govtAssignments)
    .where(and(inArray(govtAssignments.userId, govtIds), sql`${govtAssignments.revokedAt} is null`))
    .groupBy(govtAssignments.userId);
  for (const r of locRows) localitiesByGovt.set(r.userId, Number(r.cnt));

  const since30 = new Date(Date.now() - 30 * DAY_MS);
  const decRows = await db
    .select({
      actorUserId: auditLog.actorUserId,
      cnt: sql<number>`count(*)`,
    })
    .from(auditLog)
    .where(
      and(
        inArray(auditLog.actorUserId, govtIds),
        sql`${auditLog.action} in ('request_approved','request_rejected')`,
        gte(auditLog.performedAt, since30),
      ),
    )
    .groupBy(auditLog.actorUserId);
  // actorUserId is nullable (ARCH-H), but the WHERE clause above filters to
  // govtIds so NULL rows are excluded at the DB level.
  for (const r of decRows) {
    if (r.actorUserId) decisionsByGovt.set(r.actorUserId, Number(r.cnt));
  }

  const lastRows = await db
    .select({
      actorUserId: auditLog.actorUserId,
      // NOT sql<Date>: raw-sql aggregates bypass drizzle's column mapping and
      // arrive as STRINGS at runtime — the type param is a compile-time claim
      // only. Trusting it crashed /admin/sistema (digest 1282362471) as soon
      // as a govt had audit rows: sortGovtActivityByActivity called .getTime()
      // on a string. Coerce at this boundary so the declared GovtActivityRow
      // shape (Date | null) is actually true.
      lastAt: sql<string | null>`max(${auditLog.performedAt})`,
    })
    .from(auditLog)
    .where(inArray(auditLog.actorUserId, govtIds))
    .groupBy(auditLog.actorUserId);
  for (const r of lastRows) {
    if (r.actorUserId && r.lastAt != null) {
      // new Date() accepts both the string postgres-js actually returns and a
      // Date if a future driver maps it.
      const d = new Date(r.lastAt);
      if (!Number.isNaN(d.getTime())) lastActionByGovt.set(r.actorUserId, d);
    }
  }

  return govts.map((g) => ({
    userId: g.id,
    displayName: g.displayName,
    localitiesCount: localitiesByGovt.get(g.id) ?? 0,
    decisions30d: decisionsByGovt.get(g.id) ?? 0,
    lastActionAt: lastActionByGovt.get(g.id) ?? null,
  }));
}

// Order the "actividad por govt" table so the operators an admin actually needs
// to see surface first: most recent action, then most decisions (30d), then
// name. Govts with no recorded action sink to the bottom. Pure — no DB. The
// /admin/sistema page sorts then truncates with a "hay más" hint so a roster of
// duplicate seed govts can't push live operators below the fold.
export function sortGovtActivityByActivity(rows: readonly GovtActivityRow[]): GovtActivityRow[] {
  return [...rows].sort((a, b) => {
    const at = a.lastActionAt ? a.lastActionAt.getTime() : Number.NEGATIVE_INFINITY;
    const bt = b.lastActionAt ? b.lastActionAt.getTime() : Number.NEGATIVE_INFINITY;
    if (at !== bt) return bt - at;
    if (a.decisions30d !== b.decisions30d) return b.decisions30d - a.decisions30d;
    return a.displayName.localeCompare(b.displayName, "es-AR");
  });
}

// Latest run per cron_name in ONE DISTINCT ON pass (was a per-name N+1 loop of
// ~22 serial round-trips — perf audit 2026-07-19 qw#1). Same DISTINCT ON shape as
// fetchFailedCronNames, including the secondary id key so a started_at tie
// resolves IDENTICALLY here and there (else the dashboard banner could disagree
// with the /admin/sistema Crons card about which job is down). Defensive casts:
// db.execute returns raw rows, so started_at/items_processed may arrive as
// string OR Date/number depending on the driver.
export async function fetchCronRuns(): Promise<CronRunRow[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (cron_name)
      cron_name, started_at, status, items_processed, details
    FROM cron_runs
    ORDER BY cron_name, started_at DESC, id DESC
  `)) as {
    cron_name: string;
    started_at: Date | string;
    status: string;
    items_processed: number | string | null;
    details: unknown;
  }[];
  return rows.map((r) => ({
    cronName: r.cron_name,
    lastRunAt: r.started_at ? new Date(r.started_at) : null,
    lastStatus: (r.status as CronRunRow["lastStatus"]) ?? null,
    itemsProcessed: r.items_processed == null ? null : Number(r.items_processed),
    lastDetails: r.details ? (r.details as Record<string, unknown>) : null,
  }));
}

// Cron names whose MOST RECENT run failed — the signal behind the crons-down
// banner (operator-trust T3) on /admin and /admin/sistema. One DISTINCT ON
// query (cheaper than fetchCronRuns' per-name loop) so the dashboard can afford
// it. Honest in both envs: locally the "failure" is usually vitest polluting
// the shared cron_runs table (cron route tests write real rows), while in prod
// cron_runs only ever gets rows from real Vercel executions, so a failed latest
// status there is a genuine incident. Do NOT suppress by env — the banner just
// mirrors telemetry.
export async function fetchFailedCronNames(): Promise<string[]> {
  // C-b: a run STUCK at 'running' past the orphan threshold counts as down
  // too — the banner had the same blind spot as fetchCronHealth (a hard-
  // killed run stayed invisible for up to 26h).
  const rows = (await db.execute(sql`
    SELECT cron_name
    FROM (
      SELECT DISTINCT ON (cron_name) cron_name, status, started_at
      FROM cron_runs
      ORDER BY cron_name, started_at DESC, id DESC
    ) latest
    WHERE latest.status = 'failed'
       OR (latest.status = 'running'
           AND latest.started_at < now() - make_interval(secs => ${STUCK_RUNNING_MS / 1000}))
    ORDER BY cron_name
  `)) as { cron_name: string }[];
  return rows.map((r) => r.cron_name);
}

// ---------------------------------------------------------------------------
// Pet-status cache drift (projection-cron audit 2026-07-03 B3)
// ---------------------------------------------------------------------------
//
// reconcile-pet-status detects pets.status ↔ event-log divergence and records
// it in cronRuns.details, and cron-health (the meta-cron) flags divergent > 0
// as an unhealthy 'drift' state — but neither signal was visible in the admin
// UI. This loader surfaces both for the /admin/sistema drift card. Detect-only:
// repair stays human-gated (scripts/rebuild-projections.ts --apply).

export type PetStatusDriftSample = {
  publicToken: string;
  /** pets.status stored at scan time. */
  cached: string | null;
  /** Status derived from the event log at scan time. */
  derived: string | null;
  /**
   * The cache columns that ACTUALLY diverged for this pet. A pet is flagged
   * divergent when ANY checked column drifts (status, estimatedWeightKg,
   * microchip*, tattoo*, pregnancyStatus, …) — not only status. The card must
   * show these so a divergent row whose `status` happens to match doesn't read
   * as a mislabelled "cache active → log active" pair. Empty for legacy runs
   * recorded before the cron persisted this field.
   */
  driftedColumns: string[];
};

export type PetStatusDrift = {
  /** Latest reconcile_pet_status run, or null when that cron never ran. */
  reconcile: {
    lastRunAt: Date;
    status: "running" | "ok" | "failed";
    scanned: number;
    divergent: number;
    /** True when the scan stopped early (MAX_PETS_PER_RUN / time budget). */
    earlyStop: boolean;
    sample: PetStatusDriftSample[];
  } | null;
  /**
   * Latest cron_health verdict about reconcile_pet_status — the meta-cron
   * semantic check that verifies drift detection is running AND clean.
   * null when cron_health never ran or has no entry for the reconcile cron.
   */
  metaCheck: {
    checkedAt: Date;
    healthy: boolean;
    /** 'ok' | 'drift' | 'stale' | 'never_ran' | 'last_failed' (cron-health reasons). */
    reason: string;
  } | null;
};

export async function fetchPetStatusDrift(): Promise<PetStatusDrift> {
  const [[reconcileRun], [healthRun]] = await Promise.all([
    db
      .select({
        startedAt: cronRuns.startedAt,
        status: cronRuns.status,
        details: cronRuns.details,
      })
      .from(cronRuns)
      .where(eq(cronRuns.cronName, "reconcile_pet_status"))
      .orderBy(desc(cronRuns.startedAt))
      .limit(1),
    db
      .select({
        startedAt: cronRuns.startedAt,
        details: cronRuns.details,
      })
      .from(cronRuns)
      .where(eq(cronRuns.cronName, "cron_health"))
      .orderBy(desc(cronRuns.startedAt))
      .limit(1),
  ]);

  let reconcile: PetStatusDrift["reconcile"] = null;
  if (reconcileRun) {
    const d = (reconcileRun.details ?? {}) as Record<string, unknown>;
    const rawSample = Array.isArray(d.sample) ? (d.sample as Record<string, unknown>[]) : [];
    reconcile = {
      lastRunAt: reconcileRun.startedAt,
      status: reconcileRun.status,
      scanned: Number(d.scanned ?? 0),
      divergent: Number(d.divergent ?? 0),
      earlyStop: d.earlyStop === true,
      sample: rawSample.map((s) => ({
        publicToken: typeof s.publicToken === "string" ? s.publicToken : "—",
        cached: typeof s.cached === "string" ? s.cached : null,
        derived: typeof s.derived === "string" ? s.derived : null,
        driftedColumns: Array.isArray(s.driftedColumns)
          ? (s.driftedColumns as unknown[]).filter((c): c is string => typeof c === "string")
          : [],
      })),
    };
  }

  let metaCheck: PetStatusDrift["metaCheck"] = null;
  if (healthRun) {
    const d = (healthRun.details ?? {}) as Record<string, unknown>;
    const all = Array.isArray(d.all) ? (d.all as Record<string, unknown>[]) : [];
    const entry = all.find((r) => r.cronName === "reconcile_pet_status");
    if (entry) {
      metaCheck = {
        checkedAt: healthRun.startedAt,
        healthy: entry.healthy === true,
        reason: typeof entry.reason === "string" ? entry.reason : "unknown",
      };
    }
  }

  return { reconcile, metaCheck };
}

// ---------------------------------------------------------------------------
// Cron health detail — used by /admin/sistema/crons.
//
// Returns one row per cron in the registry (including ones that never ran).
// The staleness thresholds here mirror the CRON_REGISTRY in
// app/api/cron/cron-health/route.ts — keep them in sync.
// ---------------------------------------------------------------------------

const DAILY_STALENESS_MS = 26 * 60 * 60 * 1000; // 26 hours

export type CronHealthRow = {
  cronName: string;
  schedule: string;
  healthy: boolean;
  reason: "ok" | "never_ran" | "stale" | "last_failed" | "stuck_running";
  lastRunAt: Date | null;
  lastStatus: "ok" | "failed" | "running" | null;
  lastItemsProcessed: number | null;
  ageMs: number | null;
  /**
   * C-b: the last run that actually FINISHED (finished_at IS NOT NULL) — the
   * "last completed run" the operator needs when the latest ATTEMPT is stuck
   * at 'running'. Null when the cron never completed a run.
   */
  lastCompletedAt: Date | null;
  lastCompletedStatus: "ok" | "failed" | null;
};

/**
 * C-b: a run still at 'running' past this age is provably orphaned — every
 * fleet function shares maxDuration 60s, so anything beyond ~90s never
 * finished; 10 minutes is a conservative margin over cold starts and clock
 * skew. Well under DAILY_STALENESS_MS (26h), which used to be the ONLY thing
 * that caught these — meaning a hard-killed run rendered a green "Saludable"
 * pill for up to 26 hours.
 */
export const STUCK_RUNNING_MS = 10 * 60 * 1000;

// Los horarios salen del REGISTRO CANONICO, no de una copia local.
//
// Aca vivia CRON_SCHEDULE_MAP, una segunda tabla de horarios mantenida a mano —
// y ya habia derivado: decia que drain_outbox corre a las 06:00 cuando el
// registro dice 04:00. Esa divergencia se renderiza tal cual en
// /admin/sistema/crons, que es la pantalla donde un operador va justamente a
// verificar si un trabajo corrio cuando debia. Una consola de salud que miente
// sobre el horario es peor que no tener consola: no se puede distinguir un cron
// atrasado de un cron que corre a otra hora de la que uno cree.
//
// El monitoreo real (/api/cron/cron-health) siempre uso CRON_REGISTRY. Ahora la
// consola tambien, asi que hay un solo lugar donde cambiar un horario.
const CRON_REGISTRY_NAMES = CRON_REGISTRY.map((e) => e.cronName);
const CRON_SCHEDULE_BY_NAME = new Map(CRON_REGISTRY.map((e) => [e.cronName, cronScheduleFor(e)]));

export async function fetchCronHealth(): Promise<CronHealthRow[]> {
  const now = Date.now();

  // Fetch the latest run for every known cron name in ONE DISTINCT ON pass (was a
  // per-name N+1 loop of ~22 serial round-trips — perf audit 2026-07-19 qw#1).
  // Same shape/tiebreak as fetchCronRuns/fetchFailedCronNames.
  const latestRows = (await db.execute(sql`
    SELECT DISTINCT ON (cron_name)
      cron_name, started_at, status, items_processed
    FROM cron_runs
    ORDER BY cron_name, started_at DESC, id DESC
  `)) as {
    cron_name: string;
    started_at: Date | string;
    status: string;
    items_processed: number | string | null;
  }[];

  // C-b: the latest COMPLETED run per cron — distinct from the latest attempt,
  // which may be stuck at 'running'. One extra indexed pass, same shape.
  const completedRows = (await db.execute(sql`
    SELECT DISTINCT ON (cron_name)
      cron_name, finished_at, status
    FROM cron_runs
    WHERE finished_at IS NOT NULL
    ORDER BY cron_name, finished_at DESC, id DESC
  `)) as {
    cron_name: string;
    finished_at: Date | string;
    status: string;
  }[];
  const completedByName = new Map<string, { finishedAt: Date; status: "ok" | "failed" }>();
  for (const r of completedRows) {
    completedByName.set(r.cron_name, {
      finishedAt: new Date(r.finished_at),
      status: r.status as "ok" | "failed",
    });
  }

  const latestByName = new Map<
    string,
    { startedAt: Date; status: string; itemsProcessed: number }
  >();
  for (const r of latestRows) {
    latestByName.set(r.cron_name, {
      startedAt: new Date(r.started_at),
      status: r.status,
      itemsProcessed: r.items_processed == null ? 0 : Number(r.items_processed),
    });
  }

  const rows: CronHealthRow[] = [];
  for (const cronName of CRON_REGISTRY_NAMES) {
    const schedule = CRON_SCHEDULE_BY_NAME.get(cronName) ?? "?";
    const latest = latestByName.get(cronName) ?? null;
    const completed = completedByName.get(cronName) ?? null;
    const lastCompletedAt = completed?.finishedAt ?? null;
    const lastCompletedStatus = completed?.status ?? null;

    if (!latest) {
      rows.push({
        cronName,
        schedule,
        healthy: false,
        reason: "never_ran",
        lastRunAt: null,
        lastStatus: null,
        lastItemsProcessed: null,
        ageMs: null,
        lastCompletedAt,
        lastCompletedStatus,
      });
      continue;
    }

    const ageMs = now - latest.startedAt.getTime();
    const status = latest.status as "ok" | "failed" | "running";

    if (status === "failed") {
      rows.push({
        cronName,
        schedule,
        healthy: false,
        reason: "last_failed",
        lastRunAt: latest.startedAt,
        lastStatus: status,
        lastItemsProcessed: latest.itemsProcessed,
        ageMs,
        lastCompletedAt,
        lastCompletedStatus,
      });
      continue;
    }

    // C-b: a run stuck at 'running' past the orphan threshold is UNHEALTHY —
    // it used to fall through to the green "ok" branch for up to 26 hours
    // (the staleness window), indistinguishable from a job mid-flight.
    if (status === "running" && ageMs > STUCK_RUNNING_MS) {
      rows.push({
        cronName,
        schedule,
        healthy: false,
        reason: "stuck_running",
        lastRunAt: latest.startedAt,
        lastStatus: status,
        lastItemsProcessed: latest.itemsProcessed,
        ageMs,
        lastCompletedAt,
        lastCompletedStatus,
      });
      continue;
    }

    if (ageMs > DAILY_STALENESS_MS) {
      rows.push({
        cronName,
        schedule,
        healthy: false,
        reason: "stale",
        lastRunAt: latest.startedAt,
        lastStatus: status,
        lastItemsProcessed: latest.itemsProcessed,
        ageMs,
        lastCompletedAt,
        lastCompletedStatus,
      });
      continue;
    }

    rows.push({
      cronName,
      schedule,
      healthy: true,
      reason: "ok",
      lastRunAt: latest.startedAt,
      lastStatus: status,
      lastItemsProcessed: latest.itemsProcessed,
      ageMs,
      lastCompletedAt,
      lastCompletedStatus,
    });
  }

  return rows;
}

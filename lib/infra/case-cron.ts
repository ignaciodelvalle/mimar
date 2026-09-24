// Shared cron runner for case-system crons. Encapsulates:
//  - cron-secret auth (via authorizeCronRequest from lib/cron-auth.ts)
//  - cronRuns INSERT (status='running') + UPDATE (status='ok'|'failed')
//  - per-candidate try/catch so one bad row doesn't poison the batch
//  - error aggregation into cron_runs.details
//
// Each case-system cron route (route.ts) imports this and supplies the
// scan/process pair. The route itself owns the `NextResponse.json` shape
// so we can keep this helper framework-agnostic and unit-testable.

import { and, desc, eq, isNotNull } from "drizzle-orm";

import { cronRuns, db } from "@/db";
import { authorizeCronRequest } from "@/lib/domain/cron-auth";
import { sendCronAlert } from "@/lib/infra/cron-alert";
import { effectiveDeadlineMs } from "@/lib/infra/cron-dispatcher";

/** Keyset cursor passed to a batched scan. */
export interface CaseCronCursor {
  /** Return rows whose id sorts AFTER this value (null = from the top). */
  afterId: string | null;
  /** Max rows to return this page. */
  limit: number;
}

export interface RunCaseCronInput<TCandidate> {
  /** Stable name for this cron — used as the `cron_runs.cron_name` value. */
  name: string;
  /**
   * Returns candidate rows to process. In legacy (unbatched) mode the cursor
   * arg is omitted and the scan returns ALL candidates. In keyset mode
   * (`batchSize` set) the scan receives a cursor and must return at most
   * `cursor.limit` rows ordered by their id, filtered to `id > cursor.afterId`.
   */
  scan: (cursor?: CaseCronCursor) => Promise<TCandidate[]>;
  /** Processes a single candidate inside its own transaction. */
  processOne: (candidate: TCandidate) => Promise<void>;
  /**
   * Extracts a stable id from a candidate — used for error reporting in
   * `cron_runs.details.errors[]` AND as the keyset cursor in batched mode.
   * Default: `(c) => (c as { id: string }).id`.
   */
  candidateId?: (candidate: TCandidate) => string;
  /**
   * When set (> 0), the runner loops keyset batches of this size — advancing
   * the cursor past each processed candidate — until the scan returns fewer
   * than `batchSize` rows OR `maxDurationMs` elapses. This bounds per-run
   * memory (never loads the whole nationwide result set at once) and wall
   * clock (stays inside Vercel's 60s function budget). Processed rows drop out
   * of the next scan's WHERE (status flips), so a backlog drains across runs.
   * Omit for the legacy single-scan behavior.
   */
  batchSize?: number;
  /** Wall-clock budget for the keyset loop (ms). Default 45s. */
  maxDurationMs?: number;
  /**
   * The calling route's request headers, so the loop bounds itself by
   * min(own ceiling, the fair share the daily dispatcher handed down)
   * — RN #9, 2026-08-22.
   *
   * WHY it must be passed: 45 s is a safe ceiling for a route running ALONE.
   * Inside the dispatcher the whole fleet shares one 60 s function under a
   * 55 s budget, and the dispatcher's budget check only fires BETWEEN jobs —
   * it never interrupts one in flight. A backlogged case cron starting at
   * ~15 s therefore took the function past its hard kill and every job behind
   * it with it. Omit for a standalone/manual call: the ceiling stays the
   * constant.
   */
  budgetHeaders?: { get(name: string): string | null };
}

// Vercel Hobby cron functions time out at 60s; 45s leaves margin to finalize
// the cron_runs row and shape the response.
const DEFAULT_MAX_DURATION_MS = 45_000;

export interface RunCaseCronResult {
  runId: string;
  status: "ok" | "failed";
  itemsProcessed: number;
  errors: { id: string; reason: string }[];
}

export async function runCaseCron<TCandidate>(
  input: RunCaseCronInput<TCandidate>,
): Promise<RunCaseCronResult> {
  const [run] = await db
    .insert(cronRuns)
    .values({ cronName: input.name, status: "running" })
    .returning();

  let itemsProcessed = 0;
  let status: "ok" | "failed" = "ok";
  const errors: { id: string; reason: string }[] = [];
  const idOf = input.candidateId ?? ((c: TCandidate) => (c as { id: string }).id);

  // The deadline binds BOTH modes (C04-1, 2026-09). It used to be computed
  // inside the keyset branch only, so a route that passed `budgetHeaders`
  // without `batchSize` (expire-decomiso-handoffs) was read by the dispatcher
  // fence as honouring the budget while its legacy loop ran every candidate
  // to completion, however late it started.
  const ownCeilingMs = input.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const maxDurationMs = input.budgetHeaders
    ? effectiveDeadlineMs(ownCeilingMs, input.budgetHeaders)
    : ownCeilingMs;
  const start = Date.now();

  try {
    if (input.batchSize && input.batchSize > 0) {
      // Keyset mode: loop bounded pages until exhausted or budget hit. The
      // cursor advances past every candidate we fetch (processed or errored),
      // so an errored row is not re-fetched within the same run — no spin.
      const limit = input.batchSize;
      let cursor: string | null = null;

      loop: for (;;) {
        if (Date.now() - start >= maxDurationMs) break;
        const batch = await input.scan({ afterId: cursor, limit });
        if (batch.length === 0) break;

        for (const candidate of batch) {
          try {
            await input.processOne(candidate);
            itemsProcessed += 1;
          } catch (err) {
            errors.push({
              id: idOf(candidate),
              reason: err instanceof Error ? err.message : "unknown",
            });
          }
          cursor = idOf(candidate);
          if (Date.now() - start >= maxDurationMs) break loop;
        }

        if (batch.length < limit) break; // last page
      }
    } else {
      // Legacy single scan: the scan is bounded by the caller (it must cap its
      // own raw read), and the loop stops at the deadline. Its one caller today,
      // expire-decomiso-handoffs, re-derives candidates from state on every run
      // and escalates idempotently, so a candidate left behind is picked up by
      // the next run rather than lost.
      const candidates = await input.scan();
      for (const candidate of candidates) {
        if (Date.now() - start >= maxDurationMs) break;
        try {
          await input.processOne(candidate);
          itemsProcessed += 1;
        } catch (err) {
          errors.push({
            id: idOf(candidate),
            reason: err instanceof Error ? err.message : "unknown",
          });
        }
      }
    }
  } catch (err) {
    status = "failed";
    errors.push({ id: "global", reason: err instanceof Error ? err.message : "unknown" });
  }

  // A cron with per-candidate errors must NOT report success. Previously `status`
  // only flipped to "failed" on the outer catch (scan threw), so a run where the
  // scan succeeded but every candidate's processOne threw still returned
  // status:"ok" — the classic "reports success on failure" defect. Any error at
  // all (global or per-candidate) means the run was not fully healthy.
  if (errors.length > 0 && status === "ok") {
    status = "failed";
    console.error(
      `[case-cron:${input.name}] ${errors.length} candidate error(s) — run marked failed`,
    );
  }

  await db
    .update(cronRuns)
    .set({
      status,
      finishedAt: new Date(),
      itemsProcessed,
      details: errors.length > 0 ? { errors } : {},
    })
    .where(eq(cronRuns.id, run.id));

  // Page a human on failure (best-effort, no-op when unconfigured).
  if (status === "failed") {
    await sendCronAlert({
      job: input.name,
      severity: "critical",
      error: `${errors.length} error(s) — see cron_runs.details`,
      details: { errors: errors.slice(0, 20) },
    });
  }

  return { runId: run.id, status, itemsProcessed, errors };
}

/**
 * General-purpose cronRuns telemetry wrapper — the sibling of runCaseCron
 * for crons that are NOT candidate/process shaped (scans, queue drains,
 * materializers). Projection-cron audit 2026-07-03 B1: 9 of the 21 fleet
 * crons wrote no cron_runs row, so cron-health reported them "never_ran"
 * forever and a real failure was indistinguishable from silence.
 *
 * Records status='running' before `fn`, finalizes ok/failed after; a throw
 * is recorded (status='failed', error in details) and RE-THROWN so the
 * route's own catch still shapes its 500 response.
 */
export async function withCronRun<T>(
  cronName: string,
  // C-b: `fn` receives the cron_runs row id so long-running callers (the
  // daily dispatcher) can persist PARTIAL progress onto their own row — a
  // hard kill (SIGKILL at maxDuration) used to lose every outcome computed
  // so far, leaving the row at 'running' with empty details. Existing 0-arg
  // callers are unaffected (TS allows a 0-arg function here).
  fn: (runId: string) => Promise<T>,
  summarize?: (result: T) => {
    itemsProcessed?: number;
    details?: Record<string, unknown>;
    /**
     * Partial-failure signal derived from the result counters. When true the
     * run finalizes as status='failed' and an alert fires, EVEN THOUGH `fn`
     * returned normally. This closes the "reports success on failure" defect
     * for non-throwing crons whose result carries error/failed counters
     * (review 23 item 1): a legal-window cron that marked N rows failed must
     * surface as failed so Vercel retries and cron-health pages.
     */
    failed?: boolean;
  },
): Promise<T> {
  const [run] = await db.insert(cronRuns).values({ cronName, status: "running" }).returning();
  try {
    const result = await fn(run.id);
    const summary = summarize?.(result) ?? {};
    const status: "ok" | "failed" = summary.failed ? "failed" : "ok";
    await db
      .update(cronRuns)
      .set({
        status,
        finishedAt: new Date(),
        itemsProcessed: summary.itemsProcessed ?? 0,
        details: summary.details ?? {},
      })
      .where(eq(cronRuns.id, run.id));
    if (status === "failed") {
      await sendCronAlert({
        job: cronName,
        severity: "critical",
        error: "partial failure — see cron_runs.details",
        details: summary.details,
      });
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(cronRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        details: { error: message },
      })
      .where(eq(cronRuns.id, run.id));
    await sendCronAlert({ job: cronName, severity: "critical", error: message });
    throw err;
  }
}

/**
 * Reads a single key from the `details` JSON of the most recently FINISHED run
 * for a cron. The shared primitive behind resumable keyset crons
 * (reconcile-pet-status, business-rules-reeval, materialize-slots): the cursor
 * is piggy-backed on the existing cron_runs telemetry row — no new table or
 * migration. Returns `null` when there is no prior run or the key is absent.
 */
export async function readLastRunDetail<T = unknown>(
  cronName: string,
  key: string,
): Promise<T | null> {
  const [lastRun] = await db
    .select({ details: cronRuns.details })
    .from(cronRuns)
    .where(and(eq(cronRuns.cronName, cronName), isNotNull(cronRuns.finishedAt)))
    .orderBy(desc(cronRuns.startedAt))
    .limit(1);
  if (lastRun?.details && typeof lastRun.details === "object") {
    const v = (lastRun.details as Record<string, unknown>)[key];
    return (v ?? null) as T | null;
  }
  return null;
}

/**
 * Standardized cron request auth check. Returns `null` on success or
 * a `{ ok: false, error, status }` triple on failure that the caller
 * route can serialize directly to NextResponse.json.
 *
 * Delegates to authorizeCronRequest (lib/cron-auth.ts) which accepts both
 * `Authorization: Bearer <CRON_SECRET>` (Vercel contract) and the legacy
 * `x-cron-secret` header.
 *
 * @deprecated Prefer importing `authorizeCronRequest` from `@/lib/cron-auth`
 *   directly. This wrapper exists for routes that already use checkCronSecret
 *   so they can migrate incrementally.
 */
export function checkCronSecret(req: {
  headers: { get(name: string): string | null };
}): { ok: false; error: string; status: number } | null {
  return authorizeCronRequest(req);
}

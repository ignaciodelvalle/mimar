// Cron dispatcher — the ordered fan-out that lets a SINGLE Vercel cron run the
// whole fleet in one invocation.
//
// WHY this exists (Vercel Hobby cron limits, 2026-07-07): vercel.json used to
// declare 22 separate cron jobs. Vercel Hobby allows only 2 cron jobs AND only
// daily schedules, so the deploy failed with "Hobby accounts are limited to
// daily cron jobs." We consolidate the fleet behind one daily dispatcher
// (/api/cron/daily) that invokes every job's existing route handler in order.
//
// This module holds the two pieces that must stay framework-free and unit
// testable:
//   1. DAILY_JOB_ORDER — the SSOT ordered list of job names the dispatcher runs.
//      Kept in lock-step with CRON_REGISTRY + the route directories by
//      __tests__/cron-registry-parity.test.ts.
//   2. dispatchJobs() — runs each job in sequence, isolates failures (one bad
//      job never aborts the rest), and enforces a wall-clock budget so the
//      dispatcher stays inside the function's maxDuration.
//
// The concrete name→handler wiring lives in app/api/cron/daily/route.ts (it
// needs to import the route GETs, which pull in the DB layer); this module
// stays import-light so tests can use it without mocking the whole app.

/**
 * What the dispatcher knows about the run when it starts a job, handed to the
 * job so it can size its own work (RN-3 F17 / RN re-run HIGH, 2026-08-22).
 *
 * Before this, a job drained under ITS OWN constant deadline — data_lifecycle's
 * was 45 s inside a 55 s dispatcher — with no idea how much of the run was
 * already spent. On a backlogged night that ran the purge past the dispatcher's
 * budget and into the function's 60 s hard kill, taking the cron_daily row's
 * finalisation with it.
 */
export interface DispatchContext {
  /**
   * Budget still unspent when the job starts, from the SAME clock reading the
   * dispatcher used to decide the job may run. `Infinity` when no budget was
   * set (tests; manual fan-outs).
   */
  budgetLeftMs: number;
  /** Jobs still to run, INCLUDING this one. Never below 1. */
  jobsLeft: number;
}

/** A single job the dispatcher runs. `run` returns anything with an HTTP-ish
 *  `status` (a Response / NextResponse) so a job is "ok" when status < 400. */
export interface DispatchJob {
  /** snake_case job name — matches the route's CRON_NAME + its cron_runs rows. */
  name: string;
  /**
   * THE DECLARED CEILING (RN #9, 2026-08-22). Wall-clock this job can burn
   * REGARDLESS of what the dispatcher hands it, in ms — i.e. the self-imposed
   * constant of a job that does NOT derive its deadline from
   * CRON_BUDGET_HEADER. The dispatcher refuses to START such a job when less
   * than this is left, so an uncooperative child can never begin late enough
   * to cross the function's 60 s hard kill. A starve becomes a reported
   * `skipped_budget` (it runs tomorrow) instead of a SIGKILL that strands the
   * cron_daily row at 'running' forever.
   *
   * Omit (or 0) for a job that honours the header: what it is handed is by
   * construction never more than what is left, so it cannot overrun and
   * reserving for it would starve the tail for nothing. `reservedCeilingMs`
   * resolves this from CRON_JOB_CEILINGS; the parity fence
   * (__tests__/cron-budget-ceiling.test.ts) refuses a claim the code does not
   * back.
   */
  ceilingMs?: number;
  /** Invokes the job (the route handler, pre-bound to an authorized request). */
  run: (ctx: DispatchContext) => Promise<{ status: number }>;
}

/**
 * THE FAIR-SHARE ARITHMETIC, in one place, used at BOTH levels:
 *
 *     share = min(capMs, floor(budgetLeftMs / jobsLeft))
 *
 * The dispatcher applies it per JOB (what is left of the 55 s, split across the
 * jobs still to run), and data_lifecycle applies it again per TARGET inside its
 * own share. A job that finishes early hands its leftover to the rest by
 * construction — the next share is computed from what is actually left, not
 * from a fixed slice. The last job (data_lifecycle, today) gets everything that
 * remains, capped by its own ceiling. Edges: nothing left is 0, never negative;
 * `jobsLeft` below 1 is treated as 1 rather than divided by.
 */
export function fairShareMs(budgetLeftMs: number, jobsLeft: number, capMs: number): number {
  const divisor = Math.max(1, jobsLeft);
  const share = Math.floor(Math.max(0, budgetLeftMs) / divisor);
  return Math.min(capMs, share);
}

/**
 * The request header the daily dispatcher uses to hand a child handler its
 * fair share. A child that reads it derives its deadline from the run; one
 * that does not (every other job today) keeps its own ceiling. Not a security
 * input — every cron route is secret-gated before it reads anything — and
 * not a middleware-stamped header, so check-api-guard-headers is unaffected.
 */
export const CRON_BUDGET_HEADER = "x-cron-budget-ms";

/**
 * The budget a parent handed down, or null when called standalone (Vercel
 * invoking the route directly, a manual curl) or when the value is not a
 * positive integer. Anything else is treated as "no budget given" so a
 * malformed header can never produce a zero-second deadline.
 */
export function cronBudgetFromHeaders(headers: { get(name: string): string | null }):
  | number
  | null {
  const raw = headers.get(CRON_BUDGET_HEADER);
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Just enough of a Headers/NextRequest.headers to read the budget off it —
 * the shape every job that honours the run's budget accepts (RN #9 half b).
 * Structural, so `req.headers` satisfies it without importing next/server into
 * a module layer that must stay framework-free.
 */
export type CronBudgetHeaders = { get(name: string): string | null };

/**
 * min(own ceiling, budget handed down) — the ONE line every job with a
 * self-imposed ceiling owes the fleet (RN #9 half b, 2026-08-22).
 *
 * Before this, a job drained under its own constant (20-45 s) with no idea how
 * much of the shared 55 s run was already spent, and the dispatcher's budget
 * check only fires BETWEEN jobs — never interrupts one in flight. One
 * backlogged 45 s job starting at ~15 s took the function past its 60 s hard
 * kill and every job behind it with it. Honouring the header bounds the job by
 * what is actually left; standalone (a manual curl, Vercel hitting the route
 * directly) there is no header and the constant is all there is, unchanged.
 *
 * A malformed header is "no budget given" (see cronBudgetFromHeaders), so it
 * can never produce a zero-second deadline.
 */
export function effectiveDeadlineMs(
  ownCeilingMs: number,
  headers: { get(name: string): string | null },
): number {
  const handed = cronBudgetFromHeaders(headers);
  return handed === null ? ownCeilingMs : Math.min(ownCeilingMs, handed);
}

/** One job's self-imposed wall-clock ceiling, and whether its code honours the run's budget. */
export interface CronJobCeiling {
  /** The constant the job's own code enforces on itself, in ms. */
  ceilingMs: number;
  /**
   * True when the job derives its deadline from CRON_BUDGET_HEADER
   * (`effectiveDeadlineMs(own, req.headers)`, or a helper handed those
   * headers). The parity fence reads the route source and refuses a claim the
   * code does not back — that is what keeps this table from drifting into
   * fiction, and what turns "a new cron route with a 45 s ceiling" into a red
   * test instead of a fleet-wide outage.
   */
  honoursBudget: boolean;
  /** Repo-relative file the ceiling constant lives in (the fence reads it). */
  declaredIn: string;
}

/**
 * Every job in the daily fleet that bounds itself with a wall-clock constant.
 *
 * The census that produced it (RN #9): 22 of 23 jobs kept their own 20-45 s
 * ceiling while only data_lifecycle read the dispatcher's header. Ten of them
 * carried a full 45 s — inside a 55 s shared budget, in a 60 s function.
 *
 * CORRECTED 2026-08-22 (fresh-context review): the first version of this table
 * said "14 jobs" and listed 14. It was produced by a sweep that read only
 * app/api/cron/<dir>/route.ts, so it saw none of the six jobs whose ceiling
 * lives in a module the route imports — five of them TWO hops away. Those six
 * were therefore unknown to reservedCeilingMs (which returns 0 for an unknown
 * job by design), so the dispatcher happily started, say,
 * expire_caretaker_grants at elapsed 54 s; the job then ran its own 45 s clock
 * for a 99 s total and the function was SIGKILLed at 60 s, stranding the
 * cron_daily row at 'running' forever. That is verbatim the scenario the
 * ceiling work claimed to have eliminated. The real count is 20; the parity
 * fence now follows the route's imports two hops so the majority pattern is
 * visible to it, and every daily job must be either in this table or in the
 * fence's explicit CEILING_EXEMPT list.
 */
export const CRON_JOB_CEILINGS: Readonly<Record<string, CronJobCeiling>> = {
  // --- ceiling declared in the route file itself ---
  business_rules_reeval: {
    ceilingMs: 20_000,
    honoursBudget: true,
    declaredIn: "app/api/cron/business-rules-reeval/route.ts",
  },
  reconcile_pet_status: {
    ceilingMs: 20_000,
    honoursBudget: true,
    declaredIn: "app/api/cron/reconcile-pet-status/route.ts",
  },
  auto_expire_approvals: {
    ceilingMs: 45_000,
    honoursBudget: true,
    declaredIn: "app/api/cron/auto-expire-approvals/route.ts",
  },
  process_eno_queue: {
    ceilingMs: 45_000,
    honoursBudget: true,
    declaredIn: "app/api/cron/process-eno-queue/route.ts",
  },
  drain_outbox: {
    ceilingMs: 45_000,
    honoursBudget: true,
    declaredIn: "app/api/cron/drain-outbox/route.ts",
  },
  // --- ceiling declared in a helper the route calls ---
  vaccine_due: {
    ceilingMs: 45_000,
    honoursBudget: true,
    declaredIn: "lib/infra/notifications.ts",
  },
  post_adoption_checkin: {
    ceilingMs: 45_000,
    honoursBudget: true,
    declaredIn: "lib/infra/notifications.ts",
  },
  purge_scan_events: {
    ceilingMs: 45_000,
    honoursBudget: true,
    declaredIn: "lib/infra/scan-retention.ts",
  },
  data_lifecycle: {
    ceilingMs: 45_000,
    honoursBudget: true,
    declaredIn: "lib/infra/data-lifecycle.ts",
  },
  // --- ceiling inherited from runCaseCron's keyset-loop default ---
  expire_cross_org_transfers: {
    ceilingMs: 45_000,
    honoursBudget: true,
    declaredIn: "lib/infra/case-cron.ts",
  },
  close_stale_lost_episodes: {
    ceilingMs: 45_000,
    honoursBudget: true,
    declaredIn: "lib/infra/case-cron.ts",
  },
  close_followup_expired_adoptions: {
    ceilingMs: 45_000,
    honoursBudget: true,
    declaredIn: "lib/infra/case-cron.ts",
  },
  escalate_stale_welfare_cases: {
    ceilingMs: 45_000,
    honoursBudget: true,
    declaredIn: "lib/infra/case-cron.ts",
  },
  escalate_stale_disputes: {
    ceilingMs: 45_000,
    honoursBudget: true,
    declaredIn: "lib/infra/case-cron.ts",
  },
  expire_decomiso_handoffs: {
    ceilingMs: 45_000,
    honoursBudget: true,
    declaredIn: "lib/infra/case-cron.ts",
  },
  // --- ceiling declared in the module action the route calls (the six the
  //     route-only census could not see; five of them two imports away) ---
  materialize_slots: {
    ceilingMs: 45_000,
    honoursBudget: true,
    declaredIn:
      "src/modules/service-offerings/application/slot-materialization/materialize-slots.ts",
  },
  evaluate_alerts: {
    ceilingMs: 45_000,
    honoursBudget: true,
    declaredIn: "src/modules/alerts/application/firings/record-firings.ts",
  },
  expire_caretaker_grants: {
    ceilingMs: 45_000,
    honoursBudget: true,
    declaredIn: "src/modules/caretakers/actions.ts",
  },
  expire_pet_transfers: {
    ceilingMs: 45_000,
    honoursBudget: true,
    declaredIn: "src/modules/transfers/actions.ts",
  },
  expire_foster_proposals: {
    ceilingMs: 45_000,
    honoursBudget: true,
    declaredIn: "src/modules/foster/infrastructure/foster-repository.ts",
  },
  // --- security review 2026-09-18: was CEILING_EXEMPT as "bounded by rows",
  //     which bounded the row count and not the time ---
  daily_operator_digest: {
    ceilingMs: 30_000,
    honoursBudget: true,
    declaredIn: "lib/infra/daily-operator-digest.ts",
  },
};

/**
 * What the dispatcher must reserve before starting `jobName`: nothing when the
 * job honours the budget it is handed (it cannot outlast it), its own ceiling
 * when it does not, and nothing for a job we know no ceiling for — never
 * starve the tail on a guess.
 */
export function reservedCeilingMs(jobName: string): number {
  const declared = CRON_JOB_CEILINGS[jobName];
  if (!declared || declared.honoursBudget) return 0;
  return declared.ceilingMs;
}

export type DispatchJobStatus = "ok" | "failed" | "threw" | "skipped_budget";

export interface DispatchOutcome {
  name: string;
  status: DispatchJobStatus;
  /** HTTP status the job's handler returned (null when it threw / was skipped). */
  httpStatus: number | null;
  /** Error message when the handler threw (null otherwise). */
  error: string | null;
  durationMs: number;
}

export interface DispatchResult {
  outcomes: DispatchOutcome[];
  /** Jobs whose handler was actually invoked this run. */
  ran: number;
  /** Jobs that returned HTTP >= 400 OR threw. */
  failed: number;
  /** Jobs skipped because the wall-clock budget was exhausted. */
  skipped: number;
}

export interface DispatchOptions {
  /**
   * Wall-clock budget for the whole run (ms). Before each job the dispatcher
   * checks the elapsed time; once the budget is hit the remaining jobs are
   * recorded as `skipped_budget` (they run on the next daily invocation — every
   * job is idempotent / resumable). Default: no budget (run all).
   */
  budgetMs?: number;
  /** Injectable clock for tests. Default: Date.now. */
  now?: () => number;
  /**
   * C-b: called after EACH job's outcome is recorded (including
   * `skipped_budget`), before the next job starts. The daily route uses it to
   * persist partial progress onto its cron_runs row so a hard kill
   * (SIGKILL at maxDuration) no longer loses every outcome computed so far.
   * A throwing callback is contained (logged, never aborts the fleet).
   */
  onOutcome?: (outcome: DispatchOutcome, soFar: readonly DispatchOutcome[]) => Promise<void> | void;
}

/**
 * Runs `jobs` in order, each isolated in its own try/catch so a single failing
 * job never aborts the fleet. Returns a per-job outcome report.
 *
 * Failure semantics: a job is `failed` when its handler returns HTTP >= 400,
 * `threw` when the handler throws, `ok` when it returns < 400. `failed` in the
 * result counts both `failed` and `threw`. Budget-skipped jobs are counted
 * separately (they are not failures — they simply did not run this invocation).
 */
export async function dispatchJobs(
  jobs: DispatchJob[],
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const now = options.now ?? (() => Date.now());
  const budgetMs = options.budgetMs ?? Number.POSITIVE_INFINITY;
  const start = now();

  const outcomes: DispatchOutcome[] = [];
  let ran = 0;
  let failed = 0;
  let skipped = 0;

  // C-b: report each outcome as soon as it exists — contained so a broken
  // persistence callback can never take the fleet down with it.
  const report = async (outcome: DispatchOutcome) => {
    if (!options.onOutcome) return;
    try {
      await options.onOutcome(outcome, outcomes);
    } catch (err) {
      console.error(`[cron-dispatcher] onOutcome failed after ${outcome.name}:`, err);
    }
  };

  for (const [index, job] of jobs.entries()) {
    // ONE clock reading decides both "may this job run" and "how much is left
    // for it": a second reading between the two could disagree with the first.
    const elapsed = now() - start;
    const remaining = budgetMs - elapsed;
    // Two ways to be out of time, one outcome. The second is the DECLARED
    // ceiling (RN #9): a job that burns its own constant no matter what we
    // hand it must not START unless that constant fits in what is left —
    // otherwise it runs past the function's hard kill and takes the whole
    // tail, plus this run's telemetry, down with it. A job that honours the
    // header reserves nothing (see DispatchJob.ceilingMs).
    if (remaining <= 0 || remaining < (job.ceilingMs ?? 0)) {
      const outcome: DispatchOutcome = {
        name: job.name,
        status: "skipped_budget",
        httpStatus: null,
        error: null,
        durationMs: 0,
      };
      outcomes.push(outcome);
      skipped += 1;
      await report(outcome);
      continue;
    }
    const ctx: DispatchContext = {
      budgetLeftMs: remaining,
      jobsLeft: jobs.length - index,
    };

    const jobStart = now();
    try {
      const res = await job.run(ctx);
      const durationMs = now() - jobStart;
      const ok = res.status < 400;
      const outcome: DispatchOutcome = {
        name: job.name,
        status: ok ? "ok" : "failed",
        httpStatus: res.status,
        error: null,
        durationMs,
      };
      outcomes.push(outcome);
      ran += 1;
      if (!ok) failed += 1;
      await report(outcome);
    } catch (err) {
      const durationMs = now() - jobStart;
      const outcome: DispatchOutcome = {
        name: job.name,
        status: "threw",
        httpStatus: null,
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      };
      outcomes.push(outcome);
      ran += 1;
      failed += 1;
      await report(outcome);
    }
  }

  return { outcomes, ran, failed, skipped };
}

/**
 * Ordered SSOT of the job names the daily dispatcher runs — every cron that was
 * previously its own vercel.json entry.
 *
 * Order rationale (S8, revised; C-b 2026-08-16): the delivery drains
 * (process_eno_queue, drain_outbox, drain_notification_dead_letter) run right
 * after the first, cheap producer batch (materialize_slots..evaluate_alerts)
 * — BEFORE the heavier expiry/escalation/retention block. Previously the
 * drains sat near the END of the list (after that whole heavy block), so a
 * tight BUDGET_MS cutoff could skip them entirely, starving delivery
 * indefinitely rather than by a bounded one-day delay. Running them early
 * means a budget cutoff now only defers a LATER job's own outbox rows to the
 * next daily invocation — every job is idempotent/resumable, so that's an
 * acceptable trade for "delivery never starved".
 *
 * cron_health runs FIRST — a DELIBERATE REVERSAL (C-b, governance review
 * 2026-08-15) of the earlier "last, so it sees this run's fresh telemetry"
 * decision. The old position had a structurally worse failure mode: any
 * earlier job hard-killing the function meant the one job whose purpose is
 * detecting a dead fleet never ran AT ALL — and nothing noticed, because the
 * thing that would notice was the thing that didn't run. First guarantees it
 * executes every day; the cost is that it examines YESTERDAY's runs, so a
 * same-day cascade surfaces one day later. That lag is bounded; the silence
 * was not.
 *
 * Sub-daily jobs are folded to daily here (drain_outbox, process_eno_queue,
 * drain_notification_dead_letter, expire_decomiso_handoffs). Vercel Hobby only
 * supports daily schedules, so sub-daily cadence is impossible on Hobby
 * regardless of cron count — the minimum plan for sub-daily draining is Pro.
 */
export const DAILY_JOB_ORDER: readonly string[] = [
  // --- fleet health (FIRST — deliberate reversal, see header) ---
  "cron_health",
  // --- producers / scans / materializers (cheap) ---
  "materialize_slots",
  "business_rules_reeval",
  "reconcile_pet_status",
  "vaccine_due",
  "post_adoption_checkin",
  "evaluate_alerts",
  // --- delivery drains (moved earlier, S8: never starved by the budget) ---
  "process_eno_queue",
  "drain_outbox",
  "drain_notification_dead_letter",
  // The delivery drains answer "did we send it"; this one answers "did it land",
  // which is the question Expo only settles after the fact. It sits with them
  // rather than with the purges because it is part of a SEND — the half that
  // could not run on the request path — and because what it produces (a revoked
  // dead target) is what the retention purge downstream eventually collects.
  "reconcile_push_receipts",
  // --- expiries / escalations / case closers ---
  "auto_expire_approvals",
  "expire_caretaker_grants",
  "expire_foster_proposals",
  "expire_pet_transfers",
  "expire_cross_org_transfers",
  "expire_decomiso_handoffs",
  "close_rabies_observations",
  "close_stale_lost_episodes",
  "close_followup_expired_adoptions",
  "escalate_stale_welfare_cases",
  "escalate_stale_disputes",
  // The operator digest runs AFTER every delivery drain (security review
  // 2026-09-18). It used to sit in the producer block, ahead of the drains —
  // the exact position the S8 note above says starves delivery: a slow digest
  // night (a Resend call per recipient) spent the budget the drains needed.
  // A digest is a convenience summary and a drain is a legal notification;
  // the convenience goes last. After the expiry/escalation block on purpose,
  // too: the counts it mails are then the ones left after today's expiries.
  // Ahead of the purges only because data_lifecycle is built to take whatever
  // remains, and the digest honours its fair share like every other job.
  "daily_operator_digest",
  // --- retention purges ---
  "purge_scan_events",
  "data_lifecycle",
] as const;

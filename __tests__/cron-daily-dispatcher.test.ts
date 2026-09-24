// Unit tests for the daily cron dispatcher's core fan-out (dispatchJobs).
//
// The dispatcher (app/api/cron/daily/route.ts) folds the whole cron fleet into
// one daily Vercel invocation. The contract that matters:
//   1. It calls EVERY registered job.
//   2. A failing job (throws OR returns HTTP >= 400) does NOT abort the rest.
//   3. Jobs are run in the declared order.
//   4. A wall-clock budget skips the tail (they run next invocation) without
//      counting as failures.
//
// dispatchJobs is pure (no DB / no Next.js), so these tests run without mocks.

import { describe, expect, it } from "vitest";

import {
  CRON_BUDGET_HEADER,
  DAILY_JOB_ORDER,
  type DispatchContext,
  type DispatchJob,
  cronBudgetFromHeaders,
  dispatchJobs,
  fairShareMs,
} from "@/lib/infra/cron-dispatcher";

function okJob(name: string, calls: string[]): DispatchJob {
  return {
    name,
    run: async () => {
      calls.push(name);
      return { status: 200 };
    },
  };
}

describe("dispatchJobs", () => {
  it("calls every job and reports all ok", async () => {
    const calls: string[] = [];
    const jobs = ["a", "b", "c"].map((n) => okJob(n, calls));

    const result = await dispatchJobs(jobs);

    expect(calls).toEqual(["a", "b", "c"]);
    expect(result.ran).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.outcomes.map((o) => o.status)).toEqual(["ok", "ok", "ok"]);
  });

  it("a THROWING job does not abort the rest", async () => {
    const calls: string[] = [];
    const jobs: DispatchJob[] = [
      okJob("first", calls),
      {
        name: "boom",
        run: async () => {
          calls.push("boom");
          throw new Error("kaboom");
        },
      },
      okJob("third", calls),
    ];

    const result = await dispatchJobs(jobs);

    // The job after the failure still ran.
    expect(calls).toEqual(["first", "boom", "third"]);
    expect(result.ran).toBe(3);
    expect(result.failed).toBe(1);
    const boom = result.outcomes.find((o) => o.name === "boom");
    expect(boom?.status).toBe("threw");
    expect(boom?.error).toBe("kaboom");
    // Neighbours unaffected.
    expect(result.outcomes.find((o) => o.name === "third")?.status).toBe("ok");
  });

  it("a job returning HTTP >= 400 is counted failed but does not abort the rest", async () => {
    const calls: string[] = [];
    const jobs: DispatchJob[] = [
      {
        name: "server_error",
        run: async () => {
          calls.push("server_error");
          return { status: 500 };
        },
      },
      okJob("after", calls),
    ];

    const result = await dispatchJobs(jobs);

    expect(calls).toEqual(["server_error", "after"]);
    expect(result.failed).toBe(1);
    expect(result.outcomes.find((o) => o.name === "server_error")?.status).toBe("failed");
    expect(result.outcomes.find((o) => o.name === "after")?.status).toBe("ok");
  });

  it("skips the tail once the wall-clock budget is exhausted", async () => {
    const calls: string[] = [];
    // Injectable clock: each now() reading advances 40ms so the 2nd job trips
    // the 50ms budget before it runs.
    let t = 0;
    const now = () => {
      const v = t;
      t += 40;
      return v;
    };
    const jobs = ["one", "two", "three"].map((n) => okJob(n, calls));

    const result = await dispatchJobs(jobs, { budgetMs: 50, now });

    // "one" ran; "two"/"three" were skipped by the budget (not failures).
    expect(calls).toEqual(["one"]);
    expect(result.ran).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.outcomes.filter((o) => o.status === "skipped_budget").map((o) => o.name)).toEqual(
      ["two", "three"],
    );
  });

  // -------------------------------------------------------------------------
  // Fair share (RN-3 F17 / RN re-run HIGH, 2026-08-22)
  //
  // data_lifecycle drained under its OWN 45 s deadline inside a dispatcher
  // whose whole budget is 55 s. Nothing told a job how much of the run was
  // left, so a backlogged night could run the purge past the dispatcher's
  // budget and into the function's 60 s hard kill. The dispatcher now hands
  // every job the budget that remains and how many jobs still share it; the
  // job derives its deadline from that instead of from a constant.
  // -------------------------------------------------------------------------

  it("hands each job the budget left and the number of jobs still to run", async () => {
    const seen: DispatchContext[] = [];
    let t = 0;
    // Each now() reading advances 10ms; the budget check before each job is
    // the reading that also feeds budgetLeftMs, so the two never disagree.
    const now = () => {
      const v = t;
      t += 10;
      return v;
    };
    const jobs: DispatchJob[] = ["a", "b", "c"].map((name) => ({
      name,
      run: async (ctx) => {
        seen.push(ctx);
        return { status: 200 };
      },
    }));

    await dispatchJobs(jobs, { budgetMs: 1000, now });

    expect(seen.map((c) => c.jobsLeft)).toEqual([3, 2, 1]);
    // Strictly decreasing: every later job sees less budget than the one before.
    expect(seen[0].budgetLeftMs).toBeGreaterThan(seen[1].budgetLeftMs);
    expect(seen[1].budgetLeftMs).toBeGreaterThan(seen[2].budgetLeftMs);
    expect(seen[0].budgetLeftMs).toBeLessThanOrEqual(1000);
  });

  it("reports an unbounded budget as Infinity when no budget was set", async () => {
    const seen: DispatchContext[] = [];
    await dispatchJobs([
      {
        name: "only",
        run: async (ctx) => {
          seen.push(ctx);
          return { status: 200 };
        },
      },
    ]);
    expect(seen).toEqual([{ budgetLeftMs: Number.POSITIVE_INFINITY, jobsLeft: 1 }]);
  });

  it("fairShareMs: the remaining budget split evenly across the jobs still to run, capped", () => {
    // THE ARITHMETIC, written out: share = min(cap, floor(left / jobsLeft)).
    expect(fairShareMs(30_000, 3, 45_000)).toBe(10_000);
    // The LAST job gets everything that is left — data_lifecycle's case.
    expect(fairShareMs(12_345, 1, 45_000)).toBe(12_345);
    // …but never more than its own ceiling.
    expect(fairShareMs(50_000, 1, 45_000)).toBe(45_000);
    // No budget at all → the ceiling is the only bound.
    expect(fairShareMs(Number.POSITIVE_INFINITY, 5, 45_000)).toBe(45_000);
    // Defensive edges: nothing left is zero (never negative), and a zero or
    // negative job count is treated as one rather than dividing by it.
    expect(fairShareMs(-5, 2, 45_000)).toBe(0);
    expect(fairShareMs(9_000, 0, 45_000)).toBe(9_000);
  });

  it("cronBudgetFromHeaders reads a positive integer budget and rejects everything else", () => {
    const withBudget = new Headers({ [CRON_BUDGET_HEADER]: "12345" });
    expect(cronBudgetFromHeaders(withBudget)).toBe(12_345);
    expect(cronBudgetFromHeaders(new Headers())).toBeNull();
    for (const bad of ["", "abc", "-1", "0", "1.5", "Infinity", "NaN"]) {
      expect(cronBudgetFromHeaders(new Headers({ [CRON_BUDGET_HEADER]: bad }))).toBeNull();
    }
  });

  it("the delivery drains run BEFORE every retention purge (S8, pinned)", () => {
    // On a backlogged night the budget skips the TAIL of the list. If the
    // purges ran before the drains, `drain_notification_dead_letter` would be
    // `skipped_budget` — a warning, fleet green — while notifications sat
    // undelivered. The SSOT already orders them this way; this pins it so a
    // reorder cannot quietly starve delivery again.
    const position = (name: string) => DAILY_JOB_ORDER.indexOf(name);
    for (const drain of ["process_eno_queue", "drain_outbox", "drain_notification_dead_letter"]) {
      expect(position(drain)).toBeGreaterThan(-1);
      for (const purge of ["purge_scan_events", "data_lifecycle"]) {
        expect(position(drain)).toBeLessThan(position(purge));
      }
    }
  });

  it("the operator digest runs AFTER every delivery drain (security review 2026-09-18, pinned)", () => {
    // It first landed in the producer block, ahead of the drains: a slow
    // digest night (one Resend call per recipient) could spend the budget the
    // legal-notification drains needed. A summary mail never outranks delivery.
    const position = (name: string) => DAILY_JOB_ORDER.indexOf(name);
    const digest = position("daily_operator_digest");
    expect(digest).toBeGreaterThan(-1);
    for (const drain of [
      "process_eno_queue",
      "drain_outbox",
      "drain_notification_dead_letter",
      "reconcile_push_receipts",
    ]) {
      expect(position(drain), drain).toBeGreaterThan(-1);
      expect(digest, `daily_operator_digest must run after ${drain}`).toBeGreaterThan(
        position(drain),
      );
    }
    // And after today's expiries, so the counts it mails are what is left.
    expect(digest).toBeGreaterThan(position("auto_expire_approvals"));
  });

  it("DAILY_JOB_ORDER covers the whole fleet without duplicates", () => {
    // Guards the SSOT list itself: 25 jobs, all unique.
    // 24 -> 25 on 2026-09-18 with daily-operator-digest (T2-N1) — the commit
    // that added the job left this count at 24, so this test was red on main.
    // 23 -> 24 on 2026-09-15 with reconcile-push-receipts: the second half of a
    // native push send, which cannot run on the request path because Expo does
    // not know the answer yet (see the route's header).
    // 22 -> 23 on 2026-08-19 with expire-caretaker-grants (custodia-temporal C6).
    expect(DAILY_JOB_ORDER.length).toBe(25);
    expect(new Set(DAILY_JOB_ORDER).size).toBe(25);
  });

  it("C-b: cron_health runs FIRST — the deliberate reversal", () => {
    // The one job whose purpose is detecting a dead fleet must be immune to
    // anything that happens later in the run. See the header's rationale.
    expect(DAILY_JOB_ORDER[0]).toBe("cron_health");
  });

  it("C-b: onOutcome fires once per job, in order, before the next job starts", async () => {
    const seen: Array<{ name: string; soFarLen: number; callsAtReport: number }> = [];
    const calls: string[] = [];
    const jobs = ["one", "two"].map((n) => okJob(n, calls));

    await dispatchJobs(jobs, {
      onOutcome: (outcome, soFar) => {
        seen.push({ name: outcome.name, soFarLen: soFar.length, callsAtReport: calls.length });
      },
    });

    expect(seen.map((s) => s.name)).toEqual(["one", "two"]);
    // "one"'s report fired while only "one" had run — before "two" started.
    expect(seen[0]).toEqual({ name: "one", soFarLen: 1, callsAtReport: 1 });
    expect(seen[1]).toEqual({ name: "two", soFarLen: 2, callsAtReport: 2 });
  });

  it("C-b: onOutcome fires for budget-skipped jobs too, and a throwing callback never aborts the fleet", async () => {
    const reported: string[] = [];
    const calls: string[] = [];
    let t = 0;
    const now = () => {
      const v = t;
      t += 40;
      return v;
    };
    const jobs = ["one", "two"].map((n) => okJob(n, calls));

    const result = await dispatchJobs(jobs, {
      budgetMs: 50,
      now,
      onOutcome: (outcome) => {
        reported.push(`${outcome.name}:${outcome.status}`);
        throw new Error("persistence exploded");
      },
    });

    // The skip was reported AND the throwing callback was contained.
    expect(reported).toEqual(["one:ok", "two:skipped_budget"]);
    expect(result.ran).toBe(1);
    expect(result.skipped).toBe(1);
  });
});

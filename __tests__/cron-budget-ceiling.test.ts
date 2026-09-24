// The cron budget stops being advisory — declared ceilings + honoured header.
//
// WHY (RN #9 / fix queue row 10, 2026-08-22): the daily dispatcher computes a
// fair share and hands it down in `x-cron-budget-ms`, but only data_lifecycle
// ever read it. The other 22 jobs kept their OWN 20-45 s ceilings, and the
// dispatcher's budget check only fires BETWEEN jobs — never interrupts one in
// flight. Measured with a harness against the real module:
//
//   - normal night: 34.5 s, 23 run, 0 skipped.
//   - ONE backlogged ceiling-hitter: 55.5 s, 8 run, 15 skipped — the skipped
//     tail is drain_outbox, drain_notification_dead_letter, the rabies-window
//     closer and the Ley 25.326 retention purge.
//   - the same job starting late: the function crosses its 60 s hard kill and
//     is SIGKILLed, leaving the cron_daily row at 'running' forever.
//   - counterfactual: if every child honoured the header, the same load
//     finishes all 23 in 36.7 s with no hard kill.
//
// Two halves, both pinned here:
//   (a) the ceiling is DECLARED — the dispatcher refuses to START a job when
//       less is left than that job will burn regardless of what it is handed,
//       so an uncooperative child can never start late enough to cross 60 s.
//       A starve becomes a clean, reported `skipped_budget` instead of a kill.
//   (b) every job with a ceiling derives its deadline from
//       min(own ceiling, budget handed down) — the parity fence below goes RED
//       for any route that declares a ceiling without reading the header.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CRON_BUDGET_HEADER,
  CRON_JOB_CEILINGS,
  DAILY_JOB_ORDER,
  type DispatchJob,
  dispatchJobs,
  effectiveDeadlineMs,
  reservedCeilingMs,
} from "@/lib/infra/cron-dispatcher";

const ROOT = join(__dirname, "..");
const CRON_DIR = join(ROOT, "app", "api", "cron");

// The dispatcher itself is not a job; refresh-cube is standalone-scheduled with
// its own 300 s function pin, outside the daily budget entirely.
const NOT_A_BUDGETED_JOB = new Set(["daily", "refresh-cube"]);

// app/api/cron/daily/route.ts — the real numbers the fleet runs under.
const BUDGET_MS = 55_000;
// vercel.json maxDuration for the function the whole fleet shares.
const HARD_KILL_MS = 60_000;

/** snake_case job name -> kebab-case route directory. */
function routeDirOf(jobName: string): string {
  return jobName.replace(/_/g, "-");
}

function headers(map: Record<string, string>): { get(name: string): string | null } {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

/** Reads a source file the ceiling table points at. */
function readSource(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

// A self-imposed wall-clock ceiling constant: `const FOO_MAX_DURATION_MS = 45_000`.
const CEILING_CONSTANT = /(?:^|\n)\s*(?:export\s+)?const\s+[A-Z0-9_]*MAX_DURATION_MS\s*=\s*[\d_]+/;

// Proof that a module derives its deadline from the run instead of a constant.
//
// The `budgetHeaders` alternative is DELEGATION: the route hands the headers to
// a helper and the helper must honour them. That is only as true as the helper.
// C04-1 (2026-09) was the case where it was not: expire-decomiso-handoffs passed
// `budgetHeaders` to runCaseCron without `batchSize`, and runCaseCron read the
// budget only inside its keyset loop — so this regex certified a route whose
// loop ignored the deadline entirely. runCaseCron now bounds both modes, and
// that is pinned BEHAVIOURALLY in __tests__/cron-case-cron-routes.test.ts
// ("runCaseCron — the deadline binds the unbatched mode too"), not by this text.
const READS_THE_BUDGET = /effectiveDeadlineMs|cronBudgetFromHeaders|budgetHeaders/;

// A first-party import: `import { x } from "@/lib/…"` or a relative path.
// Package imports are not followed — a ceiling we must reserve for is ours.
const IMPORT_SPEC = /(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']/g;

/**
 * Why the sweep follows imports (fresh-context review, 2026-08-22): the first
 * version of this fence scanned ONLY app/api/cron/<dir>/route.ts for the
 * ceiling constant. That is the MINORITY pattern — 15 of the 20 ceiling-bearing
 * jobs declare theirs in a helper the route calls, five of them two hops away
 * (expire-foster-proposals/route.ts -> foster/actions.ts ->
 * foster-repository.ts). So the sweep certified a table that was missing six
 * jobs, and both non-vacuity floors passed anyway. Depth 2 is what it takes to
 * reach every declaring module in the fleet today; it is also the depth at
 * which the walk still visits <= ~25 files per route.
 */
const IMPORT_DEPTH = 2;

/**
 * Modules whose ceiling constant binds only a caller that opts into it.
 *
 * lib/infra/case-cron.ts declares DEFAULT_MAX_DURATION_MS, but only
 * runCaseCron() enforces it. A route that imports the module for withCronRun()
 * / readLastRunDetail() (which record a run, they do not bound it) is NOT
 * bounded by that constant — counting it there would flag jobs that have no
 * wall-clock ceiling at all and push them into the exempt list for the wrong
 * reason.
 */
const CONDITIONAL_CEILING_SOURCES: Readonly<Record<string, RegExp>> = {
  "lib/infra/case-cron.ts": /\brunCaseCron\s*[(<]/,
};

/**
 * Daily jobs with NO wall-clock ceiling for the dispatcher to reserve, and why.
 *
 * Shrink-only by intent: the test below asserts each of these reaches ZERO
 * ceiling-declaring modules, so adding a wall-clock deadline to one of them
 * turns this list RED instead of letting the job quietly inherit an exemption
 * it no longer deserves.
 */
const CEILING_EXEMPT: Readonly<Record<string, string>> = {
  cron_health:
    "reads yesterday's cron_runs with per-query .limit(1); no loop, no wall-clock deadline",
  close_rabies_observations:
    "keyset page + resume cursor (afterId) bounds the work by ROWS; withCronRun only records the run",
  drain_notification_dead_letter: "bounded by BATCH_SIZE = 200 rows per invocation, not by clock",
  reconcile_push_receipts:
    "bounded by RECEIPT_BATCH_SIZE = 1000 rows read once per invocation, not by clock; no keyset loop",
};

const srcCache = new Map<string, string>();
function cachedSource(absPath: string): string {
  let src = srcCache.get(absPath);
  if (src === undefined) {
    src = readFileSync(absPath, "utf8");
    srcCache.set(absPath, src);
  }
  return src;
}

/** Resolves a first-party import specifier to a file on disk, or null. */
function resolveImport(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Repo-relative, forward-slashed — matches how CRON_JOB_CEILINGS.declaredIn is written. */
function relPath(absPath: string): string {
  return absPath.slice(ROOT.length + 1).replace(/\\/g, "/");
}

/**
 * Every ceiling-declaring module reachable from a cron route within
 * IMPORT_DEPTH hops of first-party imports, conditional sources filtered by
 * whether the route actually calls the enforcing helper.
 */
function reachableCeilingModules(routeFile: string): string[] {
  const routeSrc = cachedSource(routeFile);
  const seen = new Set<string>([routeFile]);
  let frontier = [routeFile];
  const hits = new Set<string>();

  for (let depth = 0; depth <= IMPORT_DEPTH; depth++) {
    const next: string[] = [];
    for (const file of frontier) {
      const src = cachedSource(file);
      if (CEILING_CONSTANT.test(src)) {
        const rel = relPath(file);
        const conditional = CONDITIONAL_CEILING_SOURCES[rel];
        if (!conditional || conditional.test(routeSrc)) hits.add(rel);
      }
      if (depth === IMPORT_DEPTH) continue;
      IMPORT_SPEC.lastIndex = 0;
      let match = IMPORT_SPEC.exec(src);
      while (match !== null) {
        const resolved = resolveImport(match[1], file);
        if (resolved !== null && !seen.has(resolved)) {
          seen.add(resolved);
          next.push(resolved);
        }
        match = IMPORT_SPEC.exec(src);
      }
    }
    frontier = next;
  }
  return [...hits].sort();
}

/** Every budgeted cron job on disk, with the ceiling modules it can reach. */
function sweepFleet(): { job: string; routeFile: string; ceilings: string[] }[] {
  const fleet: { job: string; routeFile: string; ceilings: string[] }[] = [];
  for (const entry of readdirSync(CRON_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || NOT_A_BUDGETED_JOB.has(entry.name)) continue;
    const routeFile = join(CRON_DIR, entry.name, "route.ts");
    if (!existsSync(routeFile)) continue;
    fleet.push({
      job: entry.name.replace(/-/g, "_"),
      routeFile,
      ceilings: reachableCeilingModules(routeFile),
    });
  }
  return fleet;
}

describe("cron budget — (a) the ceiling is declared, so a starve is a skip and not a kill", () => {
  it("ONE uncooperative ceiling-hitter at position 5 no longer pushes the fleet past the 60s hard kill", async () => {
    // The measured scenario, on a fake clock: four cheap jobs, then a job that
    // burns its whole 45 s ceiling, then eighteen more that would each do the
    // same if the dispatcher let them start.
    const CHEAP_MS = 100;
    const CEILING_MS = 45_000;
    const CHEAP_HEAD = 4;

    let clock = 0;
    const now = () => clock;
    const started: string[] = [];

    const jobs: DispatchJob[] = DAILY_JOB_ORDER.map((name, index) => {
      const uncooperative = index >= CHEAP_HEAD;
      return {
        name,
        // What this job burns no matter what the dispatcher hands it.
        ceilingMs: uncooperative ? CEILING_MS : 0,
        run: async () => {
          started.push(name);
          clock += uncooperative ? CEILING_MS : CHEAP_MS;
          return { status: 200 };
        },
      };
    });

    const result = await dispatchJobs(jobs, { budgetMs: BUDGET_MS, now });

    // THE POINT: the function is never SIGKILLed, so cron_daily always gets to
    // finalise its row instead of staying at 'running' forever.
    expect(clock).toBeLessThanOrEqual(HARD_KILL_MS);

    // Only the cheap head plus the single ceiling-hitter it could afford.
    expect(started).toEqual([...DAILY_JOB_ORDER.slice(0, CHEAP_HEAD + 1)]);

    // Everything after is DECLARED skipped — reported, alerted on, and run by
    // tomorrow's invocation. Not silently lost.
    const tail = result.outcomes.slice(CHEAP_HEAD + 1);
    expect(tail.length).toBe(DAILY_JOB_ORDER.length - CHEAP_HEAD - 1);
    expect(tail.every((o) => o.status === "skipped_budget")).toBe(true);
    expect(result.skipped).toBe(tail.length);
  });

  it("a job that honours the header (no reserved ceiling) still runs on whatever is left", async () => {
    let clock = 0;
    const now = () => clock;
    const started: string[] = [];

    const jobs: DispatchJob[] = [
      {
        name: "hog",
        ceilingMs: 45_000,
        run: async () => {
          started.push("hog");
          clock += 45_000;
          return { status: 200 };
        },
      },
      // No ceilingMs: it derives its deadline from the header, so what it is
      // handed can never exceed what is left.
      {
        name: "cooperative",
        run: async (ctx) => {
          started.push("cooperative");
          clock += Math.min(45_000, ctx.budgetLeftMs);
          return { status: 200 };
        },
      },
    ];

    const result = await dispatchJobs(jobs, { budgetMs: BUDGET_MS, now });

    expect(started).toEqual(["hog", "cooperative"]);
    expect(result.skipped).toBe(0);
    expect(clock).toBeLessThanOrEqual(HARD_KILL_MS);
  });

  it("an unbudgeted run (no budgetMs) never reserves anything", async () => {
    const started: string[] = [];
    const jobs: DispatchJob[] = ["a", "b"].map((name) => ({
      name,
      ceilingMs: 45_000,
      run: async () => {
        started.push(name);
        return { status: 200 };
      },
    }));

    const result = await dispatchJobs(jobs);

    expect(started).toEqual(["a", "b"]);
    expect(result.skipped).toBe(0);
  });
});

describe("cron budget — (b) min(own ceiling, budget handed down)", () => {
  it("effectiveDeadlineMs takes the smaller of the two, and the constant when standalone", () => {
    // Inside the dispatcher: the share wins when it is tighter.
    expect(effectiveDeadlineMs(45_000, headers({ [CRON_BUDGET_HEADER]: "2391" }))).toBe(2391);
    // The job's own ceiling wins when the share is generous.
    expect(effectiveDeadlineMs(20_000, headers({ [CRON_BUDGET_HEADER]: "50000" }))).toBe(20_000);
    // Standalone (a manual curl, Vercel hitting the route directly): the
    // constant is all there is.
    expect(effectiveDeadlineMs(45_000, headers({}))).toBe(45_000);
    // A malformed header can never produce a zero-second deadline.
    expect(effectiveDeadlineMs(45_000, headers({ [CRON_BUDGET_HEADER]: "-1" }))).toBe(45_000);
    expect(effectiveDeadlineMs(45_000, headers({ [CRON_BUDGET_HEADER]: "abc" }))).toBe(45_000);
  });

  it("reservedCeilingMs is 0 for a job that honours the header and its ceiling for one that does not", () => {
    for (const [name, declared] of Object.entries(CRON_JOB_CEILINGS)) {
      expect(reservedCeilingMs(name)).toBe(declared.honoursBudget ? 0 : declared.ceilingMs);
    }
    // Unknown job: nothing reserved (never starve a job we know nothing about).
    expect(reservedCeilingMs("not_a_job")).toBe(0);
  });

  it("PARITY: every declared ceiling is honoured by the code that owns it", () => {
    const offenders: string[] = [];

    for (const [name, declared] of Object.entries(CRON_JOB_CEILINGS)) {
      const routeFile = join(CRON_DIR, routeDirOf(name), "route.ts");
      expect(existsSync(routeFile), `${name}: no route at ${routeFile}`).toBe(true);

      // The route is what receives the header, so the route is what must read
      // it — even when the ceiling constant lives in a helper it calls.
      const routeSrc = readFileSync(routeFile, "utf8");
      const reads = READS_THE_BUDGET.test(routeSrc);
      if (reads !== declared.honoursBudget) {
        offenders.push(
          `${name}: CRON_JOB_CEILINGS says honoursBudget=${declared.honoursBudget} but ${routeDirOf(name)}/route.ts ${reads ? "reads" : "ignores"} the budget`,
        );
      }

      // The declared number must actually exist where the table says it does —
      // otherwise the table drifts into fiction.
      const declaringSrc = readSource(declared.declaredIn);
      if (!CEILING_CONSTANT.test(declaringSrc)) {
        offenders.push(`${name}: no ceiling constant found in ${declared.declaredIn}`);
      }

      // …and that module must be one the ROUTE can actually reach. A ceiling
      // constant sitting in an unrelated file satisfies the check above while
      // telling the reader nothing true about this job.
      const reachable = reachableCeilingModules(routeFile);
      if (!reachable.includes(declared.declaredIn)) {
        offenders.push(
          `${name}: declaredIn ${declared.declaredIn} is not reachable from ${routeDirOf(name)}/route.ts (reaches: ${reachable.join(", ") || "nothing"})`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it("PARITY: a cron job that can REACH a ceiling constant must appear in CRON_JOB_CEILINGS", () => {
    const fleet = sweepFleet();
    const undeclared: string[] = [];

    for (const { job, ceilings } of fleet) {
      if (ceilings.length === 0) continue;
      if (CRON_JOB_CEILINGS[job]) continue;
      if (CEILING_EXEMPT[job]) {
        undeclared.push(
          `${job}: exempt from CRON_JOB_CEILINGS but reaches a ceiling in ${ceilings.join(", ")} — the exemption is stale`,
        );
        continue;
      }
      undeclared.push(
        `${job}: reaches a ceiling in ${ceilings.join(", ")} but is not in the table`,
      );
    }

    expect(undeclared).toEqual([]);
    // Non-vacuity floors: the sweep saw the fleet, AND it actually followed
    // imports — a route-only sweep finds 5 declaring modules, not 15.
    expect(fleet.length).toBeGreaterThanOrEqual(20);
    const viaHelper = fleet.filter(
      ({ routeFile, ceilings }) =>
        ceilings.length > 0 && !CEILING_CONSTANT.test(cachedSource(routeFile)),
    );
    expect(viaHelper.length).toBeGreaterThanOrEqual(15);
  });

  it("an exempt job reaches NO ceiling at all — the exemption is pinned, not a name on a list", () => {
    const fleet = sweepFleet();
    const byJob = new Map(fleet.map((f) => [f.job, f]));

    for (const [job, reason] of Object.entries(CEILING_EXEMPT)) {
      const found = byJob.get(job);
      expect(found, `${job}: exempt but has no route on disk`).toBeDefined();
      expect(found?.ceilings, `${job} is exempt because ${reason}`).toEqual([]);
      // An exemption is only meaningful for a job the dispatcher actually runs.
      expect(DAILY_JOB_ORDER).toContain(job);
      // And it must not ALSO claim a ceiling.
      expect(CRON_JOB_CEILINGS[job]).toBeUndefined();
    }
  });

  it("every job the dispatcher runs is either ceilinged or explicitly exempt", () => {
    const unclassified = DAILY_JOB_ORDER.filter(
      (name) => !CRON_JOB_CEILINGS[name] && !CEILING_EXEMPT[name],
    );
    expect(unclassified).toEqual([]);
  });

  it("the ceiling table covers the whole ceiling-bearing fleet and only real jobs", () => {
    // Non-vacuity floor: 20 jobs carry a self-imposed ceiling today (the first
    // census said 14 — it scanned only route files and missed every job whose
    // ceiling lives two imports away). If this drops, someone deleted a row
    // instead of fixing a job.
    expect(Object.keys(CRON_JOB_CEILINGS).length).toBeGreaterThanOrEqual(20);
    for (const name of Object.keys(CRON_JOB_CEILINGS)) {
      expect(DAILY_JOB_ORDER).toContain(name);
    }
  });
});

describe("cron budget — the scenario the census missed", () => {
  // THE INVARIANT, stated once over the whole fleet. A job that burns a
  // self-imposed constant regardless of what it is handed is safe only if the
  // dispatcher RESERVES that constant before starting it. A job that derives
  // its deadline from the header is safe because what it is handed is by
  // construction never more than what is left. Everything else is a SIGKILL
  // waiting for a backlogged night.
  //
  // Before the 2026-08-22 correction, six jobs were in NEITHER state:
  // materialize_slots, evaluate_alerts, expire_caretaker_grants,
  // expire_pet_transfers, expire_foster_proposals and expire_decomiso_handoffs
  // each burned 45 s while absent from CRON_JOB_CEILINGS, so reservedCeilingMs
  // returned 0 and the dispatcher started them on any positive remainder — at
  // elapsed 54 s that is a 99 s run inside a 60 s function.
  it("every daily job is either reserved by the dispatcher or honours the header", () => {
    const unsafe: string[] = [];

    for (const job of DAILY_JOB_ORDER) {
      if (CEILING_EXEMPT[job]) continue;
      if (reservedCeilingMs(job) > 0) continue; // the dispatcher reserves for it
      const routeFile = join(CRON_DIR, routeDirOf(job), "route.ts");
      if (existsSync(routeFile) && READS_THE_BUDGET.test(cachedSource(routeFile))) continue;
      unsafe.push(
        `${job}: burns a self-imposed ceiling, the dispatcher reserves nothing for it, and its route never reads ${CRON_BUDGET_HEADER}`,
      );
    }

    expect(unsafe).toEqual([]);
  });

  // Half (a) of the fix — the reservation — is DORMANT today: every row in
  // CRON_JOB_CEILINGS now honours the header, so reservedCeilingMs returns 0
  // for all of them and the only live delta is `remaining <= 0`. It is kept as
  // the safety net for the next job that declares a ceiling without reading
  // the header, so it is exercised here against a synthetic one rather than
  // against a real row that would make the test vacuous.
  it("SAFETY NET: a non-honouring job is skipped cleanly instead of crossing the hard kill", async () => {
    const OWN_CEILING_MS = 45_000;
    let clock = 0;
    const now = () => clock;
    const started: string[] = [];

    const jobs: DispatchJob[] = [
      {
        name: "everything_before",
        ceilingMs: 0,
        run: async () => {
          clock += 54_000;
          return { status: 200 };
        },
      },
      {
        name: "declares_a_ceiling_and_ignores_the_header",
        // What reservedCeilingMs would return for a honoursBudget:false row.
        ceilingMs: OWN_CEILING_MS,
        run: async () => {
          started.push("late");
          clock += OWN_CEILING_MS; // ignores ctx entirely
          return { status: 200 };
        },
      },
    ];

    const result = await dispatchJobs(jobs, { budgetMs: BUDGET_MS, now });

    expect(started).toEqual([]);
    expect(result.outcomes[1]?.status).toBe("skipped_budget");
    expect(clock).toBeLessThanOrEqual(HARD_KILL_MS);
  });

  it("without the reservation the same job runs 99s inside a 60s function", async () => {
    // The counterfactual, pinned so the reservation cannot be quietly removed:
    // ceilingMs 0 is what an UNKNOWN job gets, and it is what the six missing
    // jobs got before the table was completed.
    const OWN_CEILING_MS = 45_000;
    let clock = 0;
    const now = () => clock;

    const jobs: DispatchJob[] = [
      {
        name: "everything_before",
        ceilingMs: 0,
        run: async () => {
          clock += 54_000;
          return { status: 200 };
        },
      },
      {
        name: "unknown_to_the_table",
        ceilingMs: reservedCeilingMs("a_job_nobody_declared"),
        run: async () => {
          clock += OWN_CEILING_MS;
          return { status: 200 };
        },
      },
    ];

    await dispatchJobs(jobs, { budgetMs: BUDGET_MS, now });

    expect(reservedCeilingMs("a_job_nobody_declared")).toBe(0);
    expect(clock).toBe(99_000);
    expect(clock).toBeGreaterThan(HARD_KILL_MS);
  });
});

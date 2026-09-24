// Cron fleet parity — projection-cron audit 2026-07-03 B2, reworked for the
// dispatcher consolidation (Vercel Hobby cron limits, 2026-07-07).
//
// The fleet used to be 22 vercel.json crons in 1:1 correspondence with 22 route
// directories. Vercel Hobby allows only 2 daily cron jobs, so the fleet now
// runs behind a SINGLE daily dispatcher (/api/cron/daily). The invariants that
// keep drift from silently recurring changed shape accordingly:
//
//   - vercel.json schedules ONLY the dispatcher route(s) + the standalone
//     scheduled jobs (refresh-cube — too heavy for the dispatcher budget).
//   - CRON_REGISTRY (lib/infra/cron-registry.ts) === snake_case of the JOB
//     route directories (every job is still monitored by cron-health).
//   - DAILY_JOB_ORDER (lib/infra/cron-dispatcher.ts) === the registered jobs
//     minus the standalone-scheduled ones, so the dispatcher runs exactly the
//     monitored fleet — no job silently dropped from the daily run, none run
//     that isn't monitored.
//   - every job route declares CRON_NAME = snake(dir) and records telemetry.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DAILY_JOB_ORDER } from "@/lib/infra/cron-dispatcher";
import { CRON_REGISTRY, cronDisplayLabel } from "@/lib/infra/cron-registry";

const ROOT = join(__dirname, "..");
const CRON_DIR = join(ROOT, "app", "api", "cron");

// Dispatcher routes are the scheduled orchestrators — they appear in
// vercel.json and have a route directory, but they are NOT individual jobs
// (they run the jobs) so they are excluded from the job-registry checks.
const DISPATCHER_DIRS = ["daily"];

// STANDALONE scheduled jobs (cube-ON decision, 2026-07-24 K4/S3): registered +
// monitored fleet jobs (they pass every job-route check below) whose schedule
// is their OWN vercel.json cron entry instead of the daily dispatcher —
// `refresh-cube`'s ~105s build exceeds the dispatcher's 55s budget, so it runs
// as its own daily cron (0 3 * * *, 300s function pin). These are therefore in
// CRON_REGISTRY but NOT in DAILY_JOB_ORDER. NOTE: dispatcher + standalone crons
// saturate the Vercel Hobby limit (2 cron jobs, daily only) — a third scheduled
// entry, or any sub-daily cadence, requires Vercel Pro.
const STANDALONE_JOB_DIRS = ["refresh-cube"];

function snake(dir: string): string {
  return dir.replace(/-/g, "_");
}

function vercelCronPaths(): string[] {
  const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as {
    crons?: Array<{ path: string }>;
  };
  return (vercel.crons ?? []).map((c) => c.path);
}

function routeDirs(): string[] {
  return readdirSync(CRON_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

describe("cron fleet parity (vercel.json ⇄ dispatcher ⇄ registry ⇄ routes)", () => {
  const dirs = routeDirs();
  const jobDirs = dirs.filter((d) => !DISPATCHER_DIRS.includes(d));
  const registryNames = new Set(CRON_REGISTRY.map((e) => e.cronName));

  it("vercel.json schedules ONLY the dispatcher(s) + standalone jobs", () => {
    const pathDirs = vercelCronPaths().map((p) => p.replace("/api/cron/", ""));
    expect([...pathDirs].sort()).toEqual([...DISPATCHER_DIRS, ...STANDALONE_JOB_DIRS].sort());
  });

  it("every dispatcher has a route directory", () => {
    for (const d of DISPATCHER_DIRS) {
      expect(dirs, `dispatcher "${d}" must have app/api/cron/${d}/route.ts`).toContain(d);
    }
  });

  it("CRON_REGISTRY names are exactly snake_case of the JOB route directories", () => {
    const expected = jobDirs.map(snake).sort();
    expect([...registryNames].sort()).toEqual(expected);
  });

  it("DAILY_JOB_ORDER runs exactly the registered jobs minus standalone-scheduled ones", () => {
    const standalone = new Set(STANDALONE_JOB_DIRS.map(snake));
    const expected = [...registryNames].filter((n) => !standalone.has(n)).sort();
    expect([...DAILY_JOB_ORDER].sort()).toEqual(expected);
  });

  it("every standalone-scheduled job is registered (monitored by cron-health)", () => {
    for (const d of STANDALONE_JOB_DIRS) {
      expect(registryNames, `standalone job "${d}" must be in CRON_REGISTRY`).toContain(snake(d));
    }
  });

  it("DAILY_JOB_ORDER has no duplicate entries", () => {
    expect(new Set(DAILY_JOB_ORDER).size).toBe(DAILY_JOB_ORDER.length);
  });

  it("every job route declares CRON_NAME = snake_case(directory)", () => {
    for (const dir of jobDirs) {
      const src = readFileSync(join(CRON_DIR, dir, "route.ts"), "utf8");
      const match = src.match(/const CRON_NAME = "([^"]+)"/);
      expect(match, `${dir}/route.ts must declare const CRON_NAME`).not.toBeNull();
      expect(match?.[1], `${dir}/route.ts CRON_NAME must be snake_case of its directory`).toBe(
        snake(dir),
      );
    }
  });

  it("every job route records cron_runs telemetry (cronRuns / runCaseCron / withCronRun)", () => {
    for (const dir of jobDirs) {
      const src = readFileSync(join(CRON_DIR, dir, "route.ts"), "utf8");
      const hasTelemetry =
        src.includes("cronRuns") || src.includes("runCaseCron") || src.includes("withCronRun");
      expect(
        hasTelemetry,
        `${dir}/route.ts writes no cron_runs telemetry — wrap it with withCronRun (lib/infra/case-cron.ts)`,
      ).toBe(true);
    }
  });

  // Auth is the security boundary for the whole cron fleet (all 24 routes are
  // publicly reachable URLs otherwise) — this tripwire keeps a future job from
  // shipping ungated. Every job must reference one of the two known auth
  // helpers: authorizeCronRequest (lib/domain/cron-auth.ts, Bearer + legacy
  // header) or checkCronSecret (lib/infra/case-cron.ts, the older helper still
  // used by the case-cron routes).
  it("every job route is auth-gated (authorizeCronRequest or checkCronSecret)", () => {
    for (const dir of jobDirs) {
      const src = readFileSync(join(CRON_DIR, dir, "route.ts"), "utf8");
      const hasAuth = src.includes("authorizeCronRequest") || src.includes("checkCronSecret");
      expect(
        hasAuth,
        `${dir}/route.ts has no auth gate — it must call authorizeCronRequest (lib/domain/cron-auth.ts) or checkCronSecret (lib/infra/case-cron.ts)`,
      ).toBe(true);
    }
  });
});

// es-AR display labels for the operator-facing CronsDownBanner "Detalle técnico"
// list (recorrido-80 QA: raw snake_case process names read as English text).
describe("cronDisplayLabel — es-AR operator labels", () => {
  it("maps EVERY registered cron to a non-empty es-AR label (no raw key leaks)", () => {
    for (const { cronName } of CRON_REGISTRY) {
      const label = cronDisplayLabel(cronName);
      expect(label, `${cronName} has no es-AR display label`).not.toBe(cronName);
      expect(label.length).toBeGreaterThan(0);
      // No English-looking snake_case underscores in the operator label.
      expect(label).not.toMatch(/_/);
    }
  });

  it("does not change the internal key — display-only", () => {
    // The specific names the QA flagged on /admin.
    expect(cronDisplayLabel("vaccine_due")).toBe("Recordatorio de vacunas por vencer");
    expect(cronDisplayLabel("process_eno_queue")).toBe("Procesamiento de la cola ENO");
  });

  it("falls back to the raw name for an unknown cron (forward-compat)", () => {
    expect(cronDisplayLabel("some_future_cron")).toBe("some_future_cron");
  });

  // M2 (cowork demo 2026-07-17): the WRAPPER/dispatcher telemetry names each
  // write their OWN cron_runs row (const CRON_NAME in the route), so they appear
  // on /admin/sistema + the CronsDownBanner just like a job. The banner's
  // "Detalle técnico" showed raw "cron_daily"; pin that every such telemetry
  // name resolves to an es-AR label. (refresh_cube graduated into CRON_REGISTRY
  // when its schedule returned — kept here so the union sweep below still
  // covers it independently of the registry.)
  const WRAPPER_CRON_NAMES = ["cron_daily", "cron_health", "refresh_cube"] as const;
  it("maps EVERY wrapper/dispatcher telemetry name to a non-raw es-AR label", () => {
    for (const name of WRAPPER_CRON_NAMES) {
      const label = cronDisplayLabel(name);
      expect(label, `${name} has no es-AR display label`).not.toBe(name);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/_/);
    }
  });

  it("the wrapper telemetry names match the dispatcher route CRON_NAME constants", () => {
    // Guard against drift: the labels above are keyed by the exact cron_runs name
    // each dispatcher writes. If a dispatcher's CRON_NAME changes, this catches it.
    const dispatcherNames = DISPATCHER_DIRS.map((dir) => {
      const src = readFileSync(join(CRON_DIR, dir, "route.ts"), "utf8");
      return src.match(/const CRON_NAME = "([^"]+)"/)?.[1];
    }).filter((n): n is string => Boolean(n));
    for (const name of dispatcherNames) {
      expect(WRAPPER_CRON_NAMES).toContain(name);
    }
  });

  // FULL-COVERAGE sweep (fences wave S #7): the operator sees a label for EVERY
  // cron_runs row on /admin/sistema + the CronsDownBanner. Those rows come from
  // the runtime-DISPATCHED fleet (DAILY_JOB_ORDER — what actually runs, not just
  // what's registered) PLUS the wrapper/dispatcher telemetry names. Sweeping the
  // union directly closes the "a job runs but resolves to its raw snake_case key"
  // gap without relying on the registry⇄DAILY_JOB_ORDER parity holding.
  it("every dispatched job + wrapper resolves to a non-raw, underscore-free label", () => {
    const everyVisibleName = new Set<string>([...DAILY_JOB_ORDER, ...WRAPPER_CRON_NAMES]);
    for (const name of everyVisibleName) {
      const label = cronDisplayLabel(name);
      expect(label, `${name} has no es-AR display label (would leak the raw key)`).not.toBe(name);
      expect(label.length).toBeGreaterThan(0);
      expect(label, `${name} label still contains a snake_case underscore`).not.toMatch(/_/);
    }
  });
});

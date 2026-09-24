// The cron schedule a human reads must be the schedule the system runs.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// `/admin/sistema/crons` is where an operator goes to answer one question: did
// this job run when it was supposed to? Until 2026-08-18 that screen read its
// schedules from CRON_SCHEDULE_MAP — a second, hand-maintained table inside
// lib/analytics/admin-metrics.ts — while the real monitoring
// (/api/cron/cron-health) read CRON_REGISTRY. The two had already drifted:
// the console said drain_outbox runs at 06:00; the registry says 04:00.
//
// A health console that misstates the schedule is worse than no console: a job
// that ran on time looks late, and a job that is genuinely late looks fine,
// and the operator cannot tell which. The screen was consolidated onto the
// registry; this keeps it there.
//
// WHAT THIS TEST DID NOT ASK, AND NOW DOES (2026-08-21)
// ---------------------------------------------------------------------------
// It enforced ONE source. It never asked whether that source was TRUE. After
// the 2026-07-07 fleet consolidation the registry kept each job's
// pre-consolidation time — `0 12 * * *` for vaccine_due, `0 0 * * *` for
// close_rabies_observations, nine more — while all of them actually ran at
// 04:00 inside the daily dispatcher. Eleven of twenty-four wrong, single-
// sourced, and green. Consolidating a lie leaves one lie.
//
// So the registry no longer restates an expression per job. It declares WHERE
// each job runs (`runsVia`), and the two expressions that actually exist live
// in VERCEL_CRON_SCHEDULES. The last two cases below are the ones that make
// that derivation honest: the map against vercel.json itself, and `runsVia`
// against the dispatcher's own job list.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DAILY_JOB_ORDER } from "@/lib/infra/cron-dispatcher";
import { CRON_REGISTRY, VERCEL_CRON_SCHEDULES, cronScheduleFor } from "@/lib/infra/cron-registry";

const ROOT = join(__dirname, "..");
const CANONICAL = "lib/infra/cron-registry.ts";

function sourceFiles(): string[] {
  const found: string[] = [];
  for (const root of ["app", "lib", "src"]) {
    for (const entry of readdirSync(join(ROOT, root), { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      if (entry.name.includes(".test.")) continue;
      found.push(
        join(entry.parentPath, entry.name)
          .slice(ROOT.length + 1)
          .replaceAll("\\", "/"),
      );
    }
  }
  return found;
}

describe("cron schedules have one source", () => {
  it("the registry actually resolves a schedule for every job", () => {
    // NON-VACUITY. Everything below is meaningless if the registry is empty or
    // its entries stopped resolving to an expression.
    expect(CRON_REGISTRY.length).toBeGreaterThan(10);
    for (const entry of CRON_REGISTRY) {
      expect(cronScheduleFor(entry), entry.cronName).toMatch(/^[\d*,/ -]+$/);
    }
  });

  it("the two expressions are the two vercel.json actually declares", () => {
    // THE CHECK THAT WAS MISSING. Everything else here is about there being one
    // table; this is about that table being right. vercel.json is the
    // platform's own declaration — the only thing that decides when anything
    // fires — so the map is compared against it, not maintained alongside it.
    const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as {
      crons?: { path: string; schedule: string }[];
    };
    const declared = new Map((vercel.crons ?? []).map((c) => [c.path, c.schedule]));

    // Hobby allows exactly two. If that ever changes, this test should be the
    // thing that notices, not an operator reading a stale screen.
    expect(declared.size, "vercel.json no longer declares exactly two crons").toBe(2);
    expect(declared.get("/api/cron/daily")).toBe(VERCEL_CRON_SCHEDULES.daily);
    expect(declared.get("/api/cron/refresh-cube")).toBe(VERCEL_CRON_SCHEDULES.refresh_cube);
  });

  it("runsVia matches what the dispatcher really runs", () => {
    // The other half of the derivation. A job marked `daily` that the
    // dispatcher does not run would display 04:00 and never fire; a job the
    // dispatcher DOES run but marked otherwise would display the wrong hour.
    const inDispatcher = new Set(DAILY_JOB_ORDER);
    const wrong: string[] = [];
    for (const entry of CRON_REGISTRY) {
      const claimsDaily = entry.runsVia === "daily";
      if (claimsDaily !== inDispatcher.has(entry.cronName)) {
        wrong.push(
          `${entry.cronName}: runsVia="${entry.runsVia}" pero ${
            inDispatcher.has(entry.cronName) ? "SÍ" : "NO"
          } está en DAILY_JOB_ORDER`,
        );
      }
    }
    expect(wrong, wrong.join(" · ")).toEqual([]);
  });

  it("no second table of cron schedules exists outside the registry", () => {
    // A cron expression is five space-separated fields. Any file other than the
    // registry holding a MAP of them is, by construction, a copy that can drift
    // — which is exactly what happened. Matching on the literal shape rather
    // than on a variable name keeps a rename from slipping past.
    const CRON_EXPR = /["'`]\s*[\d*]+[\d*,/-]*\s+[\d*][\d*,/-]*\s+\*\s+\*\s+\*\s*["'`]/;
    const copias: string[] = [];
    for (const file of sourceFiles()) {
      if (file === CANONICAL) continue;
      const src = readFileSync(join(ROOT, file), "utf8");
      const lineas = src.split("\n");
      // Two or more cron literals in one file is a table, not an incidental
      // mention (vercel.json lives outside this tree and is the platform's own
      // declaration, not a display source).
      const hits = lineas.filter((l) => CRON_EXPR.test(l) && !l.trim().startsWith("//"));
      if (hits.length >= 2) {
        copias.push(`${file} (${hits.length} horarios)`);
      }
    }
    expect(
      copias,
      `Tablas de horarios fuera de ${CANONICAL}:\n${copias.map((c) => `  • ${c}`).join("\n")}\n\nUn operador lee estos horarios para decidir si un cron llegó tarde. Dos tablas = una miente.`,
    ).toEqual([]);
  });
});

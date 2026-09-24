// The caretaker sweep is wired into the fleet, not standing beside it.
//
// __tests__/cron-registry-parity.test.ts already enforces the fleet-wide
// invariants mechanically (registry ⇄ route dirs ⇄ DAILY_JOB_ORDER). What it
// cannot say is anything about THIS job specifically, and two of the wiring
// points are easy to half-do:
//
//   - the name→handler map in app/api/cron/daily/route.ts. Its drift guard is a
//     module-load `throw`, which only fires if something imports that route —
//     nothing in the unit suite does. A job registered but unmapped would sail
//     through every green test and simply never run.
//   - the es-AR display label. Unmapped names fall back to the raw snake_case
//     key, so a funcionario reading /admin/sistema sees "expire_caretaker_grants".
//     Forward-compatible by design, which is exactly why it fails silently.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DAILY_JOB_ORDER } from "@/lib/infra/cron-dispatcher";
import {
  CRON_REGISTRY,
  VERCEL_CRON_SCHEDULES,
  cronDisplayLabel,
  cronScheduleFor,
} from "@/lib/infra/cron-registry";

const CRON_NAME = "expire_caretaker_grants";
const ROOT = join(__dirname, "..", "..", "..", "..");

describe("expire_caretaker_grants — fleet wiring", () => {
  it("rides the daily dispatcher", () => {
    expect(DAILY_JOB_ORDER).toContain(CRON_NAME);
  });

  it("runs BEFORE the other expiry jobs is not required, but it must run at all", () => {
    // Ordering inside the expiry block does not matter: the passes are
    // independent of the other jobs. What matters is presence exactly once.
    expect(DAILY_JOB_ORDER.filter((n) => n === CRON_NAME)).toHaveLength(1);
  });

  it("is monitored by cron-health", () => {
    const entry = CRON_REGISTRY.find((e) => e.cronName === CRON_NAME);
    expect(entry, `${CRON_NAME} must be in CRON_REGISTRY`).toBeDefined();
    // Asserted through the derivation, not against a restated string: the job
    // runs inside the daily dispatcher, and 04:00 is whatever vercel.json says
    // that dispatcher runs at.
    expect(entry?.runsVia).toBe("daily");
    expect(entry && cronScheduleFor(entry)).toBe(VERCEL_CRON_SCHEDULES.daily);
  });

  it("has an es-AR label, not the raw snake_case key", () => {
    const label = cronDisplayLabel(CRON_NAME);
    expect(label).not.toBe(CRON_NAME);
    expect(label).toBe("Vencimiento de cuidados temporales");
  });

  it("is wired into the dispatcher's name→handler map", () => {
    // Source-level, because importing app/api/cron/daily/route.ts pulls the
    // whole DB layer into a unit test. The map is a plain object literal, so
    // the key's presence is the whole assertion.
    const src = readFileSync(join(ROOT, "app", "api", "cron", "daily", "route.ts"), "utf8");
    expect(src).toContain(`${CRON_NAME}: expireCaretakerGrants,`);
    expect(src).toContain('from "../expire-caretaker-grants/route"');
  });

  it("does NOT add a vercel.json cron entry", () => {
    // The Vercel Hobby limit is two scheduled crons and both are taken
    // (dispatcher + refresh-cube). A third entry fails the deploy, and all four
    // sibling expiry jobs ride the dispatcher anyway.
    const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as {
      crons?: Array<{ path: string }>;
    };
    const paths = (vercel.crons ?? []).map((c) => c.path);
    expect(paths).not.toContain("/api/cron/expire-caretaker-grants");
    expect(paths).toHaveLength(2);
  });
});

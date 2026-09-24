// WP2 / P1 — per-site regression: each fixed sql`` date-binding site resolves
// against real Postgres with a real period, instead of throwing
// ERR_INVALID_ARG_TYPE on a raw Date.
//
// Sites covered (all interpolated a raw Date into sql`` before WP2):
//   lib/govt-dashboards.ts  — fetchPetsForExport / fetchEventsForExport /
//                             fetchCasesForExport (ExportPeriod since/until)
//   lib/metrics/custody.ts  — fetchTimeInState (ctx.period.since)
//   lib/metrics/population.ts — petEventsInScopeCondition({ window }) used in a
//                               real count query
//
// Integration test — requires the local Supabase + Postgres stack.

import { count } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db, petEvents } from "@/db";
import {
  fetchCasesForExport,
  fetchEventsForExport,
  fetchPetsForExport,
} from "@/lib/analytics/govt-dashboards";
import { buildProjectionContext } from "@/lib/metrics";
import { fetchTimeInState } from "@/lib/metrics/custody";
import { windows } from "@/lib/metrics/period";
import { petEventsInScopeCondition } from "@/lib/metrics/population";

const period = windows.trailing12m();
const adminCtx = buildProjectionContext({ role: "admin" }, [], period);

describe("sql date binding — fixed sites resolve with a real period (WP2/P1)", () => {
  it("fetchPetsForExport accepts an ExportPeriod with real Dates", async () => {
    const rows = await fetchPetsForExport({ role: "admin" }, [], {
      since: period.since,
      until: period.until,
    });
    expect(Array.isArray(rows)).toBe(true);
  });

  it("fetchEventsForExport accepts an ExportPeriod with real Dates", async () => {
    const rows = await fetchEventsForExport({ role: "admin" }, [], {
      since: period.since,
      until: period.until,
    });
    expect(Array.isArray(rows)).toBe(true);
  });

  it("fetchCasesForExport accepts an ExportPeriod with real Dates", async () => {
    const rows = await fetchCasesForExport({ role: "admin" }, [], {
      since: period.since,
      until: period.until,
    });
    expect(Array.isArray(rows)).toBe(true);
  });

  it("fetchTimeInState resolves with a real period.since in the overlap clause", async () => {
    const rows = await fetchTimeInState(adminCtx);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("petEventsInScopeCondition({ window }) runs in a real count query", async () => {
    const condition = petEventsInScopeCondition(adminCtx, {
      eventType: "vaccination_administered",
      window: { since: period.since, until: period.until },
    });
    const rows = await db.select({ n: count() }).from(petEvents).where(condition);
    expect(typeof rows[0]?.n).toBe("number");
  });
});

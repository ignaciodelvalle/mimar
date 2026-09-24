// Regression: the /gob briefing died with "RangeError: Invalid time value"
// (correlationId 063a76c4, staging a49d4d7) because BOTH aggregates in this
// module declared `sql<Date | null>` over `min(<timestamptz>)`.
//
// drizzle-orm's postgres-js driver installs identity parsers for every timestamp
// OID so its own COLUMN mappers can own the conversion — a raw `sql` fragment
// has no column mapper, so the value arrives as postgres wire TEXT. `sql<Date>`
// was a compile-time claim the runtime never honoured, and `ageInDays` →
// `calendarDaysAgoInAr` → `Intl.DateTimeFormat.format(string)` throws on it.
//
// WHY THE SUITE COULD NOT SEE IT: app/gob/page.test.tsx mocks this whole module
// away, and lib/domain/queue-aging.test.ts exercises the pure day-math with real
// Date objects. Nothing ever fed these two fetchers what the driver actually
// hands them. That is the gap this file closes — it stubs the drizzle chain at
// the DRIVER boundary, one layer lower than any existing test, and returns the
// exact wire string captured from the local database:
//
//   welfare_reports rows: 2820 | oldest typeof: string | value: 2024-01-01 00:00:00+00
//   cases           rows:  748 | oldest typeof: string | value: 2024-01-05 06:00:00+00
//
// Note which state is dangerous: the EMPTY queue (min → NULL) was always safe.
// The crash needs ROWS.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Rows the stubbed drizzle chain will resolve with, per test. */
let selectRows: Array<Record<string, unknown>> = [];

/**
 * Minimal stand-in for `analyticsDb.select({...}).from(t).where(cond)`.
 * Every call in this module is that exact three-link chain awaited as an array.
 */
const fakeDb = {
  select: () => ({
    from: () => ({
      where: async () => selectRows,
    }),
  }),
};

vi.mock("@/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db")>()),
  analyticsDb: fakeDb,
}));

const { fetchCasesQueueAging, fetchWelfareQueueAging } = await import(
  "@/lib/analytics/govt-queue-aging"
);

// Pinned "now" so the expected ages are arithmetic, not wall-clock. Argentina is
// UTC-3 year-round, so 2024-01-11T15:00Z is the AR calendar day 2024-01-11.
const NOW = new Date("2024-01-11T15:00:00Z");

const JURISDICTIONS = [{ province: "AR-C", locality: "comuna-1" }];

beforeEach(() => {
  selectRows = [];
});

describe("fetchWelfareQueueAging", () => {
  it("ages a NON-EMPTY queue whose min() arrives as postgres wire text", async () => {
    // Before the fix this threw RangeError: Invalid time value and took the
    // whole briefing to its degraded chrome.
    selectRows = [{ oldest: "2024-01-01 00:00:00+00", overdue: 3 }];

    const aging = await fetchWelfareQueueAging({ role: "govt" }, JURISDICTIONS, "user-1", {}, NOW);

    // UTC midnight is 21:00 of the PREVIOUS Argentine day, so this row entered
    // the queue on the AR day 2023-12-31 — 11 AR calendar days before NOW, not
    // 10. That is `calendarDaysAgoInAr` doing exactly its job; asserting the
    // naive 10 here would be asserting the UTC calendar the helper exists to
    // replace.
    expect(aging).toEqual({ oldestAgeDays: 11, overdueCount: 3 });
  });

  it("reports no oldest row on an EMPTY queue (min() → NULL)", async () => {
    // The day-one shape of a real jurisdiction: no denuncias yet.
    selectRows = [{ oldest: null, overdue: 0 }];

    const aging = await fetchWelfareQueueAging({ role: "govt" }, JURISDICTIONS, "user-1", {}, NOW);

    expect(aging).toEqual({ oldestAgeDays: null, overdueCount: 0 });
  });

  it("still accepts a real Date, so a driver that maps the column needs no second fix", async () => {
    selectRows = [{ oldest: new Date("2024-01-01T00:00:00Z"), overdue: 1 }];

    const aging = await fetchWelfareQueueAging({ role: "govt" }, JURISDICTIONS, "user-1", {}, NOW);

    // Same AR day (2023-12-31) as the string case above — the two shapes must
    // age identically or the coercion has introduced a second calendar.
    expect(aging).toEqual({ oldestAgeDays: 11, overdueCount: 1 });
  });
});

describe("fetchCasesQueueAging", () => {
  it("ages a NON-EMPTY queue whose min() arrives as postgres wire text", async () => {
    selectRows = [{ oldest: "2024-01-05 06:00:00+00", overdue: 2 }];

    const aging = await fetchCasesQueueAging(
      { role: "govt", jurisdictions: JURISDICTIONS },
      {},
      NOW,
    );

    // 2024-01-05 03:00 AR → 2024-01-11 is 6 AR calendar days.
    expect(aging).toEqual({ oldestAgeDays: 6, overdueCount: 2 });
  });

  it("reports no oldest row on an EMPTY queue (min() → NULL)", async () => {
    selectRows = [{ oldest: null, overdue: 0 }];

    const aging = await fetchCasesQueueAging(
      { role: "admin", province: null, locality: null },
      {},
      NOW,
    );

    expect(aging).toEqual({ oldestAgeDays: null, overdueCount: 0 });
  });

  it("short-circuits a govt with zero assignments without querying", async () => {
    // Fail-closed path — must not depend on the stub resolving anything.
    const aging = await fetchCasesQueueAging({ role: "govt", jurisdictions: [] }, {}, NOW);

    expect(aging).toEqual({ oldestAgeDays: null, overdueCount: 0 });
  });
});

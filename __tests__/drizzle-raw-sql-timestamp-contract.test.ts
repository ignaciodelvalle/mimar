// The load-bearing premise behind every `sql<string | null>` timestamp
// aggregate in this repo, pinned against the REAL driver instead of asserted
// from memory.
//
// drizzle-orm's postgres-js driver overwrites postgres.js's parsers for the
// timestamp OIDs (1082 date, 1083 time, 1114 timestamp, 1184 timestamptz, plus
// their array twins) with an identity function, so that drizzle's own COLUMN
// mappers own the conversion. A raw `sql` fragment has NO column mapper — so its
// value comes back as postgres wire TEXT, and `sql<Date>` over an aggregate is a
// compile-time claim the runtime never honours.
//
// That claim has now crashed two operator surfaces: /admin/sistema (digest
// 1282362471) and /gob ("RangeError: Invalid time value", correlationId
// 063a76c4 — Intl.DateTimeFormat.format() does ToNumber on the string, gets NaN
// and throws). Both fixes coerce at the boundary; both are only correct while
// this premise holds.
//
// If a drizzle/postgres-js upgrade ever starts mapping these to Dates, THIS test
// goes red first — deliberately, so the change is a decision rather than a
// surprise. The coercions themselves accept both shapes and will keep working.
//
// The query touches no table and no seed data: `now()` is a timestamptz, and
// MIN over it exercises exactly the aggregate path the analytics modules use.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { analyticsDb } from "@/db";

describe("drizzle raw-sql timestamp aggregates", () => {
  it("returns postgres wire TEXT, not a Date — the premise the coercions rest on", async () => {
    const rows = await analyticsDb.execute<{ oldest: unknown }>(
      sql`select min(t.ts) as oldest from (values (now())) as t(ts)`,
    );

    const oldest = rows[0]?.oldest;

    expect(oldest).not.toBeInstanceOf(Date);
    expect(typeof oldest).toBe("string");
    // And the text is something `new Date(...)` parses — the coercion used by
    // lib/analytics/govt-queue-aging.ts, org-dashboard.ts and admin-metrics.ts.
    expect(Number.isNaN(new Date(oldest as string).getTime())).toBe(false);
  });

  it("Intl formatting that value unguarded is exactly the /gob crash", async () => {
    const rows = await analyticsDb.execute<{ oldest: unknown }>(
      sql`select min(t.ts) as oldest from (values (now())) as t(ts)`,
    );

    const oldest = rows[0]?.oldest;
    const formatter = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "America/Argentina/Buenos_Aires",
    });

    // This is `isoDateInAr(<what the driver returned>)` with the type lie in
    // place. It throws — which is the whole reason this fence exists.
    expect(() => formatter.format(oldest as unknown as Date)).toThrow(RangeError);
  });
});

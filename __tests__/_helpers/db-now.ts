// Postgres's own clock, for a test that must scope a query to "the rows this
// case wrote" on an append-only table it cannot clean between cases.
//
// Why this exists instead of `new Date()`: every timestamp column such a window
// is compared against is defaulted from Postgres's `now()` (`defaultNow()` in
// db/schema.ts), which in local dev and in CI is a clock inside a Docker
// container — a DIFFERENT clock from the host's. Whenever the container sits
// behind the host, a row that really exists falls outside
// `gte(column, hostDate)` and the assertion reads as a missing write. A Docker
// VM on macOS resyncs its clock without warning, so this is a flake rather than
// a constant, which is the worst shape it could have: it makes a gate report
// two different results over one tree.
//
// Measured on 2026-08-30 against `__tests__/omnibox-search.test.ts`: simulating
// 200 ms of drift turned such an assertion red with `expected +0 to be 1`,
// byte for byte the failure that flaked that gate.
//
// The repair is to take BOTH sides of the comparison from the same clock — not
// to widen the window with a tolerance. A tolerance is a guess about how far
// two clocks may drift, there is no honest value for it, and every value large
// enough to be safe is large enough to stop excluding the rows the window
// exists to exclude.
//
// Where the actor or subject of a row is already unique per run (a fresh
// `randomUUID()`, say), prefer keying on THAT and dropping the time window
// altogether — it is a stronger filter than any timestamp and needs no clock at
// all. `omnibox-search.test.ts` is the worked example.
import { db } from "@/db";
import { sql } from "drizzle-orm";

export async function dbNow(): Promise<Date> {
  const [{ now }] = (await db.execute(sql`SELECT now() AS now`)) as Array<{ now: Date | string }>;
  return new Date(now);
}

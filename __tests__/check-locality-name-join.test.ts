// Pins scripts/check-locality-name-join.ts (L4·3): the scanner on fixtures, and
// the real tree against the frozen list.

import { describe, expect, it } from "vitest";

import {
  FROZEN_NAME_JOINS,
  MIN_HITS,
  countNameJoins,
  evaluate,
  readSqlSources,
} from "@/scripts/check-locality-name-join";

describe("countNameJoins — what counts as a name join", () => {
  it("counts a qualified name compared with another qualified name", () => {
    expect(countNameJoins("and ga.jurisdiction_locality = c.jurisdiction_locality")).toBe(1);
    expect(countNameJoins("AND (g.jurisdiction_locality = cd.jurisdiction_locality)")).toBe(1);
    expect(
      countNameJoins("ga.jurisdiction_locality IS NOT DISTINCT FROM p.jurisdiction_locality"),
    ).toBe(1);
  });

  it("does not count writes, NULL resets or prose in comments", () => {
    expect(countNameJoins("UPDATE pets SET jurisdiction_locality = 'Palermo'")).toBe(0);
    expect(countNameJoins("  jurisdiction_locality = NULL,")).toBe(0);
    expect(
      countNameJoins("-- Fix: add `ga.jurisdiction_locality = pt.jurisdiction_locality`"),
    ).toBe(0);
    expect(countNameJoins("/* g.jurisdiction_locality = x.jurisdiction_locality */")).toBe(0);
  });
});

describe("evaluate — the frozen list is exact", () => {
  it("fails a NEW migration that joins two locality names", () => {
    const { violations } = evaluate([
      ...readSqlSources(),
      {
        file: "db/migrations/0999_new_policy.sql",
        sql: "create policy p on t using (exists (select 1 from govt_assignments g where g.jurisdiction_locality = t.jurisdiction_locality));",
      },
    ]);
    expect(violations).toEqual([{ file: "db/migrations/0999_new_policy.sql", hits: 1, frozen: 0 }]);
  });

  it("passes the same migration keyed on an id", () => {
    const { violations } = evaluate([
      ...readSqlSources(),
      {
        file: "db/migrations/0999_new_policy.sql",
        sql: "create policy p on t using (exists (select 1 from govt_assignments g where g.locality_id = t.locality_id));",
      },
    ]);
    expect(violations).toEqual([]);
  });

  it("fails a frozen file whose count moved (the list cannot go stale silently)", () => {
    const files = readSqlSources().map((f) =>
      f.file === "db/rls.sql" ? { ...f, sql: countNameJoins(f.sql) ? "select 1;" : f.sql } : f,
    );
    expect(evaluate(files).violations).toEqual([{ file: "db/rls.sql", hits: 0, frozen: 1 }]);
  });
});

describe("the real tree", () => {
  it("has exactly the frozen name joins, and at least the floor", () => {
    const { violations, total } = evaluate(readSqlSources());
    expect(violations).toEqual([]);
    expect(total).toBe(MIN_HITS);
    expect(Object.keys(FROZEN_NAME_JOINS).length).toBeGreaterThan(0);
  });
});

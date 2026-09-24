// PARTITION GUARD — protects the unit/db project split (see vitest.config.ts
// and __tests__/db-reachability.ts).
//
// The two Vitest projects are partitioned by transitive reachability of the
// database client (db/index.ts). The "unit" project runs in parallel WITHOUT
// the URL-forcing setup — which is only safe if no unit file can reach the DB
// client. This guard fails loudly if that invariant is ever violated, or if the
// partition stops being exhaustive/disjoint.
//
// This test lives in the "unit" project itself: it imports only the
// reachability module (node:fs — no @/db), so it never reaches the sink.

import { describe, expect, it } from "vitest";
import {
  ROOT,
  computeTestPartition,
  fileHasDbSignal,
  isDbTest,
  reachesDbDepth1,
} from "./db-reachability";

describe("vitest project partition (unit vs db)", () => {
  const { db, unit, all } = computeTestPartition();

  it("classifies at least one file into each project", () => {
    // Sanity: a totally-empty side would mean the walk or resolver silently
    // broke and the whole suite collapsed into one project.
    expect(db.length).toBeGreaterThan(0);
    expect(unit.length).toBeGreaterThan(0);
  });

  it("is exhaustive and disjoint (db ∪ unit === all, db ∩ unit === ∅)", () => {
    expect(db.length + unit.length).toBe(all.length);
    const dbSet = new Set(db);
    const overlap = unit.filter((f) => dbSet.has(f));
    expect(overlap).toEqual([]);
    const union = new Set([...db, ...unit]);
    expect(union.size).toBe(all.length);
  });

  it("no unit-project file imports the DB client at depth 1 (independent shallow check)", () => {
    // INDEPENDENT shallow cross-check: reachesDbDepth1 re-derives a file's
    // direct + one-hop imports without the memoized full-depth walk the
    // partition uses. Honest depth bound: this catches a unit file that imports
    // @/db directly, or whose direct import imports @/db. Deeper transitive
    // reach + non-import DB access are the authoritative classifier's job
    // (asserted next).
    const depth1Leaks = unit.filter((rel) => reachesDbDepth1(`${ROOT}/${rel}`));
    expect(depth1Leaks).toEqual([]);
  });

  it("no unit-project file carries a direct DB-access signal in its own source", () => {
    // Guards the SECOND classification signal (raw postgres driver / DATABASE_URL
    // / DB-script spawn). A unit file with this signal would touch the DB without
    // the URL-forcing setup — exactly the migrate-runner.test.ts case.
    const signalLeaks = unit.filter((rel) => fileHasDbSignal(`${ROOT}/${rel}`));
    expect(signalLeaks).toEqual([]);
  });

  it("no unit-project file is a DB test (the safety invariant, full depth)", () => {
    // The invariant the safety argument rests on: a unit file cannot reach the
    // DB client and carries no direct-DB signal, so it cannot query, so dropping
    // URL forcing is safe. Regression test for the authoritative classifier.
    const leaks = unit.filter((rel) => isDbTest(`${ROOT}/${rel}`));
    expect(leaks).toEqual([]);
  });

  it("every db-project file is a DB test (no misfiling into db)", () => {
    const misfiled = db.filter((rel) => !isDbTest(`${ROOT}/${rel}`));
    expect(misfiled).toEqual([]);
  });
});

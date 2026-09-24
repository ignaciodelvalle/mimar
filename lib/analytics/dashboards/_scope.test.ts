// Contract tests for the dashboards/_scope.ts helpers (C3, ONE VIEWSCOPE).
//
// WHY these exist: five dashboard modules used to hand-roll their own
// jurisdiction predicates — 54 raw references the scope-discipline fence
// (scripts/check-scope-discipline.ts) had grandfathered. Consolidating them
// into these helpers is only safe if the helpers keep three guarantees that the
// hand-rolled `if (actor.role === "admin" && adminProvince)` guards used to
// spell out at every call site:
//
//   1. GOVT IGNORES THE ADMIN DRILL. Passing adminProvince/adminLocality for a
//      govt actor must not change their clause by one character — not widen it
//      (a govt seeing another province's rows) and not narrow it (a govt whose
//      URL happens to carry ?province= silently losing their own rows).
//   2. ADMIN WITHOUT A DRILL IS UNRESTRICTED (null), so a caller composing
//      `where(and(...conditions))` emits no jurisdiction predicate at all.
//   3. WHOLE-PROVINCE SUBSUMPTION SURVIVES. A whole-province assignment must
//      still emit a PROVINCE-ONLY predicate (jurisdictionPairClause's contract,
//      lib/metrics/scope.test.ts) — otherwise a whole-CABA operator stops
//      seeing every barrio the moment their table's helper changed.
//
// Rendered with PgDialect().sqlToQuery — no DB connection, same technique as
// lib/metrics/scope.test.ts.

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";
import * as scopeModule from "./_scope";
import {
  casesScopeClause,
  custodyDisputesScopeClause,
  organizationsScopeClause,
  outbreakSignalScopeClause,
  petsScopeClause,
  welfareReportsScopeClause,
} from "./_scope";

function render(clause: SQL | null | undefined) {
  if (!clause) return { sql: "", params: [] as unknown[] };
  return new PgDialect().sqlToQuery(clause);
}

const ADMIN: DashboardActor = { role: "admin" };
const GOVT: DashboardActor = { role: "govt" };

const ROSARIO: DashboardJurisdiction = { province: "Santa Fe", locality: "Rosario" };
// Two-tier canonical whole-province entry (see jurisdiction-canonical.ts).
const WHOLE_CABA: DashboardJurisdiction = {
  province: "CABA",
  locality: "Ciudad Autónoma de Buenos Aires",
};

// Every helper with the same four-argument shape, so the three guarantees are
// asserted once per table rather than once per hand-written test.
//
// That sentence was a claim this table did not honour: it listed three of the
// FIVE helpers with that signature. `casesScopeClause` and `petsScopeClause`
// — the two with the widest blast radius, since cases feed the operator queues
// and pets feed nearly every dashboard — were the two left out (plan unit H.5).
// A table whose header says "every" and enumerates a subset is the exact shape
// this wave keeps finding: a test that reads as coverage and is not.
//
// If you add a helper to _scope.ts with this signature, add it HERE too. The
// guard below fails if you don't.
const HELPERS = [
  { name: "casesScopeClause", fn: casesScopeClause, table: "cases" },
  { name: "petsScopeClause", fn: petsScopeClause, table: "pets" },
  { name: "custodyDisputesScopeClause", fn: custodyDisputesScopeClause, table: "custody_disputes" },
  { name: "welfareReportsScopeClause", fn: welfareReportsScopeClause, table: "welfare_reports" },
  { name: "organizationsScopeClause", fn: organizationsScopeClause, table: "organizations" },
] as const;

// The guard the comment above promises. Without it, "add it HERE too" is a
// request nobody enforces — and the table drifts back into a subset the moment
// someone adds a sixth helper, which is precisely how it became a subset the
// first time.
//
// `outbreakSignalScopeClause` is deliberately excluded: it scopes over the
// outbreak_signal event PAYLOAD's jurisdiction snapshot, not live table
// columns, so it cannot share the `table`-name assertions. It has its own
// describe block below — excluded, not forgotten.
const PAYLOAD_HELPERS = new Set(["outbreakSignalScopeClause"]);

describe("the HELPERS table covers every helper it claims to", () => {
  it("lists every 4-argument *ScopeClause export of _scope.ts", () => {
    const exported = Object.entries(scopeModule)
      .filter(
        ([name, value]) =>
          typeof value === "function" &&
          name.endsWith("ScopeClause") &&
          !PAYLOAD_HELPERS.has(name) &&
          (value as (...args: unknown[]) => unknown).length === 4,
      )
      .map(([name]) => name)
      .sort();

    expect(exported.length).toBeGreaterThan(0); // the filter itself must not go inert
    expect(HELPERS.map((h) => h.name).sort()).toEqual(exported);
  });
});

describe.each(HELPERS)("$name — scope contract", ({ fn, table }) => {
  it("admin with no drill → null (unrestricted)", () => {
    expect(fn(ADMIN, [])).toBeNull();
  });

  it("admin + province → province-only predicate", () => {
    const { sql: text, params } = render(fn(ADMIN, [], "Santa Fe"));
    expect(text).toContain(`"${table}"."jurisdiction_province"`);
    expect(text).not.toContain("jurisdiction_locality");
    expect(params).toEqual(["Santa Fe"]);
  });

  it("admin + province + locality → both operands", () => {
    const { sql: text, params } = render(fn(ADMIN, [], "Santa Fe", "Rosario"));
    expect(text).toContain(`"${table}"."jurisdiction_province"`);
    expect(text).toContain(`"${table}"."jurisdiction_locality"`);
    expect(params).toEqual(["Santa Fe", "Rosario"]);
  });

  it("govt with no assignments → false (never null / never unrestricted)", () => {
    const clause = fn(GOVT, []);
    expect(clause).not.toBeNull();
    expect(render(clause).sql).toContain("false");
  });

  // GUARANTEE 1 — the security invariant the hand-rolled call sites encoded.
  it("govt: the admin drill arguments are inert (byte-identical clause)", () => {
    const plain = render(fn(GOVT, [ROSARIO]));
    const drilled = render(fn(GOVT, [ROSARIO], "Córdoba", "Villa María"));
    expect(drilled).toEqual(plain);
    expect(drilled.params).not.toContain("Córdoba");
  });

  // GUARANTEE 3 — whole-province subsumption survives the consolidation.
  it("govt whole-province assignment → province-only predicate (subsumption)", () => {
    const { sql: text, params } = render(fn(GOVT, [WHOLE_CABA]));
    expect(text).toContain("jurisdiction_province");
    expect(text).not.toContain("jurisdiction_locality");
    expect(params).toEqual(["CABA"]);
  });

  it("govt barrio-specific assignment → exact pair (no subsumption)", () => {
    const { sql: text, params } = render(fn(GOVT, [ROSARIO]));
    expect(text).toContain("jurisdiction_province");
    expect(text).toContain("jurisdiction_locality");
    expect(params).toEqual(["Santa Fe", "Rosario"]);
  });
});

// ---------------------------------------------------------------------------
// outbreakSignalScopeClause — same contract, but over the outbreak_signal
// event PAYLOAD's jurisdiction snapshot instead of live table columns. Moved
// here from surveillance.ts, which kept a private byte-identical copy.
// ---------------------------------------------------------------------------

describe("outbreakSignalScopeClause — payload-snapshot scope contract", () => {
  const PROVINCE_KEY = "pet_jurisdiction_province";
  const LOCALITY_KEY = "pet_jurisdiction_locality";

  it("admin with no drill → null (unrestricted)", () => {
    expect(outbreakSignalScopeClause(ADMIN, [])).toBeNull();
  });

  it("admin + province → payload province key only", () => {
    const { sql: text, params } = render(outbreakSignalScopeClause(ADMIN, [], "Santa Fe"));
    expect(text).toContain(PROVINCE_KEY);
    expect(text).not.toContain(LOCALITY_KEY);
    expect(params).toEqual(["Santa Fe"]);
  });

  it("admin + province + locality → both payload keys", () => {
    const { sql: text, params } = render(
      outbreakSignalScopeClause(ADMIN, [], "Santa Fe", "Rosario"),
    );
    expect(text).toContain(PROVINCE_KEY);
    expect(text).toContain(LOCALITY_KEY);
    expect(params).toEqual(["Santa Fe", "Rosario"]);
  });

  it("govt with no assignments → false", () => {
    const clause = outbreakSignalScopeClause(GOVT, []);
    expect(clause).not.toBeNull();
    expect(render(clause).sql).toContain("false");
  });

  it("govt: the admin drill arguments are inert", () => {
    const plain = render(outbreakSignalScopeClause(GOVT, [ROSARIO]));
    const drilled = render(outbreakSignalScopeClause(GOVT, [ROSARIO], "Córdoba", "Villa María"));
    expect(drilled).toEqual(plain);
  });

  it("govt whole-province assignment → payload province key only (subsumption)", () => {
    const { sql: text, params } = render(outbreakSignalScopeClause(GOVT, [WHOLE_CABA]));
    expect(text).toContain(PROVINCE_KEY);
    expect(text).not.toContain(LOCALITY_KEY);
    expect(params).toEqual(["CABA"]);
  });

  it("never touches the live pets columns (payload-only by contract)", () => {
    const { sql: text } = render(outbreakSignalScopeClause(GOVT, [ROSARIO]));
    expect(text).not.toContain(`"pets"`);
  });
});

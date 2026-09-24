// Unit tests for buildGovtCaseWhereClause / buildCaseKindStatusClauses /
// buildAdminCaseFilterClauses (#26 admin↔gob drift unification, D2).
//
// Pure — no DB. Renders the Drizzle SQL via PgDialect().sqlToQuery (same
// pattern as lib/metrics/scope.test.ts / __tests__/maltrato-sql-queue.test.ts).
//
// Coverage:
//   - buildCaseKindStatusClauses: kind/status clauses are IDENTICAL whether
//     consumed by the admin or the govt builder (the shared axis).
//   - buildGovtCaseWhereClause: the mandatory jurisdiction predicate is
//     ALWAYS applied (fail-closed sql`false` for an empty jurisdictions
//     array — never "no restriction"), the SAME kind/status/province
//     clauses as admin, and the cursor appended last.
//   - PARITY: for the SAME kind/status/province filters, the admin clauses
//     (buildAdminCaseFilterClauses) and the govt clauses
//     (buildGovtCaseWhereClause, jurisdiction predicate stripped out) render
//     identical SQL text/params — the two builders differ ONLY by the
//     jurisdiction predicate.
//   - countCasesForGovt returns 0 for an empty jurisdictions array WITHOUT
//     querying the DB (cheap, DB-free regression guard for the early return).

import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { cases } from "@/db";
import {
  buildAdminCaseFilterClauses,
  buildCaseKindStatusClauses,
  buildGovtCaseWhereClause,
  countCasesForGovt,
} from "@/lib/infra/case-queries";
import { keysetWhere } from "@/lib/utils/keyset-pagination";
import { CASE_KINDS_ROUTED_ELSEWHERE } from "@/src/modules/cases/domain/case-kinds";

function render(clause: ReturnType<typeof and> | undefined) {
  if (!clause) return { sql: "", params: [] as unknown[] };
  return new PgDialect().sqlToQuery(clause);
}

describe("buildCaseKindStatusClauses — shared kind/status axis", () => {
  it("returns no clauses for empty filters", () => {
    expect(buildCaseKindStatusClauses({})).toHaveLength(0);
  });

  it("renders a kind clause", () => {
    const [clause] = buildCaseKindStatusClauses({ kind: "bite_incident" });
    const { sql: text, params } = render(clause);
    expect(text).toContain("case_kind");
    expect(params).toContain("bite_incident");
  });

  it("renders isNull(closedAt) for status=open, isNotNull for status=closed", () => {
    const [openClause] = buildCaseKindStatusClauses({ status: "open" });
    expect(render(openClause).sql).toMatch(/is null/i);
    const [closedClause] = buildCaseKindStatusClauses({ status: "closed" });
    expect(render(closedClause).sql).toMatch(/is not null/i);
  });
});

describe("buildGovtCaseWhereClause — jurisdiction predicate (#26 D2)", () => {
  it("fails CLOSED (sql`false`) for an empty jurisdictions array — never unscoped", () => {
    const clause = buildGovtCaseWhereClause([], {});
    const { sql: text } = render(clause);
    expect(text).toMatch(/false/);
  });

  it("applies the jurisdiction OR-clause for a non-empty jurisdictions array", () => {
    const clause = buildGovtCaseWhereClause(
      [{ province: "Buenos Aires", locality: "La Plata" }],
      {},
    );
    const { sql: text, params } = render(clause);
    expect(text).toContain("jurisdiction_province");
    expect(text).toContain("jurisdiction_locality");
    expect(params).toEqual(expect.arrayContaining(["Buenos Aires", "La Plata"]));
  });

  it("applies the kind filter identically to the admin builder", () => {
    const govtClause = buildGovtCaseWhereClause(
      [{ province: "Buenos Aires", locality: "La Plata" }],
      { kind: "bite_incident" },
    );
    const { sql: text, params } = render(govtClause);
    expect(text).toContain("case_kind");
    expect(params).toContain("bite_incident");
  });

  it("intersects an out-of-scope province with the jurisdiction predicate (narrows to zero, never widens)", () => {
    // province filter here is NOT one of the caller's own jurisdictions —
    // the resulting clause still ANDs both, so it can only narrow further.
    const clause = buildGovtCaseWhereClause([{ province: "Buenos Aires", locality: "La Plata" }], {
      province: "Córdoba",
    });
    const { sql: text, params } = render(clause);
    // Both the jurisdiction predicate AND the province narrowing appear —
    // an AND of a "Buenos Aires" OR-clause with "province = Córdoba" can
    // never match a real row, which is the fail-closed intersection we want.
    expect(text).toContain("jurisdiction_province");
    expect(params).toEqual(expect.arrayContaining(["Buenos Aires", "La Plata", "Córdoba"]));
  });

  it("whole-province (CABA) assignment subsumes a specific barrio — no locality equality against the sentinel string (pre-push review 2026-07-21)", () => {
    // A govt operator assigned the WHOLE CABA jurisdiction (province="CABA",
    // locality=the INDEC whole-province sentinel "Ciudad Autónoma de Buenos
    // Aires") must match every barrio in CABA — e.g. a case whose
    // jurisdiction_locality is "Palermo". Before the fix, buildGovtCaseWhereClause
    // built raw AND(province=X, locality=Y) pairs per assignment, so this
    // whole-province assignment rendered `locality = 'Ciudad Autónoma de Buenos
    // Aires'` — a literal-string match that NEVER matches "Palermo". Routing
    // through jurisdictionPairClause collapses the whole-province branch to a
    // province-only predicate, so the param list must NOT contain the sentinel
    // locality string at all.
    const clause = buildGovtCaseWhereClause(
      [{ province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" }],
      {},
    );
    const { sql: text, params } = render(clause);
    expect(text).toContain("jurisdiction_province");
    expect(params).toContain("CABA");
    expect(params).not.toContain("Ciudad Autónoma de Buenos Aires");
  });

  it("a barrio-specific assignment stays exact-match — does not widen to the whole province", () => {
    const clause = buildGovtCaseWhereClause([{ province: "CABA", locality: "Palermo" }], {});
    const { sql: text, params } = render(clause);
    expect(text).toContain("jurisdiction_province");
    expect(text).toContain("jurisdiction_locality");
    expect(params).toEqual(expect.arrayContaining(["CABA", "Palermo"]));
  });

  it("appends the cursor clause last when provided", () => {
    const cursorClause = keysetWhere(cases.openedAt, cases.id, {
      ts: "2026-07-01T00:00:00.000Z",
      id: "11111111-2222-3333-4444-555555555555",
    });
    const { sql: text } = render(
      buildGovtCaseWhereClause(
        [{ province: "Buenos Aires", locality: "La Plata" }],
        { kind: "bite_incident" },
        cursorClause,
      ),
    );
    const kindIdx = text.indexOf("case_kind");
    const cursorIdx = text.indexOf("opened_at");
    expect(kindIdx).toBeGreaterThanOrEqual(0);
    expect(cursorIdx).toBeGreaterThan(kindIdx);
  });
});

describe("admin vs govt case filter builders — parity (#26 D2)", () => {
  const FILTERS = { kind: "bite_incident" as const, status: "open" as const };

  it("produce the SAME kind/status SQL text — the only difference is the jurisdiction predicate", () => {
    const adminClauses = buildAdminCaseFilterClauses(FILTERS);
    const admin = render(and(...adminClauses));

    const govtClause = buildGovtCaseWhereClause(
      [{ province: "Buenos Aires", locality: "La Plata" }],
      FILTERS,
    );
    const govt = render(govtClause);

    // Every admin param (case_kind + closedAt-is-null, no jurisdiction
    // params) must also appear in the govt query.
    for (const p of admin.params) expect(govt.params).toContain(p);
    // The govt query additionally carries the jurisdiction predicate.
    expect(admin.sql).not.toContain("jurisdiction_province");
    expect(govt.sql).toContain("jurisdiction_province");
  });
});

describe("countCasesForGovt — DB-free empty-jurisdiction guard", () => {
  it("returns 0 for an empty jurisdictions array without querying the DB", async () => {
    await expect(countCasesForGovt([], {})).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// excludeKinds — kinds that have their own screen never reach the generic queue.
//
// Live review 2026-07-28: the same custody dispute (Bruno) appeared in TWO
// places under two codes — 11 rows in the /gob/casos tab (`cases`, CAS-, no
// actions at all) against 1 row in /gob/disputas (`custody_disputes`, DIS-,
// with the full resolve form) — and the two state chips did not even agree
// (ABIERTO vs ABIERTA). PO decision the same day: `custody_disputes` is
// canonical, so the generic queue stops showing the shadow copy.
//
// The exclusion lives in buildCaseKindStatusClauses, the ONE builder the list,
// the count and the keyset cursor all share, so a header can never claim a
// total its rows do not contain.
// ---------------------------------------------------------------------------

describe("buildCaseKindStatusClauses — excludeKinds", () => {
  it("emits no clause when excludeKinds is absent or empty (pure no-op)", () => {
    expect(buildCaseKindStatusClauses({})).toHaveLength(0);
    expect(buildCaseKindStatusClauses({ excludeKinds: [] })).toHaveLength(0);
  });

  it("emits a NOT IN clause naming every excluded kind", () => {
    const clauses = buildCaseKindStatusClauses({ excludeKinds: CASE_KINDS_ROUTED_ELSEWHERE });
    expect(clauses).toHaveLength(1);
    const { sql: text, params } = new PgDialect().sqlToQuery(and(...clauses)!);
    expect(text).toContain("not in");
    expect(params).toEqual([...CASE_KINDS_ROUTED_ELSEWHERE]);
  });

  it("routes custody_dispute away — the kind the decision was about", () => {
    // Named explicitly: if someone empties CASE_KINDS_ROUTED_ELSEWHERE, the
    // assertion above still passes on an empty list. This one does not.
    expect(CASE_KINDS_ROUTED_ELSEWHERE).toContain("custody_dispute");
  });

  it("composes with kind and status rather than replacing them", () => {
    const clauses = buildCaseKindStatusClauses({
      kind: "bite_incident",
      status: "open",
      excludeKinds: CASE_KINDS_ROUTED_ELSEWHERE,
    });
    expect(clauses).toHaveLength(3);
  });

  it("reaches the govt where-clause, so list/count/cursor cannot diverge", () => {
    const { sql: text, params } = new PgDialect().sqlToQuery(
      buildGovtCaseWhereClause([{ province: "Córdoba", locality: "Villa María" }], {
        excludeKinds: CASE_KINDS_ROUTED_ELSEWHERE,
      }),
    );
    expect(text).toContain("not in");
    expect(params).toContain("custody_dispute");
  });
});

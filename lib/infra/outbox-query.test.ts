// Unit tests for lib/infra/outbox-query.ts (#26 admin↔gob drift unification,
// D3).
//
// Pure — no DB. Renders the Drizzle SQL via PgDialect().sqlToQuery (same
// pattern as lib/metrics/scope.test.ts, which tests jurisdictionPairClause —
// the exact predicate this builder delegates to for the govt branch).
//
// Coverage:
//   - No filters / no scope / no cursor → undefined WHERE (page 1, admin,
//     unfiltered — matches both pages' original "no WHERE at all" shape).
//   - Each user-facing filter (status, target_kind, province, breach yes/no)
//     renders the expected condition; invalid values are ignored.
//   - PARITY: the jurisdiction predicate is applied IFF `opts.jurisdiction`
//     is provided — undefined (admin) never touches the jurisdiction
//     columns; a provided array (govt) always does, even when empty
//     (fail-closed, never "no restriction").
//   - Cursor clause is always appended last.

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  ENO_PRESET_TARGET_KINDS,
  OUTBOX_PAGE_LIMIT,
  VALID_PROVINCE_NAMES,
  buildOutboxWhere,
  outboxOrderBy,
  outboxSupportsKeyset,
  parseOutboxFilters,
  parseOutboxPreset,
} from "@/lib/infra/outbox-query";

function render(clause: ReturnType<typeof buildOutboxWhere>) {
  if (!clause) return { sql: "", params: [] as unknown[] };
  return new PgDialect().sqlToQuery(clause);
}

const CURSOR = { ts: "2026-07-01T00:00:00.000Z", id: "11111111-2222-3333-4444-555555555555" };

describe("buildOutboxWhere — constants", () => {
  it("exposes the shared page limit and canonical province set", () => {
    expect(OUTBOX_PAGE_LIMIT).toBe(200);
    expect(VALID_PROVINCE_NAMES.size).toBeGreaterThan(0);
    expect(VALID_PROVINCE_NAMES.has("Buenos Aires")).toBe(true);
  });
});

describe("buildOutboxWhere — no filters / no scope / no cursor", () => {
  it("returns undefined (no WHERE at all) — admin, unfiltered, page 1", () => {
    const clause = buildOutboxWhere({}, { cursor: null });
    expect(clause).toBeUndefined();
  });
});

describe("buildOutboxWhere — user-facing filters", () => {
  it("renders a status condition for a valid status", () => {
    const { sql: text, params } = render(buildOutboxWhere({ status: "pending" }, { cursor: null }));
    expect(text).toContain("status");
    expect(params).toContain("pending");
  });

  it("ignores an invalid status value", () => {
    const clause = buildOutboxWhere({ status: "bogus" }, { cursor: null });
    expect(clause).toBeUndefined();
  });

  it("renders a target_kind condition for a valid value", () => {
    const { sql: text, params } = render(
      buildOutboxWhere({ target_kind: "govt_webhook" }, { cursor: null }),
    );
    expect(text).toContain("target_kind");
    expect(params).toContain("govt_webhook");
  });

  it("renders a province condition for a canonical province name", () => {
    const { sql: text, params } = render(
      buildOutboxWhere({ province: "Buenos Aires" }, { cursor: null }),
    );
    expect(text).toContain("target_jurisdiction_province");
    expect(params).toContain("Buenos Aires");
  });

  it("ignores a non-canonical province value", () => {
    const clause = buildOutboxWhere({ province: "Not A Real Province" }, { cursor: null });
    expect(clause).toBeUndefined();
  });

  it("breach=yes renders pending + past-SLA, skipping the standalone status condition", () => {
    const { sql: text, params } = render(
      buildOutboxWhere({ breach: "yes", status: "delivered" }, { cursor: null }),
    );
    // status='delivered' AND status='pending' would be always-false — the
    // standalone status condition must be skipped when breach=yes.
    expect(params).toContain("pending");
    expect(params).not.toContain("delivered");
    expect(text).toContain("sla_due_at");
  });

  it("breach=no renders the NOT(pending AND past-SLA) guard", () => {
    const { sql: text } = render(buildOutboxWhere({ breach: "no" }, { cursor: null }));
    expect(text).toMatch(/not\s*\(/i);
  });
});

describe("buildOutboxWhere — cursor is appended last", () => {
  it("keeps the cursor comparison after the user-facing filter conditions", () => {
    const { sql: text } = render(buildOutboxWhere({ status: "pending" }, { cursor: CURSOR }));
    const statusIdx = text.indexOf("status");
    const cursorIdx = text.indexOf("created_at");
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(cursorIdx).toBeGreaterThan(statusIdx);
  });
});

// ---------------------------------------------------------------------------
// PARITY — the jurisdiction predicate is applied IFF `opts.jurisdiction` is
// provided. This is the D3 contract: admin (undefined) and govt (an array,
// possibly empty) must differ ONLY by this predicate for the same filters.
// ---------------------------------------------------------------------------
describe("buildOutboxWhere — jurisdiction predicate parity (#26 D3)", () => {
  const FILTERS = { status: "pending" as const };

  it("admin (jurisdiction undefined) never touches jurisdiction columns", () => {
    const { sql: text } = render(buildOutboxWhere(FILTERS, { cursor: null }));
    expect(text).not.toContain("target_jurisdiction_province");
    expect(text).not.toContain("target_jurisdiction_locality");
  });

  it("govt with a non-empty scope applies the jurisdiction predicate", () => {
    const { sql: text, params } = render(
      buildOutboxWhere(FILTERS, {
        jurisdiction: [{ province: "Buenos Aires", locality: "La Plata" }],
        cursor: null,
      }),
    );
    expect(text).toContain("target_jurisdiction_province");
    expect(text).toContain("target_jurisdiction_locality");
    expect(params).toEqual(expect.arrayContaining(["Buenos Aires", "La Plata"]));
  });

  it("govt with an EMPTY scope fails closed (matches nothing), never unscoped", () => {
    const { sql: text } = render(buildOutboxWhere(FILTERS, { jurisdiction: [], cursor: null }));
    // The fail-closed sql`false` literal must appear in the composed clause.
    expect(text).toMatch(/false/);
  });

  it("admin and govt(non-empty) produce the SAME user-facing filter conditions — differ only by the jurisdiction predicate", () => {
    const adminClause = buildOutboxWhere(FILTERS, { cursor: null });
    const govtClause = buildOutboxWhere(FILTERS, {
      jurisdiction: [{ province: "Buenos Aires", locality: "La Plata" }],
      cursor: null,
    });
    const admin = render(adminClause);
    const govt = render(govtClause);
    // The govt query is the admin query's status condition PLUS the
    // jurisdiction predicate — every admin param must still be present, and
    // the admin query must carry the SAME status condition text.
    for (const p of admin.params) expect(govt.params).toContain(p);
    expect(admin.sql).toContain("status");
    expect(govt.sql).toContain("status");
  });

  it("a whole-province govt assignment subsumes locality (jurisdictionPairClause delegation)", () => {
    const { sql: text, params } = render(
      buildOutboxWhere(
        {},
        {
          jurisdiction: [{ province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" }],
          cursor: null,
        },
      ),
    );
    expect(text).toContain("target_jurisdiction_province");
    expect(text).not.toContain("target_jurisdiction_locality");
    expect(params).toContain("CABA");
  });
});

// ---------------------------------------------------------------------------
// PRESET — `?preset=eno`, the legal-notification queue (2026-09-09). A filter
// PLUS an order, shared by both twins through this module; never a second
// page. The nav deep-links it (components/layout/nav-presets.ts, "Cola ENO").
// ---------------------------------------------------------------------------
describe("parseOutboxPreset / parseOutboxFilters — the ?preset= alias", () => {
  it("recognises eno, ignores anything else, and survives a repeated param", () => {
    expect(parseOutboxPreset("eno")).toBe("eno");
    expect(parseOutboxPreset(" eno ")).toBe("eno");
    expect(parseOutboxPreset("bogus")).toBeNull();
    expect(parseOutboxPreset(undefined)).toBeNull();
    expect(parseOutboxPreset(null)).toBeNull();
    // Q1: `?preset=eno&preset=eno` arrives as string[]; the first value wins.
    expect(parseOutboxPreset(["eno", "bogus"])).toBe("eno");
  });

  it("parseOutboxFilters reads every axis once, Q1-safe, with an unknown preset as null", () => {
    expect(
      parseOutboxFilters({
        status: ["pending", "failed"],
        target_kind: " eno_authority ",
        breach: "yes",
        province: "Buenos Aires",
        preset: "nope",
      }),
    ).toEqual({
      status: "pending",
      target_kind: "eno_authority",
      breach: "yes",
      province: "Buenos Aires",
      preset: null,
    });
    expect(parseOutboxFilters({ preset: "eno" }).preset).toBe("eno");
  });
});

describe("buildOutboxWhere — the eno preset narrows to the legal target kinds", () => {
  it("renders an IN over exactly eno_authority + govt_webhook, and nothing else", () => {
    const { sql: text, params } = render(buildOutboxWhere({ preset: "eno" }, { cursor: null }));
    expect(text).toContain("target_kind");
    expect(text).toMatch(/\bin\b/i);
    expect(params).toEqual(expect.arrayContaining([...ENO_PRESET_TARGET_KINDS]));
    expect(params).not.toContain("audit_export");
    expect(params).not.toContain("internal_dashboard");
    expect(ENO_PRESET_TARGET_KINDS).toEqual(["eno_authority", "govt_webhook"]);
  });

  it("a null preset adds no target-kind condition at all", () => {
    expect(buildOutboxWhere({ preset: null }, { cursor: null })).toBeUndefined();
  });

  it("is AND-composed with a single target_kind filter — a kind outside the preset matches nothing, never widens it", () => {
    const { sql: text, params } = render(
      buildOutboxWhere({ preset: "eno", target_kind: "audit_export" }, { cursor: null }),
    );
    // Both predicates present, joined by AND (an OR would widen the legal queue).
    expect(params).toContain("audit_export");
    expect(params).toEqual(expect.arrayContaining([...ENO_PRESET_TARGET_KINDS]));
    expect(text).toMatch(/\band\b/i);
    expect(text).not.toMatch(/\bor\b/i);
  });

  it("keeps the jurisdiction predicate for a govt on the preset (privacy invariant, unchanged)", () => {
    const { sql: text, params } = render(
      buildOutboxWhere(
        { preset: "eno" },
        { jurisdiction: [{ province: "Buenos Aires", locality: "La Plata" }], cursor: null },
      ),
    );
    expect(text).toContain("target_jurisdiction_province");
    expect(params).toEqual(expect.arrayContaining(["Buenos Aires", "La Plata"]));
  });
});

describe("outboxOrderBy / outboxSupportsKeyset — what comes first in the legal queue", () => {
  function renderOrder(preset: Parameters<typeof outboxOrderBy>[0]) {
    return outboxOrderBy(preset).map((o) => new PgDialect().sqlToQuery(o).sql);
  }

  it("no preset keeps the recency order the keyset cursor paginates over", () => {
    const [first, second] = renderOrder(null);
    expect(first).toMatch(/created_at.*desc/i);
    expect(second).toMatch(/\bid\b.*desc/i);
    expect(outboxSupportsKeyset(null)).toBe(true);
    expect(outboxSupportsKeyset(undefined)).toBe(true);
  });

  it("eno sorts open breaches first, then the nearest legal deadline, id as the tie-break — and takes no keyset cursor", () => {
    const [breachedFirst, byDeadline, tieBreak] = renderOrder("eno");
    // A row past its statutory deadline AND still pending outranks everything.
    expect(breachedFirst).toMatch(/status.*=.*'pending'/i);
    expect(breachedFirst).toMatch(/sla_due_at.*<.*now\(\)/i);
    expect(breachedFirst).toMatch(/desc/i);
    // Then the deadline itself, soonest first.
    expect(byDeadline).toMatch(/sla_due_at.*asc/i);
    expect(tieBreak).toMatch(/\bid\b.*asc/i);
    expect(outboxSupportsKeyset("eno")).toBe(false);
  });
});

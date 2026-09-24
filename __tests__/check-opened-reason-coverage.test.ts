/**
 * Unit tests for scripts/check-opened-reason-coverage.ts — the case open-reason
 * bypass guard. Pure fixture tests: each rule is exercised against small
 * synthetic file contents, so the guard's own logic is pinned independently of
 * the live tree (same posture as __tests__/check-metric-labels.test.ts).
 *
 * A fence nobody tested is a fence nobody knows is standing.
 */

import { describe, expect, it } from "vitest";

import { scanFile, scanRule1, scanRule2, scanRule3 } from "@/scripts/check-opened-reason-coverage";

const PROSE_MODULE = "src/modules/cases/domain/opened-reason-prose.ts";
const CASES_REPOSITORY = "src/modules/cases/infrastructure/cases-repository.ts";
const LEGACY_MODULE = "src/modules/cases/domain/opened-reason-legacy.ts";

// ---------------------------------------------------------------------------
// Rule 1 — literal prose assigned to openedReason
// ---------------------------------------------------------------------------

describe("rule 1 — no open-reason prose outside opened-reason-prose.ts", () => {
  it("flags a double-quoted literal (the transfer-custody bug shape)", () => {
    const hits = scanRule1(
      "src/modules/transfers/application/transfer-custody.ts",
      `await openCase({\n  kind: "custody_transfer_handshake",\n  openedReason: "auto: direct custody handoff to_role=owner",\n});`,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].rule).toBe(1);
    expect(hits[0].line).toBe(3);
  });

  it("flags a template literal", () => {
    const hits = scanRule1(
      "src/modules/foo/writer.ts",
      "await openCase({ openedReason: `auto: whatever reason=${x}` });",
    );
    expect(hits).toHaveLength(1);
  });

  it("does NOT flag a structured reason", () => {
    expect(
      scanRule1(
        "src/modules/transfers/application/transfer-custody.ts",
        'await openCase({ openedReason: { code: "custody_handoff_direct", toRole } });',
      ),
    ).toEqual([]);
  });

  it("does NOT flag a variable — unverifiable statically, and tsc types it", () => {
    expect(
      scanRule1("src/modules/foo/writer.ts", "await openCase({ openedReason: reason });"),
    ).toEqual([]);
  });

  it("ALLOWS literals in the prose module — that is its whole job", () => {
    expect(
      scanRule1(
        PROSE_MODULE,
        'custody_handoff_direct: (p) => `auto: direct custody handoff to_role=${p.toRole}`,\nopenedReason: "auto: x",',
      ),
    ).toEqual([]);
  });

  it("reports every hit in a file, not just the first", () => {
    expect(
      scanRule1(
        "src/modules/foo/writer.ts",
        'openCase({ openedReason: "one" });\nopenCase({ openedReason: "two" });',
      ),
    ).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — direct db.insert(cases) writing opened_reason
// ---------------------------------------------------------------------------

describe("rule 2 — only the repository writes the opened_reason columns", () => {
  it("flags a direct insert that skips the dual-write", () => {
    const hits = scanRule2(
      "src/modules/rogue/rogue-repository.ts",
      "const [row] = await db\n  .insert(cases)\n  .values({\n    publicCode,\n    openedReason: someProse,\n  })\n  .returning();",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].rule).toBe(2);
  });

  it("flags the snake_case column name too", () => {
    expect(
      scanRule2(
        "src/modules/rogue/rogue.ts",
        "await db.insert(cases).values({ opened_reason: prose });",
      ),
    ).toHaveLength(1);
  });

  it("does NOT flag an insert into cases that leaves opened_reason alone", () => {
    expect(
      scanRule2(
        "src/modules/foo/other.ts",
        "await db.insert(cases).values({ publicCode, caseKind: 'bite_incident' });",
      ),
    ).toEqual([]);
  });

  it("does NOT flag an insert into a different table", () => {
    expect(
      scanRule2(
        "src/modules/foo/other.ts",
        "await db.insert(petEvents).values({ openedReason: x });",
      ),
    ).toEqual([]);
  });

  it("ALLOWS the repository — it is the choke point", () => {
    expect(
      scanRule2(
        CASES_REPOSITORY,
        "await executor.insert(cases).values({ ...resolveOpenedReasonColumns(input.openedReason) });",
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — the frozen legacy rule count
// ---------------------------------------------------------------------------

function legacyWithRules(n: number): string {
  return `const RULES: Rule[] = [\n${Array.from(
    { length: n },
    (_, i) => `  {\n    pattern: /^auto: rule ${i}$/,\n    render: () => "x",\n  },`,
  ).join("\n")}\n];`;
}

describe("rule 3 — the legacy regex path is frozen at 16", () => {
  it("passes at exactly 16 rules", () => {
    expect(scanRule3(LEGACY_MODULE, legacyWithRules(16))).toEqual([]);
  });

  it("FAILS when a 17th rule is added — a new writer took the frozen path", () => {
    const hits = scanRule3(LEGACY_MODULE, legacyWithRules(17));
    expect(hits).toHaveLength(1);
    expect(hits[0].rule).toBe(3);
    expect(hits[0].detail).toContain("closed to new writers");
  });

  it("FAILS when a rule is removed — pre-cutover rows still need it", () => {
    const hits = scanRule3(LEGACY_MODULE, legacyWithRules(15));
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain("can never be backfilled");
  });

  it("only applies to the legacy module", () => {
    expect(scanRule3("src/modules/foo/other.ts", legacyWithRules(99))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The real modules pass their own guard
// ---------------------------------------------------------------------------

describe("scanFile — composition", () => {
  it("collects violations across rules in one pass", () => {
    const hits = scanFile(
      "src/modules/rogue/rogue.ts",
      'openCase({ openedReason: "auto: bypass" });\nawait db.insert(cases).values({ openedReason: p });',
    );
    expect(hits.map((h) => h.rule).sort()).toEqual([1, 2]);
  });

  it("a clean production writer produces nothing", () => {
    expect(
      scanFile(
        "src/modules/transfers/application/transfer-custody.ts",
        'await openCase({ openedReason: { code: "custody_handoff_direct", toRole } });',
      ),
    ).toEqual([]);
  });
});

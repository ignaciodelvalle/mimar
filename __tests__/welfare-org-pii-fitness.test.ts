// Fitness test — org-facing welfare report PII guard (ARCH-J, 2026-06-10).
//
// PURPOSE:
//   Reporter PII (reporterContactEmail, reporterContactPhone, reporterUserId)
//   MUST NEVER appear in any org-facing welfare query shape. Derivation is not
//   a separate table — it is three columns on the same welfare_reports row. The
//   only structural protection is that every org-facing query uses
//   ORG_WELFARE_SELECT from lib/welfare-org-projection.ts instead of select(*).
//
// WHAT THIS TEST DOES:
//   1. Static projection guard — asserts ORG_WELFARE_SELECT keys contain none of
//      the denylist fields. Fails immediately if the helper is accidentally updated
//      to include a PII column.
//   2. Non-vacuity — asserts ORG_WELFARE_SELECT contains expected safe fields,
//      confirming the projection is not empty or trivially narrow.
//   3. Denylist completeness — asserts the denylist itself has the 4 known PII
//      fields; a diff here forces deliberate review.
//   4. Static source scan — asserts no file under app/org/** references a
//      denylist column identifier directly, closing the bypass hole where a
//      future org page queries welfare_reports without ORG_WELFARE_SELECT.
//      (Same source-scan pattern as server-actions-auth-coverage.test.ts.)
//
// HOW TO MAINTAIN:
//   If a new PII column is added to welfare_reports, add it to
//   ORG_WELFARE_PII_DENYLIST in lib/welfare-org-projection.ts. This test will
//   then fail until ORG_WELFARE_SELECT is verified not to include it.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ORG_WELFARE_CASE_COLS,
  ORG_WELFARE_PET_COLS,
  ORG_WELFARE_PII_DENYLIST,
  ORG_WELFARE_SELECT,
} from "@/lib/infra/welfare-org-projection";

// ---------------------------------------------------------------------------
// 1. Static projection guard
// ---------------------------------------------------------------------------

describe("ORG_WELFARE_SELECT — PII denylist enforcement", () => {
  it("must not contain any field in ORG_WELFARE_PII_DENYLIST", () => {
    const projectedKeys = Object.keys(ORG_WELFARE_SELECT);
    for (const piiField of ORG_WELFARE_PII_DENYLIST) {
      expect(
        projectedKeys,
        `PII field "${piiField}" found in ORG_WELFARE_SELECT — remove it from the org projection to protect reporter identity.`,
      ).not.toContain(piiField);
    }
  });

  it("extended shapes (case + pet cols) must not contain any PII field", () => {
    const extendedKeys = [
      ...Object.keys(ORG_WELFARE_CASE_COLS),
      ...Object.keys(ORG_WELFARE_PET_COLS),
    ];
    for (const piiField of ORG_WELFARE_PII_DENYLIST) {
      expect(
        extendedKeys,
        `PII field "${piiField}" found in extended org welfare columns.`,
      ).not.toContain(piiField);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Non-vacuity — projection must include expected safe fields
// ---------------------------------------------------------------------------

describe("ORG_WELFARE_SELECT — non-vacuity", () => {
  it("contains the minimum required safe fields for org inbox display", () => {
    const keys = Object.keys(ORG_WELFARE_SELECT);
    const required = [
      "reportId",
      "referenceCode",
      "kind",
      "severity",
      "status",
      "subjectKind",
      "createdAt",
      "derivedAt",
      "jurisdictionProvince",
    ];
    for (const field of required) {
      expect(keys, `Expected safe field "${field}" missing from ORG_WELFARE_SELECT.`).toContain(
        field,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Denylist completeness — guard against untracked PII columns
// ---------------------------------------------------------------------------

describe("ORG_WELFARE_PII_DENYLIST — completeness", () => {
  it("contains exactly the four known reporter PII fields", () => {
    // If a new PII column is added to welfare_reports, add it here AND to
    // ORG_WELFARE_PII_DENYLIST in lib/welfare-org-projection.ts.
    const expected = [
      "reporterContactEmail",
      "reporterContactPhone",
      "reporterUserId",
      "description",
    ] as const;

    expect([...ORG_WELFARE_PII_DENYLIST].sort()).toEqual([...expected].sort());
  });
});

// ---------------------------------------------------------------------------
// 4. Static source scan — no org-facing source may reference a PII column
// ---------------------------------------------------------------------------
//
// ORG_WELFARE_SELECT only protects queries that go through it. A future org
// page could query welfare_reports directly and re-expose reporter PII. This
// scan walks app/org/** and fails on any source-level reference to
// `welfareReports.<denylistField>`. Scoped to the welfareReports identifier so
// unrelated uses of common words (e.g. a pet "description") don't false-positive.

function walkSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkSourceFiles(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

describe("app/org/** — static PII reference scan", () => {
  it("no org-facing source references welfareReports.<PII column>", () => {
    const files = walkSourceFiles(join(process.cwd(), "app", "org"));
    expect(files.length).toBeGreaterThan(0); // non-vacuity: the tree must exist

    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const piiField of ORG_WELFARE_PII_DENYLIST) {
        const pattern = new RegExp(`welfareReports\\s*\\.\\s*${piiField}\\b`);
        if (pattern.test(source)) {
          violations.push(`${file} references welfareReports.${piiField}`);
        }
      }
    }

    expect(
      violations,
      `Org-facing source references reporter PII columns directly — route the query through ORG_WELFARE_SELECT instead:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});

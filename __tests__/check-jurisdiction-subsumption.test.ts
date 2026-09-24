/**
 * Unit tests for scripts/check-jurisdiction-subsumption.ts.
 *
 * Pure fixture tests — no filesystem I/O. Exercises the exact-pair detector
 * against known-bad and known-good inline source strings.
 *
 * Regression fixtures (2026-07-22 hardening): the original detector only
 * matched the in-memory `===` shape and MISSED the identical bug hand-rolled
 * through query-builder calls — exactly how it slipped past on
 * buildGovtCaseWhereClause (lib/infra/case-queries.ts) and the govt branch of
 * fetchObservaciones (lib/metrics/observaciones-query.ts), both fixed in
 * commit 68501bb4. The "previously missed pattern" fixtures below are taken
 * verbatim from those two functions' pre-fix source (via `git show
 * 68501bb4^:...`), so this test proves the fence would have caught them.
 */

import { describe, expect, it } from "vitest";

import { findSubsumptionOffenders } from "@/scripts/check-jurisdiction-subsumption";

describe("findSubsumptionOffenders — Shape 1 (in-memory === chain, original design)", () => {
  it("flags an exact-pair === chain", () => {
    const src = `
      jurisdictions.some(
        (j) => j.province === row.jurisdictionProvince &&
               j.locality === row.jurisdictionLocality,
      )
    `;
    // The sliding 3-line window can report the same construct at more than
    // one adjacent start line — assert non-empty, not an exact count.
    expect(findSubsumptionOffenders("fake/site.ts", src).length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag a UI-selection === comparison (different field names)", () => {
    const src = `
      selectedLocalityRow.localityName === row.localityName
    `;
    expect(findSubsumptionOffenders("fake/site.ts", src)).toHaveLength(0);
  });
});

describe("findSubsumptionOffenders — Shape 2 (previously missed): Drizzle and(eq, eq)", () => {
  it("catches the pre-fix buildGovtCaseWhereClause shape (case-queries.ts, commit 68501bb4^)", () => {
    // Verbatim pre-fix shape: an OR-of-AND-pairs built by mapping the govt
    // operator's OWN jurisdictions array — the exact form the original
    // ===-anchored regex could never see.
    const src = `
      const jurisdictionFilter: SQL =
        jurisdictions.length > 0
          ? (or(
              ...jurisdictions.map((j) =>
                and(
                  eq(cases.jurisdictionProvince, j.province),
                  eq(cases.jurisdictionLocality, j.locality),
                ),
              ),
            ) as SQL)
          : sql\`false\`;
    `;
    expect(findSubsumptionOffenders("fake/case-queries.ts", src)).toHaveLength(1);
  });

  it("does NOT flag an admin province drill-down (single hand-picked value, no .map)", () => {
    const src = `
      if (ctx.adminLocality) {
        return and(
          eq(pets.jurisdictionProvince, ctx.adminProvince),
          eq(pets.jurisdictionLocality, ctx.adminLocality),
        );
      }
    `;
    expect(findSubsumptionOffenders("fake/_scope.ts", src)).toHaveLength(0);
  });

  it("does NOT flag a UI-selection filter (selectedProvince/selectedLocality, no .map)", () => {
    const src = `
      if (selectedLocality) {
        conditions.push(
          and(
            eq(welfareReports.jurisdictionProvince, selectedProvince),
            eq(welfareReports.jurisdictionLocality, selectedLocality),
          ),
        );
      }
    `;
    expect(findSubsumptionOffenders("fake/welfare.ts", src)).toHaveLength(0);
  });

  it("does NOT flag independent if-guarded UI-filter eq() pushes (adoption-listing-read.ts shape)", () => {
    const src = `
      if (filters.province) conditions.push(eq(pets.jurisdictionProvince, filters.province));
      if (filters.locality) conditions.push(eq(pets.jurisdictionLocality, filters.locality));
    `;
    expect(findSubsumptionOffenders("fake/adoption-listing-read.ts", src)).toHaveLength(0);
  });

  it("does NOT flag an already subsumption-guarded ternary (approval-scope.ts visibleRequestsClause shape)", () => {
    const src = `
      const tupleMatches = or(
        ...jurisdictions.map((j) =>
          isWholeProvinceLocality(j.province, j.locality)
            ? eq(approvalRequests.jurisdictionProvince, j.province)
            : and(
                eq(approvalRequests.jurisdictionProvince, j.province),
                eq(approvalRequests.jurisdictionLocality, j.locality),
              ),
        ),
      );
    `;
    expect(findSubsumptionOffenders("fake/approval-scope.ts", src)).toHaveLength(0);
  });
});

describe("findSubsumptionOffenders — Shape 3 (previously missed): raw sql template exact pair", () => {
  it("catches the pre-fix fetchObservaciones shape (observaciones-query.ts, commit 68501bb4^)", () => {
    const src = `
      const pairs = scope.jurisdictions.map(
        (j) =>
          sql\`(\${pets.jurisdictionProvince} = \${j.province} AND \${pets.jurisdictionLocality} = \${j.locality})\`,
      );
      conditions.push(sql\`(\${sql.join(pairs, sql\` OR \`)})\`);
    `;
    // The sliding 3-line window can report the same construct at more than
    // one adjacent start line — assert non-empty, not an exact count.
    expect(
      findSubsumptionOffenders("fake/observaciones-query.ts", src).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag the jurisdictionPairClause helper's own implementation shape", () => {
    // Same literal shape, but this is the canonical helper itself — real
    // scans never reach it because lib/metrics/scope.ts is SANCTIONED
    // (file-level skip). This fixture only proves the shape isn't rejected
    // for some OTHER structural reason (e.g. missing .map lookback).
    const src = `
      const pairs = jurisdictions.map((j) =>
        isWholeProvinceLocality(j.province, j.locality)
          ? sql\`(\${provinceExpr} = \${j.province})\`
          : sql\`(\${provinceExpr} = \${j.province} AND \${localityExpr} = \${j.locality})\`,
      );
    `;
    // Guarded by the nearby isWholeProvinceLocality ternary — not an offender.
    expect(findSubsumptionOffenders("fake/scope.ts", src)).toHaveLength(0);
  });
});

describe("findSubsumptionOffenders — regression: real fixed sites stay clean", () => {
  it("the fixed buildGovtCaseWhereClause shape (post-68501bb4, via jurisdictionPairClause) is clean", () => {
    const src = `
      const jurisdictionFilter: SQL =
        jurisdictionPairClause(
          [...jurisdictions],
          sql\`\${cases.jurisdictionProvince}\`,
          sql\`\${cases.jurisdictionLocality}\`,
        ) ?? sql\`false\`;
    `;
    expect(findSubsumptionOffenders("fake/case-queries.ts", src)).toHaveLength(0);
  });
});

// Fitness test — the denuncia data partition (legal review 2026-08-17).
//
// The partition in lib/domain/denuncia-data-partition.ts is only worth
// anything if it stays TOTAL. A classification that silently misses the next
// column added to `welfare_reports` is worse than none: it looks like a
// boundary and leaks. So this test does not check a denylist of known-bad
// names — it checks the SUBJECT. Every column drizzle reports on the live
// table must be classified into exactly one class, or the suite goes red until
// somebody decides which side it belongs to.
//
// That is the difference between "we banned these four spellings" and "nothing
// can enter this table unclassified", and it is the reason the previous shape
// of this guard (a four-name denylist in one projection module) could not have
// caught `resolution_notes` or `subject_pet_id`.
//
// WHAT IS ASSERTED
//   1. Totality      — every welfareReports column is classified exactly once.
//   2. Fidelity      — each entry's SQL column name matches drizzle's.
//   3. Disjointness  — the two governance select shapes overlap ONLY on the
//                      declared join/clock key.
//   4. Non-vacuity   — each shape actually carries its own side.
//   5. Purge plans   — cover exactly their class, and use a sentinel exactly
//                      for the NOT NULL columns (a null there is a constraint
//                      violation in an unattended scheduled job).
//   6. Pair safety   — location_lat and location_lng purge together, or
//                      welfare_reports_location_pair_check fails.

import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { welfareReports } from "@/db";
import {
  ALL_PARTITIONED_COLUMNS,
  CASE_RECORD_AGGREGATE_DIMENSIONS,
  CASE_RECORD_COLUMNS,
  CONTENT_PURGE_PLAN,
  DENUNCIA_CONTENT_COLUMNS,
  DENUNCIA_JOIN_KEY_COLUMNS,
  REPORTER_IDENTITY_COLUMNS,
  REPORTER_IDENTITY_PURGE_PLAN,
  classifyWelfareReportColumn,
} from "@/lib/domain/denuncia-data-partition";
import {
  DENUNCIA_CONTENT_SELECT,
  DENUNCIA_REPORTER_IDENTITY_SELECT,
} from "@/lib/infra/welfare-report-partition";

const tableColumns = getTableColumns(welfareReports);
const tableProperties = Object.keys(tableColumns);

// ---------------------------------------------------------------------------
// 1. Totality — nothing enters welfare_reports unclassified
// ---------------------------------------------------------------------------

describe("denuncia data partition — totality", () => {
  it("classifies every welfare_reports column exactly once", () => {
    const unclassified = tableProperties.filter((p) => classifyWelfareReportColumn(p) === null);
    expect(
      unclassified,
      "New welfare_reports column(s) with no side. Decide in " +
        "lib/domain/denuncia-data-partition.ts whether each is reporter_identity " +
        "(reservable + separately expirable), denuncia_content (R1/R2 purge unit) " +
        "or case_record (survives the purge). Leaving it unclassified means the " +
        "art. 17 inc. 1 reserve and the retention purge both silently skip it.",
    ).toEqual([]);
  });

  it("classifies nothing that is not a welfare_reports column", () => {
    const orphans = ALL_PARTITIONED_COLUMNS.map((c) => c.property).filter(
      (p) => !tableProperties.includes(p),
    );
    expect(orphans, "Partition names a column welfare_reports does not have.").toEqual([]);
  });

  it("assigns each column to exactly one class", () => {
    const seen = new Map<string, number>();
    for (const { property } of ALL_PARTITIONED_COLUMNS) {
      seen.set(property, (seen.get(property) ?? 0) + 1);
    }
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([p]) => p);
    expect(duplicated, "Column classified into more than one class.").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Fidelity — the declared SQL names are the real ones
// ---------------------------------------------------------------------------

describe("denuncia data partition — SQL name fidelity", () => {
  it("every entry's column name matches drizzle's", () => {
    const mismatches: string[] = [];
    for (const { property, column } of ALL_PARTITIONED_COLUMNS) {
      const actual = tableColumns[property as keyof typeof tableColumns]?.name;
      if (actual !== column) {
        mismatches.push(`${property}: declared "${column}", actual "${actual}"`);
      }
    }
    expect(
      mismatches,
      "The partition's SQL names feed the database-view cross-check in " +
        "denuncia-separation-boundary.test.ts. A wrong name there makes that " +
        "check pass vacuously.",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Disjointness — the two governance shapes share only the join/clock key
// ---------------------------------------------------------------------------

describe("governance select shapes — disjointness", () => {
  const contentKeys = Object.keys(DENUNCIA_CONTENT_SELECT);
  const identityKeys = Object.keys(DENUNCIA_REPORTER_IDENTITY_SELECT);
  const joinKeys = DENUNCIA_JOIN_KEY_COLUMNS.map((c) => c.property);

  it("the content shape carries no reporter-identity column", () => {
    for (const { property } of REPORTER_IDENTITY_COLUMNS) {
      expect(
        contentKeys,
        `"${property}" is reporter identity and must not be readable through the content shape — that shape is what an art. 17 answer to the denunciado draws from.`,
      ).not.toContain(property);
    }
  });

  it("the reporter-identity shape carries no content column", () => {
    for (const { property } of DENUNCIA_CONTENT_COLUMNS) {
      expect(
        identityKeys,
        `"${property}" is denuncia content and must not be readable through the reporter-identity shape — the reporter side has to be expirable without reading the accused's data.`,
      ).not.toContain(property);
    }
  });

  it("overlaps ONLY on the declared join/clock key", () => {
    const overlap = contentKeys.filter((k) => identityKeys.includes(k)).sort();
    expect(overlap).toEqual([...joinKeys].sort());
  });

  it("the content shape is exactly case_record ∪ denuncia_content", () => {
    const expected = [
      ...CASE_RECORD_COLUMNS.map((c) => c.property),
      ...DENUNCIA_CONTENT_COLUMNS.map((c) => c.property),
    ].sort();
    expect([...contentKeys].sort()).toEqual(expected);
  });

  it("the reporter-identity shape is exactly the key plus reporter_identity", () => {
    const expected = [...joinKeys, ...REPORTER_IDENTITY_COLUMNS.map((c) => c.property)].sort();
    expect([...identityKeys].sort()).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// 4. Non-vacuity — each shape carries its own side
// ---------------------------------------------------------------------------

describe("governance select shapes — non-vacuity", () => {
  it("the content shape carries the free text and the descripción del denunciado", () => {
    const keys = Object.keys(DENUNCIA_CONTENT_SELECT);
    for (const field of ["description", "subjectDescription", "locationAddress", "status"]) {
      expect(keys).toContain(field);
    }
  });

  it("the reporter-identity shape carries the contact channel and the clock", () => {
    const keys = Object.keys(DENUNCIA_REPORTER_IDENTITY_SELECT);
    for (const field of ["reporterContactEmail", "reporterContactPhone", "createdAt"]) {
      expect(keys).toContain(field);
    }
  });

  it("the aggregate dimensions are a real subset of case_record", () => {
    const caseRecord = CASE_RECORD_COLUMNS.map((c) => c.property);
    expect(CASE_RECORD_AGGREGATE_DIMENSIONS.length).toBeGreaterThan(0);
    for (const dimension of CASE_RECORD_AGGREGATE_DIMENSIONS) {
      expect(
        caseRecord,
        `Aggregate dimension "${dimension}" is not a case_record column.`,
      ).toContain(dimension);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Purge plans — the seams the retention clocks will act on
// ---------------------------------------------------------------------------

describe("purge plans", () => {
  it("the content plan covers exactly denuncia_content", () => {
    expect(CONTENT_PURGE_PLAN.map((a) => a.property).sort()).toEqual(
      DENUNCIA_CONTENT_COLUMNS.map((c) => c.property).sort(),
    );
  });

  it("the reporter-identity plan covers exactly reporter_identity", () => {
    expect(REPORTER_IDENTITY_PURGE_PLAN.map((a) => a.property).sort()).toEqual(
      REPORTER_IDENTITY_COLUMNS.map((c) => c.property).sort(),
    );
  });

  it("uses a sentinel for NOT NULL columns and null for the rest", () => {
    const wrong: string[] = [];
    for (const action of [...CONTENT_PURGE_PLAN, ...REPORTER_IDENTITY_PURGE_PLAN]) {
      const col = tableColumns[action.property as keyof typeof tableColumns];
      const required = col?.notNull === true;
      if (required && action.action !== "sentinel") {
        wrong.push(`${action.property} is NOT NULL but the plan nulls it (constraint violation)`);
      }
      if (!required && action.action !== "null") {
        wrong.push(`${action.property} is nullable but the plan writes a sentinel`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("purges location_lat and location_lng together", () => {
    // welfare_reports_location_pair_check: (lat IS NULL) = (lng IS NULL).
    const purged = CONTENT_PURGE_PLAN.map((a) => a.property);
    expect(purged).toContain("locationLat");
    expect(purged).toContain("locationLng");
  });

  it("never purges a case_record column", () => {
    const caseRecord = new Set(CASE_RECORD_COLUMNS.map((c) => c.property));
    const violations = [...CONTENT_PURGE_PLAN, ...REPORTER_IDENTITY_PURGE_PLAN]
      .map((a) => a.property)
      .filter((p) => caseRecord.has(p));
    expect(
      violations,
      "The acuse must survive the purge — that is what makes purging the content defensible.",
    ).toEqual([]);
  });
});

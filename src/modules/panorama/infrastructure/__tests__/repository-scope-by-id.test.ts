// Panorama's table scopes offer the row's catalogue id (localidades-por-id
// verify S2).
//
// jurisdictionColumnsScope reaches jurisdictionPairClause through variable
// columns, so the source fence (scope-clause-offers-locality-id) cannot see
// whether it passes the id. This pins it on the rendered SQL: a unit grant on
// the id path matches welfare reports, cases and organizations by
// locality_id, never by the name pair a homonym shares; a legacy grant keeps
// the name pair. The bite scope has no single id column and keeps the pair.

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import {
  type JurisdictionColumnsTable,
  biteIncidentScope,
  jurisdictionColumnsScope,
} from "../repository-scope";

const GOVT: DashboardActor = { role: "govt" };
const BRAGADO_MECHITA = "0b7c1d4e-0000-4000-8000-000000000001";
const UNIT_GRANT: DashboardJurisdiction = {
  province: "Buenos Aires",
  locality: "Mechita",
  place: { path: "locality", provinceCode: "AR-B", localityIds: [BRAGADO_MECHITA] },
};
const LEGACY_GRANT: DashboardJurisdiction = { province: "Buenos Aires", locality: "Mechita" };

const dialect = new PgDialect();
function render(clause: ReturnType<typeof jurisdictionColumnsScope>) {
  if (!clause) throw new Error("expected a clause");
  return dialect.sqlToQuery(clause);
}

const TABLE_NAME: Record<JurisdictionColumnsTable, string> = {
  welfareReports: "welfare_reports",
  cases: "cases",
  organizations: "organizations",
};

describe("panorama table scopes on the id path", () => {
  for (const table of Object.keys(TABLE_NAME) as JurisdictionColumnsTable[]) {
    it(`${table}: a unit grant matches by locality_id, not by the name pair`, () => {
      const q = render(jurisdictionColumnsScope(GOVT, [UNIT_GRANT], table));
      expect(q.sql).toContain(`"${TABLE_NAME[table]}"."locality_id" in (`);
      expect(q.params).toContain(BRAGADO_MECHITA);
      expect(q.params).not.toContain("Mechita");
    });

    it(`${table}: a legacy grant keeps the name pair`, () => {
      const q = render(jurisdictionColumnsScope(GOVT, [LEGACY_GRANT], table));
      expect(q.sql).not.toContain("locality_id");
      expect(q.params).toContain("Mechita");
    });
  }

  it("the bite scope has no id column and keeps the name pair", () => {
    const q = render(biteIncidentScope(GOVT, [UNIT_GRANT]));
    expect(q.params).toContain("Mechita");
    expect(q.params).not.toContain(BRAGADO_MECHITA);
  });
});

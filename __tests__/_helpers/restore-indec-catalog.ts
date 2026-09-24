// Shared catalog restore for tests that exercise the INDEC import fixture
// against the LIVE local DB (import-indec-localities.test.ts,
// ar-localidades.test.ts).
//
// WHY THIS EXISTS: the import fixture's soft-delete pass stamps every real
// catalog row that isn't in the fixture CSV as removed, so those tests restore
// the catalog afterwards. But a blanket restore (removed_at = null for ALL
// indec_cppdyl rows) also RESURRECTS whole-province aggregate rows the current
// importer intentionally drops on ingest — e.g. CABA's whole-city row — which
// then fails the `lint:locality` integrity gate on the next `pnpm verify`
// (recurring zombie, 2026-07-11: the row came back after every full suite run).
//
// Fix: restore, then re-soft-delete exactly the rows the integrity guard's own
// detectors flag. Reusing them keeps this helper and
// scripts/check-locality-integrity.ts structurally in sync — if the guard's
// definition of "violation" evolves, this restore follows it.
//
// 2026-08-21 — the second detector had to be wired in here too, and the reason
// generalises the note above. A blanket restore resurrects EVERY soft-deleted
// indec_cppdyl row, including the 15 CABA comunas INDEC started shipping on
// 2026-08-19. The importer's fix soft-deletes them; without the matching re-drop
// below, one full test run would put them back and caba-barrios.test.ts would
// fail on the next run for a reason that has nothing to do with the code under
// test. A restore helper that only knows about the OLD violation shape is how a
// fix gets quietly undone by the test suite that proves it.

import { sql } from "drizzle-orm";

import { arLocalities, db } from "@/db";
import {
  type LocalityRow,
  findAggregateViolations,
  findSupersededViolations,
} from "@/scripts/check-locality-integrity";

export async function restoreIndecCatalog(): Promise<void> {
  // Un-soft-delete real catalog rows the import fixture may have stamped.
  await db
    .update(arLocalities)
    .set({ removedAt: null })
    .where(
      sql`${arLocalities.source} = 'indec_cppdyl' AND ${arLocalities.removedAt} IS NOT NULL AND ${arLocalities.indecId} IS NOT NULL`,
    );

  // Re-drop every row the guard would flag. The slice mirrors the guard's own
  // query: department-less rows (whole-province aggregates can only be those)
  // PLUS every row of a superseded source, at any granularity — the comunas all
  // carry a departamento_id, so a department-less-only slice would miss them
  // exactly the way the guard used to.
  const candidates = (await db.execute(sql`
    select province_code, locality_name, locality_slug, department_code, source
    from ar_localities
    where removed_at is null
  `)) as unknown as LocalityRow[];

  const violations = [
    ...findAggregateViolations(candidates),
    ...findSupersededViolations(candidates),
  ];

  for (const violation of violations) {
    await db
      .update(arLocalities)
      .set({ removedAt: new Date() })
      .where(
        sql`${arLocalities.localitySlug} = ${violation.locality_slug} AND ${arLocalities.provinceCode} = ${violation.province_code} AND ${arLocalities.source} = ${violation.source} AND ${arLocalities.removedAt} IS NULL`,
      );
  }
}

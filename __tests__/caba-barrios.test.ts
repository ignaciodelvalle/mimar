// Smoke tests for the CABA barrios import (plan
// 2026-05-19-caba-barrios-import-execution). The script
// `scripts/import-caba-barrios.ts` is idempotent — these tests just
// assert the catalog is populated and queryable.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { arLocalities, db } from "@/db";
import { searchLocalities } from "@/lib/infra/ar-localidades";

// THE beforeAll THAT USED TO LIVE HERE IS GONE, AND ITS REMOVAL IS THE FIX.
//
// It hard-deleted two INDEC ids — "02014010" and "02002010" — as "stale fixture
// rows left by import-indec-localities.test.ts". That was true when written:
// the sample fixture invented a row labelled "Palermo" under id 02014010. On
// 2026-08-19 INDEC replaced CABA's single city-wide row with 15 per-Comuna rows
// and 02014010 became a LIVE row, "CABA - Comuna 2". So on every CI bootstrap
// this guard silently deleted one real row, and the assertion below counted 14
// where the catalog held 15 — a wrong number reported for a defect that was
// real, which is the worst kind of test failure to debug.
//
// Two things replace it, both structural:
//   • The importer no longer creates ANY indec_cppdyl row for AR-C — the rule
//     is stated by source-and-province, not by row shape
//     (lib/reference/locality-integrity.ts, isSupersededByAltSource). The
//     fixture cannot pollute this catalog because nothing can.
//   • import-indec-localities.test.ts cleans up the rows it created, in its own
//     beforeEach and afterAll. A test that deletes rows it did not create is
//     reaching across an ownership boundary, and hard-coded ids are how that
//     reach silently starts hitting production data.
//
// So the count below is now a real measurement. If it fails, the catalog is
// genuinely wrong — remediate with `pnpm tsx scripts/import-indec-localities.ts`
// (it self-heals) and read `pnpm lint:locality` for the diagnosis.
//
// Still deliberately NOT restored: the CABA whole-city catch-all
// ("Ciudad Autónoma de Buenos Aires", indec_id 02000010). A blanket restore was
// the source of the recurring "CABA locality zombie" — it resurrected the exact
// aggregate the whole system is built to drop, re-failing lint:locality after
// every full-suite run (2026-07-11).

describe("CABA barrios — Ley 1.777 import", () => {
  it("has exactly 48 active barrios in ar_localities", async () => {
    const [row] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(arLocalities)
      .where(
        and(
          eq(arLocalities.provinceCode, "AR-C"),
          eq(arLocalities.source, "caba_open_data"),
          isNull(arLocalities.removedAt),
        ),
      );
    expect(row.c).toBe(48);
  });

  it("ships a non-NULL centroid (latitude+longitude) for every barrio", async () => {
    // Panorama centroid-snapping (repository.ts) drops any barrio row without
    // coordinates, so every imported barrio MUST carry its frozen centroid.
    const [row] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(arLocalities)
      .where(
        and(
          eq(arLocalities.provinceCode, "AR-C"),
          eq(arLocalities.source, "caba_open_data"),
          isNull(arLocalities.removedAt),
          sql`${arLocalities.latitude} IS NOT NULL AND ${arLocalities.longitude} IS NOT NULL`,
        ),
      );
    expect(row.c).toBe(48);
  });

  it("holds NO active INDEC row for AR-C, at any granularity", async () => {
    // CABA is represented by its 48 caba_open_data barrios (Ley 1.777), so
    // whatever INDEC ships for AR-C tiles the same city a second time and
    // double-counts every rollup over it.
    //
    // THE COUNT IS ZERO REGARDLESS OF SHAPE, and that wording is the fix. This
    // assertion is unchanged since the city-wide catch-all (indec_id 02000010)
    // was the only offender; on 2026-08-19 INDEC swapped it for 15 per-Comuna
    // rows and this was the ONLY check in the repo that noticed — the importer's
    // drop rule and `lint:locality` were both written against the old row's
    // SHAPE (department-less, name equals province) and saw nothing. Both now
    // state the rule the way this test always did.
    //
    // If this fails: `pnpm tsx scripts/import-indec-localities.ts` self-heals
    // (it soft-deletes leftovers), and `pnpm lint:locality` names the rows.
    const [row] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(arLocalities)
      .where(
        and(
          eq(arLocalities.provinceCode, "AR-C"),
          eq(arLocalities.source, "indec_cppdyl"),
          isNull(arLocalities.removedAt),
        ),
      );
    expect(row.c).toBe(0);
  });

  it("includes Palermo, Boedo, and La Boca with accents preserved", async () => {
    const rows = await db
      .select({ name: arLocalities.localityName })
      .from(arLocalities)
      .where(
        and(
          eq(arLocalities.provinceCode, "AR-C"),
          inArray(arLocalities.localityName, ["Palermo", "Boedo", "La Boca", "Núñez"]),
          isNull(arLocalities.removedAt),
        ),
      );
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(["Boedo", "La Boca", "Núñez", "Palermo"]);
  });
});

describe("CABA barrios — typeahead ranking", () => {
  it("'Pal' returns Palermo as the top result when scoped to CABA", async () => {
    const results = await searchLocalities({ provinceCode: "AR-C", query: "Pal" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].localityName).toBe("Palermo");
  });

  it("'Boed' returns Boedo first", async () => {
    const results = await searchLocalities({ provinceCode: "AR-C", query: "Boed" });
    expect(results[0].localityName).toBe("Boedo");
  });

  it("'Núñ' (accented) returns Núñez first", async () => {
    const results = await searchLocalities({ provinceCode: "AR-C", query: "Núñ" });
    expect(results[0].localityName).toBe("Núñez");
  });
});

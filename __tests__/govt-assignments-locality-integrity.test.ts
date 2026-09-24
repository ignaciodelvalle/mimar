// govt_assignments locality integrity fitness test (issue #758).
// ================================================================
//
// STRUCTURAL GUARANTEE: every ACTIVE (revoked_at IS NULL) govt_assignments
// row MUST hold a jurisdiction_locality that resolves against the
// ar_localities catalog, scoped to the row's jurisdiction_province.
//
// WHY THIS MATTERS: lib/metrics/scope.ts (jurisdictionPairClause) matches a
// govt user's data scope by EXACT string equality against
// pets.jurisdiction_province / pets.jurisdiction_locality. If a
// govt_assignments row holds a locality that isn't a real catalog entry
// (e.g. a typo, or a province name mistakenly stored as a locality — the
// production case that motivated this test was jurisdiction_locality =
// "CABA", which is never a locality_name, only a province), the assignment
// silently matches ZERO pets. No error, no empty-state message — the govt
// user just sees an empty dashboard for a jurisdiction they were supposedly
// granted. This test is the tripwire that turns that silent gap into a red
// CI run instead of a support ticket.
//
// The two real app write paths (assignGovtLocalityForAuthority,
// createInstitutionalAccountForAuthority) already canonicalize through
// resolveCanonicalJurisdiction before insert, so they cannot produce a
// failing row. This test guards against future write paths (scripts, manual
// SQL, QA workarounds) reintroducing the bug.
//
// EXCEPTION — whole-province assignments (C5, 2026-07-22): a row whose
// (province, locality) is the WHOLE_PROVINCE_LOCALITY sentinel
// (lib/domain/jurisdiction-canonical.ts — today, CABA's "Ciudad Autónoma de
// Buenos Aires") is validated by a DIFFERENT, closed mechanism —
// isWholeProvinceLocality membership IS the integrity check — and is
// deliberately NOT an ar_localities catalog row: the INDEC importer drops
// that exact whole-city placeholder on ingest (check-locality-integrity.ts),
// so `localityByName` correctly returns null for it. Resolving it against
// the catalog would be testing the wrong thing; skip those rows here.
//
// HOW TO SATISFY A FAILURE:
//   - If a NEW row fails: find the write path that inserted it (grep for
//     `.insert(govtAssignments)` outside the two writers above) and route it
//     through resolveCanonicalJurisdiction / normalizeLocationForWrite
//     instead of writing raw text.
//   - If an EXISTING row fails after a catalog update (e.g. INDEC renamed or
//     removed a locality): either correct jurisdiction_locality to the new
//     canonical spelling, or revoke the row (see
//     db/migrations/0117_govt_assignments_locality_canonical.sql for the
//     precedent — auto-revoke rather than guess).

import { isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db, govtAssignments } from "@/db";
import { isWholeProvinceLocality } from "@/lib/domain/jurisdiction-canonical";
import { localityByName } from "@/lib/infra/ar-localidades";
import { type ProvinceCode, provinceByName } from "@/lib/reference/ar-provincias";

describe("govt_assignments locality integrity (issue #758)", () => {
  it("every ACTIVE assignment's jurisdiction_locality resolves against ar_localities (or is the whole-province sentinel)", async () => {
    const activeAssignments = await db
      .select({
        id: govtAssignments.id,
        province: govtAssignments.jurisdictionProvince,
        locality: govtAssignments.jurisdictionLocality,
      })
      .from(govtAssignments)
      .where(isNull(govtAssignments.revokedAt));

    const unresolved: string[] = [];
    for (const row of activeAssignments) {
      if (isWholeProvinceLocality(row.province, row.locality)) continue;

      const province = provinceByName(row.province);
      if (!province) {
        unresolved.push(`${row.id} (province '${row.province}' not in ar-provincias catalog)`);
        continue;
      }
      const locality = await localityByName(province.code as ProvinceCode, row.locality);
      if (!locality) {
        unresolved.push(`${row.id} (${row.province} / ${row.locality})`);
      }
    }

    const message = `ACTIVE govt_assignments row(s) whose jurisdiction_locality does not resolve against ar_localities — these silently produce an EMPTY scope in jurisdictionPairClause (lib/metrics/scope.ts), per issue #758. Fix the write path or correct/revoke the row:\n${unresolved.join("\n")}`;
    expect(unresolved, message).toEqual([]);
  });
});

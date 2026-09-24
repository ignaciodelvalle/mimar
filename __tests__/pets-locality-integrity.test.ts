// pets locality integrity fitness test (finding A10-4).
// =====================================================
//
// STRUCTURAL GUARANTEE: every ACTIVE pet (status 'active' or 'lost', not
// soft-deleted) whose jurisdiction_province and jurisdiction_locality are both
// set holds the catalog's OWN spelling of a live ar_localities row in that
// province.
//
// WHY THIS MATTERS: jurisdictionPairClause (lib/metrics/scope.ts), the census,
// the compliance rollups and resolveBusinessRule all match a pet by EXACT
// string equality on (province, locality). A pet stored as "palermo" instead
// of "Palermo" resolves in a lookup and still silently drops out of the
// municipality that governs it — no error, just a pet nobody counts. The
// sibling sweep (__tests__/govt-assignments-locality-integrity.test.ts) only
// ever read govt_assignments, so this failure mode had no tripwire for pets.
//
// Hence the check is stricter than "localityByName finds something": the
// stored text must EQUAL the locality_name of a live catalog row in the
// province — the same equality every scoped read joins on. The catalog is
// loaded once and checked in memory (~4k distinct pairs locally; one lookup
// per pair would be ~8k round trips).
//
// HOW TO SATISFY A FAILURE:
//   - A NEW row: find the write path that stored raw text and route it through
//     normalizeLocationForWrite({ locality: "strict" }).
//   - An EXISTING row after a catalog update: the 0237 repair
//     (db/migrations/0237_pets_locality_canonical.sql) fixes a spelling only
//     when the catalog offers ONE name; a forward migration of the same shape
//     is the tool. A row that cannot be resolved without guessing goes in
//     ALLOWLIST below, with the reason — never a guessed locality.

import { and, inArray, isNotNull, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { arLocalities, db, pets } from "@/db";
import { provinceByName } from "@/lib/reference/ar-provincias";

/**
 * Pairs known not to resolve, each with the reason it is tolerated. Empty on
 * purpose: the local inventory on 2026-09-22 had 0 non-resolving active pets
 * (28 921 checked), and 0237 repairs every row that has a single catalog
 * spelling. An entry that no longer occurs fails the stale-entry check below.
 */
const ALLOWLIST: ReadonlyArray<{ province: string; locality: string; reason: string }> = [];

const pairKey = (province: string, locality: string) => `${province} / ${locality}`;

async function activePetPairs(): Promise<Array<{ province: string; locality: string }>> {
  const rows = await db
    .selectDistinct({
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
    })
    .from(pets)
    .where(
      and(
        inArray(pets.status, ["active", "lost"]),
        isNull(pets.deletedAt),
        isNotNull(pets.jurisdictionProvince),
        isNotNull(pets.jurisdictionLocality),
      ),
    );
  return rows.map((r) => ({ province: r.province as string, locality: r.locality as string }));
}

/** Live catalog as a set of `provinceCode|localityName`. */
async function liveCatalog(): Promise<Set<string>> {
  const rows = await db
    .select({ code: arLocalities.provinceCode, name: arLocalities.localityName })
    .from(arLocalities)
    .where(isNull(arLocalities.removedAt));
  return new Set(rows.map((r) => `${r.code}|${r.name}`));
}

function resolvesExactly(catalog: Set<string>, province: string, locality: string): boolean {
  const p = provinceByName(province);
  return p !== null && catalog.has(`${p.code}|${locality}`);
}

describe("pets locality integrity (A10-4)", () => {
  it("every active pet's (province, locality) is the catalog's own spelling of an ar_localities row", async () => {
    const [pairs, catalog] = await Promise.all([activePetPairs(), liveCatalog()]);
    expect(
      catalog.size,
      "ar_localities is empty — the sweep would flag everything",
    ).toBeGreaterThan(0);
    expect(
      pairs.length,
      "no active pet with a jurisdiction — the sweep checked nothing",
    ).toBeGreaterThan(0);

    const allowed = new Set(ALLOWLIST.map((a) => pairKey(a.province, a.locality)));
    const unresolved: string[] = [];
    for (const { province, locality } of pairs) {
      if (allowed.has(pairKey(province, locality))) continue;
      if (!resolvesExactly(catalog, province, locality))
        unresolved.push(pairKey(province, locality));
    }

    const message = `Active pets whose (province, locality) is not the catalog's spelling of an ar_localities row — they drop out of every locality-scoped count (jurisdictionPairClause matches with =). Fix the write path, repair with a forward migration like 0237, or allowlist with a reason:\n${unresolved.join("\n")}`;
    expect(unresolved, message).toEqual([]);
  });

  it("every ALLOWLIST entry still occurs and still does not resolve (no stale exemptions)", async () => {
    const [pairs, catalog] = await Promise.all([activePetPairs(), liveCatalog()]);
    const present = new Set(pairs.map((p) => pairKey(p.province, p.locality)));
    const stale: string[] = [];
    for (const entry of ALLOWLIST) {
      const key = pairKey(entry.province, entry.locality);
      if (!present.has(key) || resolvesExactly(catalog, entry.province, entry.locality)) {
        stale.push(key);
      }
    }
    expect(
      stale,
      `ALLOWLIST entries that no longer need an exemption:\n${stale.join("\n")}`,
    ).toEqual([]);
  });
});

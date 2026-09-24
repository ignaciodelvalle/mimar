// Province-tier k-anonymity for the PUBLIC open-data datasets (Epic B, item 1).
//
// WHY THIS MODULE EXISTS — header corrected 2026-07-31 (RA-5).
// -------------------------------------------------------------------------
// This comment used to open by asserting that "the authenticated Panorama
// province choropleth publishes province aggregates UNSUPPRESSED (repository.ts
// § U5: 'Province returns filled-polygon cells (no k-anon)')", and derived the
// module's whole reason for being from that asymmetry. **It has been false
// since task #40.** `provinceCell` (src/modules/panorama/application/
// build-features.ts) runs every province cell's DENOMINATOR through
// suppressSmallCells at PROVINCE_K === ANONYMITY_K === 5, and
// `ProvinceChoroplethRows.suppressedCount` is a REQUIRED field precisely
// because province cells can come back suppressed. The premise behind the old
// wording — "province cells are large" — is the retired one that justified a
// live privacy leak across 13 files for months. It must not be re-cited here.
//
// The authenticated province CHOROPLETH and this module differ in STRENGTH, not
// in presence:
//   · The choropleth's province rule is per-cell k-anon on the denominator
//     (`provinceCell`) and stops there — the province loaders in
//     repository-choropleth.ts run no complementary suppression.
//     `toChoroplethCells` in that same file does, but that is the DEPARTMENT
//     tier, grouped by province. (Do NOT generalise this to "the map never
//     complements at province grain": repository-by-unit.ts, the aggregated
//     point-cell family, DOES — `group: kanon.grain === "province" ? "national"
//     : r.province`. The gap is specific to the province choropleth.)
//   · This module adds COMPLEMENTARY (differencing) suppression across the
//     NATION on top of the same k=5. A public download is the one surface where
//     an attacker sits with the whole table and the national total and can
//     subtract. `loadMortalityRawRollupByProvince` exists solely to feed this
//     pipeline RAW counts for that reason: hand it the already-suppressed map
//     cells and complementarySuppress sees zero suppressed rows, promotes no
//     complement, and the differencing defence silently stops firing.
//
// Ley 27.275 active transparency still requires the same province aggregates be
// re-published OPEN to anonymous users. That re-publication is what this module
// protects — protected MORE than the map, not instead of it.
//
// Third member of the family, named so it is findable: lib/metrics/
// province-disclosure.ts carries the D.10 rule for AUTHENTICATED censo /
// control-poblacional (own jurisdiction real, foreign cells suppressed). Its
// SUPPRESSED_CELL_TEXT is word-identical to SUPPRESSED_MARKER below, and
// province-disclosure.test.ts pins the two strings together.
//
// It routes the province tier through the SAME primitives the locality tier uses
// (lib/metrics/anonymity.ts): the k=5 small-cell rule and complementary
// (secondary) suppression against a differencing attack. The ONLY differences
// from the locality path are (a) the differencing group is the NATION (a single
// group across all provinces) rather than the province, because the coarser
// published aggregate above a province row is the national total; and (b) rate
// datasets protect the numerator and its complement in addition to the
// population base (see isRateCellProtected).
//
// Pure and DB-free by design so the privacy rule is unit-testable without a DB.
// A suppressed cell NEVER carries a numeric value, a numerator, or a
// denominator — but that invariant is ENFORCED one layer up, in
// lib/open-data/datasets.ts (`baseSuppressed = suppressed || …`, so a row can
// never publish its base while hiding its own pct). This module only TAGS rows;
// the dataset layer decides what is emitted.

import { ANONYMITY_K, complementarySuppress, suppressSmallCells } from "@/lib/metrics/anonymity";

/**
 * k-anonymity threshold for the open-data tier — AGENTS.md "Aggregation &
 * privacy policy".
 *
 * DERIVED, NOT SEVERABLE (decided 2026-08-17). This was a second literal `5`
 * three directories from ANONYMITY_K, and the question worth asking was whether
 * it was a deliberate seam — a public download might reasonably warrant a
 * HIGHER floor than an authenticated dashboard. It was not. Three pieces of
 * evidence, all pointing the same way:
 *
 *   1. Its own doc cited the SAME clause of AGENTS.md as ANONYMITY_K. One
 *      policy, written down twice.
 *   2. `app/(public)/transparencia/__tests__/privacy-disclosure-parity.test.ts`
 *      already asserted `OPEN_DATA_K === ANONYMITY_K`. Severability was ALREADY
 *      forbidden by a test — the literal bought no freedom, only the standing
 *      possibility of a red suite.
 *   3. What actually makes this tier stronger than the map is the NATIONAL
 *      complementary pass below, not a bigger k. The strength is in the
 *      differencing defence, and that is orthogonal to the floor.
 *
 * If the open-data tier ever DOES need a stricter floor, express it as
 * `ANONYMITY_K + n` (or a named constant that says why) and update the parity
 * test to assert `>=` instead of source-derivation. What must never come back
 * is a bare literal: two unlinked numbers claiming to be one policy.
 */
export const OPEN_DATA_K = ANONYMITY_K;

/** The exact string a suppressed numeric cell renders/exports as. Never 0 — a
 *  suppressed value is WITHHELD, not zero (a false zero would itself leak that
 *  the true count is sub-k, and read as real data).
 *
 *  Word-for-word identical to `SUPPRESSED_CELL_TEXT` in
 *  lib/metrics/province-disclosure.ts so an operator reads the SAME sentence in
 *  a /gob CSV and in a public download; province-disclosure.test.ts asserts the
 *  two are equal, so neither can be reworded alone. */
export const SUPPRESSED_MARKER = "suprimido por privacidad";

/** The complementary-suppression group for the province tier: the whole country.
 *  The published aggregate one level coarser than a province row is the national
 *  total, so a lone suppressed province is recoverable by subtracting the visible
 *  provinces from that national total — the group across which a single hidden
 *  cell must not be isolable is therefore national. */
const NATIONAL_GROUP = "AR";

/** A raw DENSITY province row (a count metric, e.g. mortality): `count` is the
 *  number of individuals in the cell — the quantity k protects directly. */
export type DensityRow = {
  provinceCode: string;
  provinceName: string;
  count: number;
};

/** A raw RATE province row (a proportion metric, e.g. rabies coverage):
 *  `numerator` / `denominator` are the underlying counts; `ratePct` the derived
 *  percentage (0-100). BOTH counts are needed to decide suppression honestly —
 *  a rate published with its base leaks the numerator by multiplication. */
export type RateRow = {
  provinceCode: string;
  provinceName: string;
  numerator: number;
  denominator: number;
  ratePct: number;
};

/** A row tagged with its suppression decision. The row object is unchanged; the
 *  dataset layer decides what to emit (values, or SUPPRESSED_MARKER) from the
 *  flag. Input order is preserved. */
export type TaggedRow<Row> = { row: Row; suppressed: boolean };

/** A strictly-positive count below k is a PROTECTED small group. Exactly 0 is
 *  NOT protected: an empty group re-identifies no one (same "zero nuance" as
 *  suppressDelta in lib/metrics/anonymity.ts). */
function isProtectedCount(n: number): boolean {
  return n > 0 && n < OPEN_DATA_K;
}

/**
 * Whether a RATE cell must be suppressed. Three ways a rate + base can expose a
 * small group, any of which protects the cell:
 *  1. `denominator < k` — the population base itself is a sub-k group. This IS
 *     the k-anon small-cell rule (suppressSmallCells) applied to the base.
 *  2. `numerator` is a protected small positive — e.g. "2 of 9 000 dogs
 *     vaccinated" isolates those 2 owners.
 *  3. `denominator - numerator` (the complement) is a protected small positive —
 *     e.g. "8 998 of 9 000 vaccinated" isolates the 2 who are NOT.
 * Pure; exported for direct unit testing.
 */
export function isRateCellProtected(numerator: number, denominator: number): boolean {
  if (denominator < OPEN_DATA_K) return true;
  return isProtectedCount(numerator) || isProtectedCount(denominator - numerator);
}

/** Tag original rows by identity against the final suppressed partition,
 *  preserving input order. suppressSmallCells / complementarySuppress both keep
 *  the original row object references, so Set identity membership is exact. */
function tagByIdentity<Row>(
  original: readonly Row[],
  suppressed: readonly Row[],
): TaggedRow<Row>[] {
  const suppressedSet = new Set<Row>(suppressed);
  return original.map((row) => ({ row, suppressed: suppressedSet.has(row) }));
}

/**
 * Suppress a DENSITY province dataset (count metric). Mirrors toChoroplethCells
 * exactly — suppressSmallCells(k=5) then complementarySuppress — but grouped
 * nationally (see NATIONAL_GROUP). A province with a sub-k count is suppressed;
 * if that leaves exactly one suppressed cell nationally, the next-smallest
 * visible province is also suppressed so the lone hidden count cannot be
 * recovered from the national total.
 */
export function suppressDensityProvinces(rows: readonly DensityRow[]): TaggedRow<DensityRow>[] {
  const primary = suppressSmallCells([...rows], {
    count: (r) => r.count,
    key: (r) => r.provinceCode,
  });
  const { suppressed } = complementarySuppress(
    primary.visible as unknown as readonly DensityRow[],
    primary.suppressed,
    { group: () => NATIONAL_GROUP, count: (r) => r.count },
  );
  return tagByIdentity(rows, suppressed);
}

/**
 * Suppress a RATE province dataset (proportion metric). Primary suppression uses
 * isRateCellProtected (population base + numerator + complement); complementary
 * suppression then defends the NUMERATOR against differencing across the
 * national numerator total (count = numerator — the quantity a published
 * national total would let an attacker subtract toward). A province whose base,
 * numerator, or complement is sub-k is suppressed; a lone national suppression
 * pulls in the next-smallest-numerator visible province.
 */
export function suppressRateProvinces(rows: readonly RateRow[]): TaggedRow<RateRow>[] {
  const primaryVisible: RateRow[] = [];
  const primarySuppressed: RateRow[] = [];
  for (const r of rows) {
    if (isRateCellProtected(r.numerator, r.denominator)) primarySuppressed.push(r);
    else primaryVisible.push(r);
  }
  const { suppressed } = complementarySuppress(primaryVisible, primarySuppressed, {
    group: () => NATIONAL_GROUP,
    count: (r) => r.numerator,
  });
  return tagByIdentity(rows, suppressed);
}

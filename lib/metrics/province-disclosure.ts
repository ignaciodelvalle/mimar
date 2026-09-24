// lib/metrics/province-disclosure.ts — the D.10 disclosure rule for per-province
// aggregates published to an AUTHENTICATED operator (censo + control poblacional).
//
// THE RULING (PO, 2026-07-31, plan nocturno 2026-08-01 § "Decisiones del PO" D.10):
//
//   "El funcionario ve SU propia jurisdicción con el número real; se suprime lo
//    ajeno. El export coincide EXACTAMENTE con la pantalla."
//
// Rationale, preserved because it is the reason the rule is shaped this way and
// not the usual blanket k-anon: looking at your OWN municipality's census is not
// a disclosure. Those animals are your administrados — they are already in your
// padrón, by name, with their owners. Suppression exists to stop an operator
// INFERRING about OTHER jurisdictions, so it applies to foreign cells only. And
// an export that differs from the screen becomes the documented way to bypass
// the protection, so the decision is made HERE, once, inside the fetcher — the
// screen and the CSV consume the same already-decided rows and cannot diverge.
//
// WHY THIS EXISTS AT ALL (#40b triage): the retired premise was "no k-anon at
// province level, province cells are large". True of a province's POPULATION,
// false of a province's DENOMINATOR — and a per-unit RATE reveals its
// denominator while a per-province COUNT *is* the denominator. Both families
// route through here now.
//
// Pure and DB-free: the context is only read for its SCOPE, which is why the
// parameter is `ScopedForDisclosure` (`Pick<ProjectionContext, "scope">`) and not
// the whole context. Every existing caller passes a full ProjectionContext and is
// unchanged (structural typing); what the narrower type buys is that
// `fetchRegionRanking` — which holds an (actor, jurisdictions) pair and no period
// — can consult the SAME rule instead of inventing a period the rule never reads
// or re-deriving "is this province mine?" locally. Unit-testable without Postgres.

import { ANONYMITY_K, suppressSmallCells } from "./anonymity";
import type { ScopedForDisclosure } from "./context";
import { isOwnJurisdictionProvince } from "./scope";

/**
 * The exact text a withheld numeric cell exports as. Never a number, never "0"
 * — a withheld value is ABSENT, not zero (a false zero reads as real data AND
 * asserts something untrue).
 *
 * Deliberately the same wording as `SUPPRESSED_MARKER` in
 * lib/open-data/province-suppression.ts so an operator reads the SAME words in a
 * /gob CSV and in a public open-data download. `province-disclosure.test.ts`
 * pins the two strings together.
 */
export const SUPPRESSED_CELL_TEXT = "suprimido por privacidad";

/**
 * The minimum a row must carry for the rule to decide: which province it is, and
 * the DENOMINATOR the protected group is counted in.
 *
 * THE DENOMINATOR IS REQUIRED ON PURPOSE — the same contract, and the same
 * reason, as `provinceCell`'s obligatory 4th parameter (build-features.ts): every
 * caller has one (censo → the count itself, which IS the population; coverage →
 * `total`, the active-pet base), and making it required means the COMPILER, not a
 * reviewer, enumerates the sites where the question must be answered.
 */
export type ProvinceDenominatorRow = { province: string; denominator: number };

/** The decision for one province grouping, ready to apply to any row shape. */
export type ProvinceDisclosurePlan = {
  /** Provinces whose values must be WITHHELD (published as null, never 0). */
  withheld: ReadonlySet<string>;
  /**
   * How many provinces were withheld. Every surface that renders these rows
   * MUST say this number out loud. #40's own follow-up shipped a fully hatched
   * map with `suppressedCount: 0`: it hid the data and told nobody, which is
   * strictly worse than publishing it, because the operator reads absence as
   * "no pasa nada acá".
   */
  suppressedCount: number;
  /**
   * Σ denominator over ALL rows, withheld ones included — the honest input for a
   * "N sin provincia asignada" footnote, which must NOT be recomputed from the
   * visible rows alone (that would overstate the residual AND turn the footnote
   * into the subtraction channel).
   *
   * `null` when publishing it would let the withheld cells be recovered by
   * subtraction. THE RULE IS Σ(withheld) ≥ k, NOT "two or more cells hidden":
   * with `[TdF 1, SC 1, BA 998]` and a published Σ of 1000, `1000 − 998 = 2`
   * spread over two cells that are each ≥ 1 pins BOTH at exactly 1 — two hidden
   * cells, zero protection. What k protects is the MASS behind the residual, so
   * that is what the test has to be. Callers must render nothing when this is
   * null.
   *
   * WHAT Σ ≥ k STILL DOES NOT GUARANTEE — stated because this whole wave is
   * about docblocks that promised more than the code delivered: a mass ≥ k does
   * NOT prove every hidden cell is un-pinnable. `[4, 4]` sums to 8, clears k,
   * and still pins both cells at 4 (no other split of 8 keeps each ≤ k − 1). The
   * complete instrument is an interval-feasibility (LP) audit over the hidden
   * cells; it is NOT implemented here. Σ ≥ k is the rule this tier ships, and it
   * bounds the residual mass — not the width of each cell's feasible interval.
   */
  publishableRowTotal: number | null;
  /**
   * May the surface publish a SCOPE-WIDE headline aggregate at all — the KPI row
   * ("Total registradas", "cobertura · N de M") and the CSV `resumen` section?
   *
   * A scope total is a legitimate whole-scope aggregate ONLY while the scope
   * genuinely aggregates more than one unit, or the viewer owns it. Narrow the
   * scope to a SINGLE unit and the "total" stops being an aggregate: it IS that
   * unit's cell, arriving under a different label. That is RA-3 finding C1 —
   * `?province=AR-V` narrowed the whole scope (scope.ts `petsScopeClause`), so
   * the table said "suprimido por privacidad" and the KPI beside it published
   * the same 3, in the same page and the same request. A suppression any viewer
   * can turn off with a query param is not a suppression; the drill narrows the
   * rows and changes nothing about the verdict, here as in rule (c) below.
   *
   * `false` ⇒ the surface renders NO scope aggregate — not a zero, not a dash
   * labelled "sin datos" (that would badge a withholding as a coverage gap).
   * Use `scopeTotalSuppressionNotice` for the copy.
   */
  scopeTotalPublishable: boolean;
};

/**
 * Decide, for one province-grouped result set and one viewer, which cells are
 * published and which are withheld.
 *
 * The rule, in order:
 *  1. OWN jurisdiction → always published. `isOwnJurisdictionProvince` (scope.ts)
 *     is the single scope model; this file does not define a second one.
 *  2. FOREIGN + denominator in (0, k) → withheld. k and the `>= k` comparison
 *     both come from `suppressSmallCells` — this function only routes rows
 *     through it, exactly as `provinceCell` does.
 *  3. THE ZERO NUANCE: a denominator of EXACTLY 0 is NOT protected. An empty
 *     group re-identifies nobody, and badging it "protegido por privacidad"
 *     would dress a genuine coverage gap as a deliberate withholding. Same
 *     nuance as `provinceCell`, `suppressDelta` and `isProtectedCount`.
 *  4. THE RESIDUAL: the Σ over the grouping is published only while the withheld
 *     MASS it exposes (`Σ − Σ(visible)`) is itself ≥ k — see
 *     `publishableRowTotal`.
 *  5. THE SCOPE HEADLINE: a single-unit scope has no aggregate to publish, only
 *     a relabelled cell — see `scopeTotalPublishable`.
 *
 * WHY THERE IS NO COMPLEMENTARY PASS HERE, and there used to be (RA-1 finding
 * C1a). `complementarySuppress` promotes the SMALLEST VISIBLE sibling when a
 * group holds exactly one suppressed cell. Grouped nationally, that sibling is a
 * real province: with Tierra del Fuego at 3, /admin/censo hid **La Rioja
 * (1.204)** — and then announced "2 provincias ocultas (menos de 5 mascotas en
 * la jurisdicción)", which is false about a province with 1.204. Nobody decided
 * that. D.10 authorised suppressing lo ajeno that is sub-k; it did not authorise
 * spending a large province's real number to protect a small one.
 *
 * The promotion was inherited from a premise that is retired. Its own jsdoc
 * (anonymity.ts) justified itself with "a coarser aggregate is published
 * UNSUPPRESSED (the Panorama province choropleth totals, spec §U5)" — i.e. the
 * defence existed because the group total was OUT OF REACH. Task #40 retired
 * that, and in THIS tier the group total is not out of reach at all: rule (4)
 * owns `publishableRowTotal` and rule (5) owns the headline. Given the choice
 * between withholding one derived total and blinding a jurisdiction, withhold
 * the total. Every above-k province stays visible, and the disclosure notice
 * goes back to stating the true reason, because every withheld cell really is
 * sub-k.
 *
 * Scope of that removal: THIS tier only. `complementarySuppress` is unchanged
 * and its six other callers (open-data, panorama repositories, subregion
 * redaction, choropleth-data) keep it — several of them genuinely do not
 * control the coarser aggregate they are defending against.
 *
 * ADMIN (scope.kind === "global") — decided on the merits, per the brief:
 * an admin owns NO province at this grain, so every cell is foreign and the
 * ordinary k-anon applies. Three reasons, in descending weight:
 *  (a) The padrón argument D.10 rests on is JURISDICTIONAL — "son sus
 *      administrados, ya están en tu padrón". A national platform admin has no
 *      padrón; the scope model agrees, `petsScopeClause` returns `null` for
 *      them, and "no jurisdiction predicate" is the ABSENCE of a jurisdiction,
 *      not ownership of all 24 (`censusEligibleProvince` reads global-no-drill
 *      as `null` for the same reason).
 *  (b) Repo precedent: task #40 already suppresses the province choropleth for
 *      admins — `provinceCell` decides on the denominator and never asks who is
 *      looking. Publishing "Tierra del Fuego: 3" on /admin/censo while
 *      /gob/panorama hatches that exact cell for that exact viewer would make
 *      the censo the documented bypass for the Panorama's protection: the same
 *      failure D.10 names for screen-vs-export, one surface further out.
 *  (c) An admin PROVINCE DRILL (`ctx.adminProvince`) is a URL parameter, not an
 *      assignment. Treating it as ownership would mean the whole protection is
 *      switched off by appending `?province=AR-V` — a suppression any viewer can
 *      turn off is not a suppression. So the drill narrows the rows and changes
 *      nothing about the verdict.
 *
 * KNOWN, ACCEPTED DIVERGENCE: a govt operator in a sub-k jurisdiction now sees
 * their real count on /gob/censo and a hatched cell for the same province on
 * /gob/panorama, whose loaders were closed by #40 under the earlier blanket
 * rule. D.10 is scoped to #40c (censo + población); realigning Panorama is a
 * separate decision, flagged rather than smuggled in here.
 */
export function planProvinceDisclosure(
  ctx: ScopedForDisclosure,
  rows: readonly ProvinceDenominatorRow[],
): ProvinceDisclosurePlan {
  const rowTotal = rows.reduce((sum, r) => sum + r.denominator, 0);

  // (1) + (3): own cells and empty groups are never candidates.
  const candidates: ProvinceDenominatorRow[] = [];
  for (const r of rows) {
    if (isOwnJurisdictionProvince(ctx, r.province)) continue;
    if (r.denominator <= 0) continue;
    candidates.push(r);
  }

  // (2) k and the comparison come from the shared primitive, never re-typed —
  // and since 2026-08-17 they cannot be re-typed: suppressSmallCells takes no
  // `k`, so ANONYMITY_K is the only floor it can apply.
  const primary = suppressSmallCells(candidates, {
    count: (r) => r.denominator,
    key: (r) => r.province,
  });

  const suppressed = primary.suppressed;
  const withheld = new Set(suppressed.map((r) => r.province));

  // (4) THE RESIDUAL RULE. A published Σ hands the attacker
  // `Σ(withheld) = rowTotal − Σ(visible)`; k must protect that residual exactly
  // as it protects a single cell, so the same `>= ANONYMITY_K` comparison the
  // per-cell pass uses is applied to the withheld MASS. Counting cells instead
  // (`withheld.size === 1`) was the leak: `[1, 1, 998]` hides two cells and
  // still pins each at 1, because 2 animals cannot be spread over two ≥1 cells
  // any other way.
  const withheldMass = suppressed.reduce((sum, r) => sum + r.denominator, 0);
  const residualProtected = withheld.size === 0 || withheldMass >= ANONYMITY_K;

  // (5) THE SCOPE HEADLINE. With exactly one unit in the grouping, the scope
  // total is not an aggregate over units — it is that unit's cell under another
  // label, so it inherits that cell's verdict. With two or more units it is a
  // real aggregate and rule (4) is what guards its residual.
  const soleUnit = rows.length === 1 ? rows[0] : null;
  const scopeTotalPublishable = soleUnit === null || !withheld.has(soleUnit.province);

  return {
    withheld,
    suppressedCount: withheld.size,
    publishableRowTotal: residualProtected ? rowTotal : null,
    scopeTotalPublishable,
  };
}

/**
 * The Spanish disclosure line every surface renders when `suppressedCount > 0`,
 * so no consumer can drift into a wording of its own (and so a reviewer greps
 * ONE string). The count of consumers is deliberately NOT written down here —
 * baked-in counts in this family have gone stale four times; `CONSUMERS` in
 * province-disclosure.test.ts is the live list. Returns `null` when there is
 * nothing to disclose —
 * a surface must never announce a suppression this frame does not carry (the
 * inverse failure: a legend promising a hatch the map never paints).
 *
 * THE REASON IN THE PARENTHESIS IS LOAD-BEARING and it is now true again: with
 * the complementary pass gone (see `planProvinceDisclosure`), every withheld
 * province really does hold fewer than k. While the pass ran, this line claimed
 * "menos de 5 mascotas" about La Rioja's 1.204 (RA-1 finding C1b) — a notice
 * that misstates the reason teaches the operator to distrust every other one.
 */
export function provinceSuppressionNotice(suppressedCount: number): string | null {
  if (suppressedCount <= 0) return null;
  return suppressedCount === 1
    ? `1 provincia oculta por privacidad (menos de ${ANONYMITY_K} mascotas en la jurisdicción)`
    : `${suppressedCount} provincias ocultas por privacidad (menos de ${ANONYMITY_K} mascotas en la jurisdicción)`;
}

/**
 * The Spanish line a surface renders INSTEAD OF its scope aggregates when
 * `scopeTotalPublishable` is false — one wording for the KPI row, the CSV
 * `resumen` and any future headline, for the same reason
 * `provinceSuppressionNotice` is one wording.
 *
 * It must say WHY, and the why is specific: the filter narrowed the scope to a
 * single jurisdiction that is itself withheld, so any "total" of that scope is
 * that jurisdiction's number wearing a different label. It must NOT read as
 * "sin datos" — the data exists, and dressing a withholding as a coverage gap is
 * the same lie as dressing a coverage gap as a withholding.
 *
 * Returns `null` when the aggregate IS publishable: never announce a mark this
 * frame does not carry.
 */
export function scopeTotalSuppressionNotice(scopeTotalPublishable: boolean): string | null {
  if (scopeTotalPublishable) return null;
  return `Totales ocultos por privacidad: el filtro deja una sola jurisdicción y tiene menos de ${ANONYMITY_K} mascotas registradas, así que el total del recorte sería exactamente esa cifra. Ampliá el filtro de jurisdicción para ver los agregados.`;
}

/**
 * Apply the same verdict to a CSV `resumen` row — ONE implementation for both
 * /gob/censo/export and /gob/poblacion/export, so the two files cannot withhold
 * differently (RA-1 finding C1c: the censo CSV printed `total_registradas,3`
 * fourteen lines above `Tierra del Fuego,suprimido por privacidad` — the same
 * file publishing the protected number and claiming to protect it).
 *
 * ALL-OR-NOTHING, by construction: every column of a `resumen` is an aggregate
 * over the SAME scope, so a caller cannot withhold one and keep another. That
 * matters most for poblacion, where a rate kept beside a withheld base would
 * hand back the numerator by multiplication.
 *
 * KEYS ARE PRESERVED and the value becomes `SUPPRESSED_CELL_TEXT`, the same
 * marker the province rows use — never `0` (a false zero asserts something
 * untrue) and never a dropped column (a column that disappears when it crosses k
 * makes absence the disclosure channel, in a file that outlives the screen).
 */
export function scopeSummaryRow<T extends Record<string, unknown>>(
  scopeTotalPublishable: boolean,
  row: T,
): Record<string, unknown> {
  if (scopeTotalPublishable) return row;
  return Object.fromEntries(Object.keys(row).map((key) => [key, SUPPRESSED_CELL_TEXT]));
}

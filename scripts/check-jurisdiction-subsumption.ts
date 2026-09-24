// Jurisdiction-subsumption linter — CI guardrail (regression armor).
//
// THE BUG CLASS THIS CATCHES ("exact-pair jurisdiction gate"):
//   An authorization site that gates a govt operator by hand-rolling an EXACT
//   (province, locality) equality against a resource row's stored jurisdiction:
//
//     jurisdictions.some(
//       (j) => j.province === row.jurisdictionProvince &&
//              j.locality === row.jurisdictionLocality,
//     )
//
//   This DIVERGES from the two-tier CABA model: a whole-province assignment
//   (e.g. whole-CABA / "Ciudad Autónoma de Buenos Aires") governs EVERY barrio
//   in that province, but the exact pair only matches the literal whole-city
//   string — so a whole-CABA operator 404s / is denied on a barrio-tagged row
//   (Almagro, Palermo, …). The queue LIST already subsumes barrios via
//   jurisdictionPairClause, so list and detail authorization silently disagree.
//   See lib/domain/jurisdiction-canonical.ts and the fix in commit 4cc1cbd5.
//
// THE FIX (what makes a site pass this linter):
//   Route the check through the canonical subsumption helpers instead of a raw
//   pair — jurisdictionScopeContains (in-memory) or jurisdictionPairClause /
//   isWholeProvinceLocality (SQL). Those keep barrio-specific assignments exact
//   and other provinces invisible, so they NEVER widen security.
//
// WHY A HARD FAIL (no baseline, unlike check-authz-scoping):
//   After the class was closed there are ZERO offenders in source. The signature
//   keys on the RESOURCE column names `.jurisdictionProvince` / `.jurisdictionLocality`,
//   which only appear paired-and-exact at a real authorization read. Legitimate
//   exact matches elsewhere compare against a UI SELECTION (`selectedLocalityName`,
//   `selectedLocalityRow.localityName`) or use different field names — they do NOT
//   match. So any new hit is a real regression of the whole class (like lint:events
//   for ghost payload keys).
//
// SANCTIONED EXCEPTIONS (the only files allowed to pair the exact columns):
//   - lib/domain/jurisdiction-canonical.ts — defines jurisdictionScopeContains,
//     whose fail-closed inner branch IS the exact pair (for barrio assignments).
//   - lib/metrics/scope.ts — defines jurisdictionPairClause (the SQL counterpart).
//
// HARDENING (2026-07-22): the original ANTI_PATTERN only matched the in-memory
// JS `a.province === b.jurisdictionProvince && a.locality === b.jurisdictionLocality`
// shape. It missed the SAME bug hand-rolled through query-builder calls instead of
// `===` — which is exactly how it slipped past on buildGovtCaseWhereClause
// (lib/infra/case-queries.ts) and the govt branch of fetchObservaciones
// (lib/metrics/observaciones-query.ts, fixed in commit 68501bb4):
//   - Drizzle: `and(eq(row.jurisdictionProvince, j.province), eq(row.jurisdictionLocality, j.locality))`
//   - raw SQL template: `` sql`(${row.jurisdictionProvince} = ${j.province} AND ${row.jurisdictionLocality} = ${j.locality})` ``
// Both are the identical exact-pair anti-pattern, just expressed as function
// calls / a SQL string instead of a `===` boolean expression, so the original
// regex (anchored on `===`) never saw them. ANTI_PATTERN_BUILDER below adds
// both shapes (order-tolerant on which column comes first).
//
// Those two builder shapes are ALSO used legitimately for something that is
// NOT this bug class: an ADMIN drill-down or a hand-picked UI SELECTION,
// e.g. `and(eq(col.jurisdictionProvince, ctx.adminProvince),
// eq(col.jurisdictionLocality, ctx.adminLocality))` (lib/analytics/dashboards/
// _scope.ts, govt-home-kpis.ts, analytics-ranking.ts) or `selectedProvince` /
// `selectedLocality` (lib/analytics/dashboards/welfare.ts). Those compare a
// single hand-chosen value — never a `.map()` over the viewer's OWN
// jurisdiction ASSIGNMENTS — so they are not an authorization boundary that
// needs subsumption (admin already has universal scope; picking one specific
// unit to look at is a UI feature, not a security gate). The confirmed real
// bug always builds an OR-of-pairs by mapping over a jurisdictions array, so
// REQUIRE_TOKEN demands a nearby `.map(` before a builder-shape hit counts.
//
// GUARD_TOKEN exception: a `isWholeProvinceLocality(j.province, j.locality) ? … :
// and(eq(province), eq(locality))` ternary (see lib/infra/approval-scope.ts
// visibleRequestsClause) is NOT an offender — the and(eq,eq) there is only the
// correctly-narrowed barrio-specific ELSE branch of already subsumption-aware
// logic. A nearby `isWholeProvinceLocality(` call suppresses the hit.
//
// Run: pnpm tsx scripts/check-jurisdiction-subsumption.ts  (or: pnpm lint:authz-subsumption)

import { globSync, readFileSync } from "node:fs";

// Files allowed to hand-roll the exact (province, locality) pair — they are the
// canonical subsumption helpers themselves.
const SANCTIONED = new Set<string>([
  "lib/domain/jurisdiction-canonical.ts",
  "lib/metrics/scope.ts",
]);

// Single-site, explicit exceptions — NOT a general baseline (this fence stays
// hard-fail by design). Each entry is a genuinely different bug shape that
// `jurisdictionPairClause` cannot correctly fix by simple substitution, so it
// is left for a dedicated helper rather than silently mis-fixed. Keep this set
// tiny; anything resembling the real authorization-visibility bug class
// belongs in the fix, not here.
const KNOWN_EXCEPTIONS = new Set<string>([
  // app/(app)/cuenta/desactivar/page.tsx — coverage-WARNING estimate (not
  // an authorization gate: nothing is granted or hidden by this count). It
  // needs BIDIRECTIONAL subsumption (my assignment covers theirs OR theirs
  // covers mine), which jurisdictionPairClause doesn't provide — it only
  // subsumes from the scope-owner side. Swapping it in as-is would still
  // under-count (the groupBy+exact-key lookup below it would silently drop
  // a widened match). Flagged for a follow-up bidirectional helper.
  "app/(app)/cuenta/desactivar/page.tsx:74",
]);

// Shape 1 — in-memory `===` chain (order-tolerant, newline-tolerant). Kept
// unconditional: the original design had zero false positives with this shape.
const ANTI_PATTERN_IN_MEMORY: RegExp[] = [
  /\.province\s*===\s*[\w.]+\.jurisdictionProvince\s*&&\s*[\w.]*\.?locality\s*===\s*[\w.]+\.jurisdictionLocality/,
  /\.locality\s*===\s*[\w.]+\.jurisdictionLocality\s*&&\s*[\w.]*\.?province\s*===\s*[\w.]+\.jurisdictionProvince/,
];

// Shapes 2/3 — query-builder exact pairs. Only count as an offender when
// REQUIRE_TOKEN (a nearby `.map(`) is also present — see the hardening note
// above for why (admin drill-down / UI-selection single-value comparisons
// use the identical shape but are not the bug this fence targets).
const ANTI_PATTERN_BUILDER: RegExp[] = [
  // Drizzle `and(eq(col.jurisdictionProvince, x), eq(col.jurisdictionLocality, y))`.
  // Requires the literal `and(` wrapper so independent, individually `if`-guarded
  // UI-filter `eq()` pushes (e.g. adoption-listing-read.ts's optional
  // `filters.province` / `filters.locality` search fields) never match — those
  // are never joined inside a shared `and(...)` call.
  /and\(\s*eq\(\s*[\w.]+\.jurisdictionProvince\s*,\s*[\w.]+\s*\)\s*,\s*eq\(\s*[\w.]*\.?jurisdictionLocality\s*,\s*[\w.]+\s*\)/,
  /and\(\s*eq\(\s*[\w.]+\.jurisdictionLocality\s*,\s*[\w.]+\s*\)\s*,\s*eq\(\s*[\w.]*\.?jurisdictionProvince\s*,\s*[\w.]+\s*\)/,
  // raw `sql` template exact pair joined by SQL `AND`.
  /\$\{[\w.]*jurisdictionProvince\}\s*=\s*\$\{[\w.]+\}\s*AND\s*\$\{[\w.]*jurisdictionLocality\}\s*=\s*\$\{[\w.]+\}/i,
  /\$\{[\w.]*jurisdictionLocality\}\s*=\s*\$\{[\w.]+\}\s*AND\s*\$\{[\w.]*jurisdictionProvince\}\s*=\s*\$\{[\w.]+\}/i,
];

// Shape 4 — the SCOPE-OBJECT field names, added 2026-08-17 after this fence
// stayed green through a real instance of its own bug class.
//
// Every pattern above keys on the DB COLUMN names (`jurisdictionProvince` /
// `jurisdictionLocality`). `lib/infra/gov-scope.ts::resolveScopedJurisdictions`
// — described in its own callers as "THE FENCE", wired into ~32 /gob screens —
// narrowed with `j.province === selectedProvinceName && j.locality ===
// selectedLocalityName`. Same bug, both sides spelled with the SCOPE object's
// short field names, so no pattern here could see it: the fence enumerated the
// spellings of the bug rather than the bug. It kept a whole-province operator's
// own dashboard empty until 2026-08-17.
//
// Gated by REQUIRE_ARRAY_TOKEN below rather than `.map(`, because this shape
// appears inside `.filter(` / `.some(` over the assignment list.
const ANTI_PATTERN_SCOPE_FIELDS: RegExp[] = [
  /\.province\s*===\s*[\w.]+\s*&&\s*[\w.]*\.?locality\s*===\s*[\w.]+/,
  /\.locality\s*===\s*[\w.]+\s*&&\s*[\w.]*\.?province\s*===\s*[\w.]+/,
];

// A nearby `.map(` means this exact pair was built per-item from a jurisdiction
// ARRAY (the real bug shape — an OR-of-pairs over the viewer's own
// assignments). Its absence means a single hand-chosen value (admin drill-down
// / UI selection) — not this bug class.
const REQUIRE_TOKEN = ".map(";

// Shape 4's equivalent: the predicate must be applied ACROSS the assignment
// list. A bare `a.province === b.province && a.locality === b.locality` between
// two single objects is an equality check, not an authorization gate.
const REQUIRE_ARRAY_TOKENS = [".filter(", ".some(", ".every(", ".find(", ".map("];

// …and the array must be the viewer's JURISDICTION ASSIGNMENTS. Without this,
// Shape 4 also flags `pickObligationRule` (lib/analytics/mandating-
// jurisdictions.ts), which walks business-rule ROWS in a deliberate cascade —
// exact locality row, then the province row with `locality === null`, then the
// country default. There the exact match is the correct FIRST TIER and the
// widening happens in the next branch, so it is subsumption done right, not
// missing.
//
// KNOWN LIMIT, stated rather than discovered later: this keys on the word
// "jurisdiction" appearing near the predicate, which is how every real instance
// has been written (`jurisdictions.some(...)`, `jurisdictions.filter(...)`). An
// assignment list named something else — `scopes`, `assignments` — would slip
// past. That is the same failure this whole shape exists to correct, one level
// up: a fence that recognises the SPELLINGS it has seen. Prefer widening this
// token over adding exceptions when the next instance appears.
const REQUIRE_SCOPE_TOKEN = /jurisdiction/i;
// A nearby call to the canonical whole-province primitive means this exact
// pair is the deliberately-narrow branch of already subsumption-aware logic,
// not an unconditional under-scoping bug. See lib/infra/approval-scope.ts.
const GUARD_TOKEN = "isWholeProvinceLocality(";
const LOOKBACK_LINES = 5;

// Line-level scan (so we can report line numbers) with a small look-ahead window
// to catch the pattern when it spans lines — the common Biome-formatted shape.
export function findSubsumptionOffenders(relPath: string, src: string): string[] {
  const out: string[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Join up to 3 lines so a wrapped predicate still matches.
    const window = `${lines[i]}\n${lines[i + 1] ?? ""}\n${lines[i + 2] ?? ""}`;

    if (ANTI_PATTERN_IN_MEMORY.some((re) => re.test(window))) {
      out.push(`${relPath}:${i + 1}`);
      continue;
    }

    const lookback = lines.slice(Math.max(0, i - LOOKBACK_LINES), i + 3).join("\n");

    if (ANTI_PATTERN_SCOPE_FIELDS.some((re) => re.test(window))) {
      // Only when the predicate runs across the assignment list, and only when
      // subsumption is not already handled nearby.
      if (
        REQUIRE_ARRAY_TOKENS.some((t) => lookback.includes(t)) &&
        REQUIRE_SCOPE_TOKEN.test(lookback) &&
        !lookback.includes(GUARD_TOKEN) &&
        !KNOWN_EXCEPTIONS.has(`${relPath}:${i + 1}`)
      ) {
        out.push(`${relPath}:${i + 1}`);
        continue;
      }
    }

    if (!ANTI_PATTERN_BUILDER.some((re) => re.test(window))) continue;

    if (!lookback.includes(REQUIRE_TOKEN)) continue; // single hand-chosen value, not an array scope
    if (lookback.includes(GUARD_TOKEN)) continue; // already subsumption-guarded
    if (KNOWN_EXCEPTIONS.has(`${relPath}:${i + 1}`)) continue;

    out.push(`${relPath}:${i + 1}`);
  }
  return out;
}

export function listScopedSourceFiles(): string[] {
  const patterns = ["app/**/*.ts", "app/**/*.tsx", "lib/**/*.ts", "src/**/*.ts", "src/**/*.tsx"];
  return patterns
    .flatMap((p) => globSync(p))
    .map((f) => f.replaceAll("\\", "/"))
    .filter(
      (f) => !f.includes("/__tests__/") && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"),
    )
    .filter((f) => !SANCTIONED.has(f));
}

export function scanAll(): string[] {
  const offenders: string[] = [];
  for (const file of listScopedSourceFiles()) {
    offenders.push(...findSubsumptionOffenders(file, readFileSync(file, "utf8")));
  }
  return offenders;
}

function runScan(): void {
  const offenders = scanAll();
  if (offenders.length === 0) {
    console.log(
      "✓ jurisdiction-subsumption clean — no exact-pair (province, locality) authorization gates.",
    );
    return;
  }
  console.error(
    `✗ ${offenders.length} exact-pair jurisdiction gate(s) — a whole-province operator (e.g. whole-CABA) would be denied on a barrio-tagged row (list-vs-detail authorization divergence):`,
  );
  for (const o of offenders) console.error(`    ${o}`);
  console.error(
    "\nRoute the check through jurisdictionScopeContains (in-memory) or jurisdictionPairClause / isWholeProvinceLocality (SQL) — see lib/domain/jurisdiction-canonical.ts. These keep barrio assignments exact and never widen security.",
  );
  process.exit(1);
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-jurisdiction-subsumption.ts") ||
    process.argv[1].endsWith("check-jurisdiction-subsumption.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}

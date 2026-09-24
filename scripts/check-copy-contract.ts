// Copy-contract linter — C2 · Contrato de Lenguaje Operativo (2026-07-22
// plan-maestro-integridad, "restricted vocabulary" fence).
//
// WHY THIS EXISTS
// ----------------
// The 2026-07-22 audit found operator-facing copy that PROMISED something its
// destination/behavior did not deliver: a "SLA vencido (1 d)" badge that
// showed the SEVERITY TIER instead of days overdue (the #1 trust bug); a red
// "Acta de infracción" CTA linking to a triage QUEUE with no acta-emitting
// flow; a "Ver en su cola →" link that routed to a MAP on 4 of 5 event types.
// Each got a typed primitive (SlaBadge; the novedades-feed-links capability
// registry) so the bug class cannot recur BY CONSTRUCTION at those call
// sites. This fence is the regression guard: it forbids the exact broken
// strings from reappearing as raw JSX literals anywhere else in the
// operator surface, so the next screen can't quietly reintroduce them.
//
// SCOPE (deliberately NARROW to avoid noise — plan-maestro directive):
//   - Only app/gob/**/*.tsx and app/admin/**/*.tsx (the operator surface the
//     2026-07-22 audit covers). Not components/, not citizen-facing app/(app)/.
//   - Only .tsx files; test files (*.test.tsx) are excluded — they may
//     legitimately reference a banned string as a regression assertion
//     ("expect(...).not.toContain(...)"), not as real copy (same exclusion
//     rationale as check-metric-labels.ts).
//   - Comments are stripped first (mirrors check-scope-discipline.ts's
//     stripComments) so a doc comment naming the old bug ("SLA vencido (1
//     d)... was the bug") never registers as a live offense.
//
// RULES ENFORCED (plan §4a — restricted phrases that must come from a typed
// component instead of a raw literal):
//   1. "SLA vencido" — the pre-fix literal that printed the severity TIER as
//      if it were days overdue. The only honest producer is
//      components/ui/dashboard/SlaBadge.tsx, which lives outside this scan's
//      scope by construction — so ANY hit inside app/gob|app/admin is a
//      reintroduced raw literal.
//   2. "Acta de" inside a <Link>/<a>/<button> element's rendered text — names
//      a legal instrument ("acta") as a link/button label. Grandfather via
//      the baseline ONLY when the destination genuinely emits an acta;
//      otherwise rename the label (mirrors the app/gob/page.tsx fix:
//      "Acta de infracción" → "Denuncias de maltrato").
//   3. "Ver en su cola" — the exact pre-fix string that labeled a MAP
//      destination as a queue on 4 of 5 novedades event types. NOT "Ver en la
//      cola" (still valid — real queue destinations keep that label); href
//      analysis to generically validate label↔capability is out of reach for
//      a static regex scan, so per the plan's own fallback this fence just
//      bans the one exact broken string.
//
// (b) Acronym-in-h1-without-nearby-expansion (plan §4b) is SKIPPED — cheaply
// and reliably detecting "is the expansion NEARBY" without a real JSX/DOM
// parser produces too many false positives/negatives to be worth the noise
// budget (an h1 and its expansion subtitle are often in sibling JSX
// expressions, not adjacent text nodes a regex can correlate). Reported here
// per the plan's own "otherwise skip (report the choice)" instruction.
//
// Baseline: scripts/copy-contract-baseline.json, `"relPath:line": "reason"`.
// Grandfathers pre-existing (reviewed) exceptions only; a NEW violation not
// in the baseline hard-fails, and a stale baseline entry that no longer
// matches any offense also hard-fails (mirrors check-scope-discipline.ts).
//
// Run: pnpm tsx scripts/check-copy-contract.ts   (or: pnpm lint:copy-contract)
// Exits 0 clean; exits 1 listing each offending file:line.

import { globSync, readFileSync } from "node:fs";

import { stripComments } from "./lib/strip-comments.mjs";

export const BASELINE_FILE = "scripts/copy-contract-baseline.json";

// ---------------------------------------------------------------------------
// Comment stripping (preserves newlines so line numbers stay valid). Single
// source of truth: scripts/lib/strip-comments.mjs — re-exported here so
// existing `import { stripComments } from "./check-copy-contract"` call
// sites keep working unchanged.
// ---------------------------------------------------------------------------

export { stripComments };

// ---------------------------------------------------------------------------
// Offense extraction
// ---------------------------------------------------------------------------

export type OffenseRule = "sla-vencido-literal" | "acta-de-label" | "ver-en-su-cola-literal";

export type Offense = {
  file: string;
  line: number;
  rule: OffenseRule;
  snippet: string;
};

export function describeRule(rule: OffenseRule): string {
  switch (rule) {
    case "sla-vencido-literal":
      return 'raw "SLA vencido" literal — must come from components/ui/dashboard/SlaBadge.tsx, which owns the honest breached/historical/in-plazo semantic';
    case "acta-de-label":
      return '"Acta de" used as a link/button label — names a legal instrument no acta-emitting flow backs (unless genuinely justified in the baseline)';
    case "ver-en-su-cola-literal":
      return '"Ver en su cola" — the pre-fix label that routed a MAP destination as if it were a queue (see lib/metrics/novedades-feed-links.ts)';
  }
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/** Every occurrence of `needle` in the (comment-stripped) content, as offenses. */
function scanLiteral(
  relPath: string,
  content: string,
  needle: string,
  rule: OffenseRule,
): Offense[] {
  const offenses: Offense[] = [];
  let from = 0;
  for (;;) {
    const idx = content.indexOf(needle, from);
    if (idx === -1) break;
    const line = lineOf(content, idx);
    const lineText = content.split("\n")[line - 1]?.trim() ?? needle;
    offenses.push({ file: relPath, line, rule, snippet: lineText });
    from = idx + needle.length;
  }
  return offenses;
}

// <Link ...>...</Link>, <a ...>...</a>, <button ...>...</button> — captures
// the element's rendered text (tags stripped) to check for "Acta de". Not a
// real JSX parser: assumes these tags are not self-nested (true throughout
// this codebase's app/gob + app/admin surface today).
const TAGGED_ELEMENT_RE = /<(Link|a|button)\b[^>]*>([\s\S]*?)<\/\1>/g;

function scanActaDeLabels(relPath: string, content: string): Offense[] {
  const offenses: Offense[] = [];
  for (const match of content.matchAll(TAGGED_ELEMENT_RE)) {
    const innerRaw = match[2] ?? "";
    // Strip nested tags/expressions' angle brackets to approximate rendered text.
    const innerText = innerRaw
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (innerText.includes("Acta de")) {
      const line = lineOf(content, match.index ?? 0);
      offenses.push({
        file: relPath,
        line,
        rule: "acta-de-label",
        snippet: innerText.slice(0, 80),
      });
    }
  }
  return offenses;
}

export function extractOffenses(relPath: string, rawSrc: string): Offense[] {
  const src = stripComments(rawSrc);
  return [
    ...scanLiteral(relPath, src, "SLA vencido", "sla-vencido-literal"),
    ...scanLiteral(relPath, src, "Ver en su cola", "ver-en-su-cola-literal"),
    ...scanActaDeLabels(relPath, src),
  ];
}

// ---------------------------------------------------------------------------
// File listing
// ---------------------------------------------------------------------------

function normalizeRelPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

export function listScannedFiles(): string[] {
  const files = globSync("{app/gob,app/admin}/**/*.tsx");
  return [...new Set(files.map(normalizeRelPath))].filter((f) => !f.includes(".test.")).sort();
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

export function loadBaseline(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function runScan(): void {
  const baseline = loadBaseline();
  const files = listScannedFiles();

  if (files.length === 0) {
    console.error(
      "✗ check-copy-contract: found no files to scan under app/gob/**/*.tsx or app/admin/**/*.tsx.",
    );
    process.exit(1);
  }

  const offenders: string[] = [];
  const usedBaselineEntries = new Set<string>();
  let totalOffenses = 0;

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const offenses = extractOffenses(file, src);
    totalOffenses += offenses.length;
    for (const offense of offenses) {
      const key = `${offense.file}:${offense.line}`;
      if (baseline[key] !== undefined) {
        usedBaselineEntries.add(key);
        continue;
      }
      offenders.push(
        `${key} — ${describeRule(offense.rule)}: \`${offense.snippet}\`. If this is a genuinely justified exception, add "${key}": "<reason>" to ${BASELINE_FILE} — otherwise fix the copy.`,
      );
    }
  }

  const staleBaselineEntries = Object.keys(baseline).filter((k) => !usedBaselineEntries.has(k));

  if (offenders.length > 0) {
    console.error(offenders.join("\n"));
    console.error(
      `\n✗ ${offenders.length} copy-contract violation(s) (${files.length} files scanned, ${totalOffenses} total hits, ${usedBaselineEntries.size} baselined).`,
    );
    process.exit(1);
  }

  if (staleBaselineEntries.length > 0) {
    console.error(
      `✗ ${staleBaselineEntries.length} stale baseline entr${staleBaselineEntries.length === 1 ? "y" : "ies"} in ${BASELINE_FILE} no longer match any offense: ${staleBaselineEntries.join(", ")}. Remove them — a baseline only exists for occurrences that need it.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ copy contract clean — ${files.length} files scanned, ${totalOffenses} restricted-phrase hits checked${
      usedBaselineEntries.size > 0 ? ` (${usedBaselineEntries.size} baselined)` : ""
    }.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-copy-contract.ts") ||
    process.argv[1].endsWith("check-copy-contract.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}

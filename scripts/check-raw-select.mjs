// Raw <select> ratchet — CI guard (design-system consolidation).
//
// Enforces that literal `<select` elements do not increase across the app
// and components surfaces. The target is full adoption of the LnSelect
// (components/ui/Field.tsx) and OpSelect (components/ui/dashboard/OpField.tsx)
// primitives instead of raw `<select>` tags, so the custom chevron, mobile
// focus handling, and localized native-validation messages (setCustomValidity)
// stay consistent across the design system.
//
// Rule:
//   Count literal `<select` occurrences (case-sensitive tag open) in .tsx
//   files under app/ and components/ (test files and the two primitive
//   definition files excluded). Comment lines are ignored — a `// … <select>
//   …` mention or a JSDoc `* <select> …` line is documentation, not a control.
//   If the TOTAL count is greater than BASELINE, fail. If a PR migrates raw
//   selects to LnSelect/OpSelect and lowers the count, update BASELINE down
//   to the new total in the same change — the ratchet only ever tightens.
//
// Run: node scripts/check-raw-select.mjs   (or: pnpm lint:select)
// Exits 0 when clean; exits 1 listing each file's count when the total
// exceeds the baseline.

import { globSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Total literal `<select` occurrences across app/ and components/ (comment
 *  lines and the two field-primitive definition files excluded), measured
 *  on 2026-07-21 (casos/outbox filter-bar sweep: /gob/casos + /admin/casos
 *  + /gob/outbox + /admin/outbox migrated their bespoke <form> filter rows
 *  to OpFilterBar axes — the outbox pair's 4 raw <select>s each are gone).
 *  Lowered again same day (opfilterbar-sweep-2026-07-21 cluster 2 — alerts/
 *  audit/history family): /admin/alertas, /admin/auditoria, /gob/historial,
 *  /admin/historial migrated their bespoke <form>/OpCard filter rows to
 *  OpFilterBar (7 raw <select>s replaced by OpSelect-based axes/children).
 *  Lowered again same day (consistency-sweep2-2026-07-21 item 2): /gob/org
 *  (+ /admin/org re-export) migrated its bespoke Verificación/Tipo <select>s
 *  to OpFilterBar axes — 2 raw <select>s gone (49 -> 48).
 *  Target: 0, via migration to LnSelect (citizen) / OpSelect (operator).
 *  Lowered 48 -> 27 (op-control-primitive sweep, 2026-08-07): the operator
 *  control chrome (border-ln-op-line + bg-ln-op-card on a raw input/select/
 *  textarea) was hand-rolled at 92 call sites in ~35 spellings; all of them now
 *  render through OpInput/OpSelect/OpTextarea. 21 of those were raw <select>s.
 *  The sibling fence lint:op-controls (scripts/check-op-controls.mjs) holds
 *  that recipe at zero.
 *  Lower this number as files migrate — never raise it without a design
 *  review sign-off (raw <select> reintroduces an inconsistent chevron,
 *  missing mobile focus-scroll, and un-localized native validation bubbles). */
// TIGHTENED 2026-08-10 from 27 to the real count. The fence itself was asking
// for it — it printed "raw <select> count improved: 19 (baseline 27). Lower
// BASELINE to 19 to lock in the gain" and nobody did, so eight fresh raw
// <select> could land without turning it red. A ratchet with slack is not a
// ratchet; same shape as RAW_BUTTON_BASELINE, which sat at 47 against a real
// count of 25 until 2026-08-10.
// TIGHTENED 2026-09-22 from 19 to 18: OrgMascotasFilterBar moved onto
// OpFilterBar and its species control onto OpSelect (L3·2, T3-J1).
const BASELINE = 18;

const SCAN_GLOB = "{app,components}/**/*.tsx";
const RAW_SELECT = /<select\b/g;

// The primitives that OWN select semantics — never flagged, however many
// `<select` tags they contain internally.
const PRIMITIVE_FILES = new Set(["components/ui/Field.tsx", "components/ui/dashboard/OpField.tsx"]);

// ---------------------------------------------------------------------------
// Core logic (exported for unit tests)
// ---------------------------------------------------------------------------

/** Count real (non-comment) `<select` tag-open occurrences in a file. */
export function countRawSelect(src) {
  let count = 0;
  for (const rawLine of src.split(/\r?\n/)) {
    for (const match of rawLine.matchAll(RAW_SELECT)) {
      // Skip a match that sits inside a line comment or a JSDoc continuation.
      const commentIdx = rawLine.indexOf("//");
      if (commentIdx !== -1 && commentIdx < (match.index ?? 0)) continue;
      if (rawLine.trimStart().startsWith("*")) continue;
      count += 1;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runScan() {
  const files = globSync(SCAN_GLOB)
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !f.includes(".test."))
    .filter((f) => !PRIMITIVE_FILES.has(f))
    .sort();

  if (files.length === 0) {
    console.error("✗ check-raw-select: no files found under app/, components/.");
    process.exit(1);
  }

  const perFile = [];
  let total = 0;

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const count = countRawSelect(src);
    if (count > 0) {
      perFile.push({ file, count });
      total += count;
    }
  }

  if (total > BASELINE) {
    perFile
      .sort((a, b) => b.count - a.count)
      .forEach(({ file, count }) => {
        console.error(`${file}: ${count} raw <select> occurrence(s)`);
      });
    console.error(
      `\n✗ ${total} raw <select> occurrence(s) across app/, components/ — baseline allows ${BASELINE}. Migrate new raw selects to LnSelect (components/ui/Field.tsx) or OpSelect (components/ui/dashboard/OpField.tsx).`,
    );
    process.exit(1);
  }

  if (total < BASELINE) {
    console.log(
      `✓ raw <select> count improved: ${total} (baseline ${BASELINE}). Lower BASELINE in scripts/check-raw-select.mjs to ${total} to lock in the gain.`,
    );
    return;
  }

  console.log(
    `✓ raw <select> count clean — ${total} occurrence(s) across ${files.length} file(s), at baseline (${BASELINE}).`,
  );
}

// Guard: only scan when run directly; importing from tests exposes
// countRawSelect without triggering the filesystem scan.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-raw-select.mjs") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}

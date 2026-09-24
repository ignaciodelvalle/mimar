// Hand-rolled operator control chrome — CI guard (design-system consolidation).
//
// The operator surface has ONE control chrome: `border-ln-op-line` +
// `bg-ln-op-card` on an input/select/textarea, defined once in
// components/ui/dashboard/OpField.tsx (OpInput / OpSelect / OpTextarea, plus
// OP_CONTROL_CLASS for composed controls that cannot render through them).
//
// Before this fence, 92 raw controls across app/gob, app/org, app/admin and
// components/ spelled that chrome 35 different ways. The drift was not
// cosmetic: ~90 of them fired their focus ring on `focus:` rather than
// `focus-visible:` (a ring that flashes on every mouse click, against
// OpButton's deliberate rule), the radius wandered across four values, and one
// family hardcoded `bg-white` — which renders white-on-white in dark mode,
// because `--color-ln-op-card` is #111a2b there.
//
// Rule (a RATCHET, like lint:select):
//   Count raw `<input>` / `<select>` / `<textarea>` elements under app/ and
//   components/ whose className carries `border-ln-op-line`. Checkboxes and
//   radios are exempt — they are OpCheckbox/LnCheckbox territory and wear a
//   different chrome (accent + ring, no field box). If the TOTAL exceeds
//   BASELINE, fail.
//
// Run: node scripts/check-op-controls.mjs   (or: pnpm lint:op-controls)

import { globSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Raw operator-chrome text controls across app/ and components/.
 *  Measured at 0 on 2026-08-07, after the op-control-primitive sweep migrated
 *  all 92 hand-rolled sites to OpInput/OpSelect/OpTextarea. It starts at zero
 *  and must stay there: unlike raw <select> (which has a legitimate migration
 *  backlog), there is no reason left to hand-roll this recipe. If you need a
 *  density or width the primitive lacks, add a `size` step or a prop to
 *  OpField.tsx — do not re-declare the chrome at the call site. */
const BASELINE = 0;

const SCAN_GLOB = "{app,components}/**/*.tsx";

/** The primitive that OWNS this chrome — never flagged. */
const PRIMITIVE_FILES = new Set(["components/ui/dashboard/OpField.tsx"]);

const TAG_OPEN = /<(input|select|textarea)\b/g;

// ---------------------------------------------------------------------------
// Core logic (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Slice the full opening tag starting at `start`, tracking JSX brace depth and
 * quotes so an expression attribute containing `>` does not end it early.
 * Returns null when the tag never closes (unparseable — caller skips it).
 */
export function readOpeningTag(src, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

/** Count raw operator-chrome text controls in one file's source. */
export function countRawOpControls(src) {
  let count = 0;
  for (const match of src.matchAll(TAG_OPEN)) {
    const el = readOpeningTag(src, match.index ?? 0);
    if (el === null) continue;
    if (!el.includes("border-ln-op-line")) continue;
    // Checkbox/radio wear a different chrome — OpCheckbox / LnCheckbox own them.
    if (/type="(checkbox|radio)"/.test(el)) continue;
    count += 1;
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
    console.error("✗ check-op-controls: no files found under app/, components/.");
    process.exit(1);
  }

  const perFile = [];
  let total = 0;

  for (const file of files) {
    const count = countRawOpControls(readFileSync(file, "utf8"));
    if (count > 0) {
      perFile.push({ file, count });
      total += count;
    }
  }

  if (total > BASELINE) {
    perFile
      .sort((a, b) => b.count - a.count)
      .forEach(({ file, count }) => {
        console.error(`${file}: ${count} hand-rolled op control(s)`);
      });
    console.error(
      `\n✗ ${total} hand-rolled operator control(s) across app/, components/ — baseline allows ${BASELINE}. Use OpInput / OpSelect / OpTextarea from components/ui/dashboard/OpField.tsx (size="md|sm|xs", block, invalid, mono), or OP_CONTROL_CLASS for a composed control.`,
    );
    process.exit(1);
  }

  if (total < BASELINE) {
    console.log(
      `✓ hand-rolled op controls improved: ${total} (baseline ${BASELINE}). Lower BASELINE in scripts/check-op-controls.mjs to ${total} to lock in the gain.`,
    );
    return;
  }

  console.log(
    `✓ no hand-rolled operator controls — ${files.length} file(s) scanned, at baseline (${BASELINE}).`,
  );
}

// Guard: only scan when run directly; importing from tests exposes the
// counters without triggering the filesystem scan.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-op-controls.mjs") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}

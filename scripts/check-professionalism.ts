// Professionalism lint fence — UI professionalism pass (PO directive
// 2026-07-14: no emoji in the UI, standardized icons, gov-grade sobriety).
// Companion audit: dim-interno:docs/reviews/2026-07-14-ui-professionalism-inventory.md.
//
// Two rules, two enforcement styles (mirrors check-design-tokens.ts /
// check-timezone-dates.ts: hard rule with no escape hatch + ratchet rule with
// an explicit, reviewable baseline).
//
// Rule 1 — emoji ban (HARD, no baseline). Any character in the emoji /
// dingbat / misc-symbol / variation-selector / regional-indicator Unicode
// ranges, found ANYWHERE in a scanned file, fails the build — EXCEPT inside a
// comment (`//`, a `/* … */` or `{/* … */}` block, or a JSDoc `*`
// continuation line), which is reported as an INFO count only. There is no
// baseline for this rule: after the UI professionalism pass the tree must be
// clean. If a stray hit turns up, FIX the call site (Icon or plain es-AR
// text) — do not grandfather an emoji.
//
// Rule 2 — symbol-as-icon ban (RATCHET, baseline
// scripts/professionalism-baseline.json). The standalone glyphs
// ✓ ✗ ✕ ✖ ⚠ ★ ☆ ✎ ● ○ ⏸ ▶ ◔ ◑ ◕ ▲ ◹ ♥ ♦ used as a pseudo-icon (JSX text or a
// string literal, comments excluded) fail as NEW violations against the
// baseline, same ratchet shape as check-design-tokens.ts rules 4-8: existing
// counts in a baselined file are grandfathered, anything ABOVE that count (or
// any new file) fails. The only intentional grandfather today is
// components/admin/AlertInboxTable.tsx's STATUS_ICON map (▲◔◑◕●○) — a
// PO-approved escalation-fill metaphor with no lucide equivalent (see the
// DELIBERATE GLYPH EXCEPTION comment on that file, 2026-07-14).
//
// `×` (U+00D7 MULTIPLICATION SIGN) is deliberately NOT in the Rule 2 char set
// above — it is sanctioned typography in dimensions ("44×44") and formulas
// ("cobertura × señal"). It is separately banned ONLY when it stands ALONE as
// the entire trimmed JSX text node or string literal (the classic fake
// close-button, `<button>×</button>`) — see X_STANDALONE below.
//
// Whitelisted anywhere, unconditionally (never matched by either rule's char
// set, listed here for documentation + a precision unit test): → · – — › « »
//
// Scope: app/**, components/**, lib/** — .ts/.tsx, excluding *.test.*,
// __tests__/**, *.stories.*.
//
// Run: pnpm tsx scripts/check-professionalism.ts
// Or:  pnpm lint:professionalism
// Rewrite baseline (only after a deliberate, reviewed grandfather decision —
// this is a ratchet, not a snooze button):
//   pnpm tsx scripts/check-professionalism.ts --write-baseline
//
// Exits 1 with file:line, the offending char, and a remedy on each hit.
// Exits 0 if clean.

import { globSync, readFileSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

function isExcluded(relPath: string): boolean {
  if (relPath.startsWith("node_modules/") || relPath.includes("/node_modules/")) return true;
  if (relPath.includes(".test.")) return true;
  if (relPath.includes("__tests__/")) return true;
  if (relPath.includes(".stories.")) return true;
  return false;
}

const FILES = globSync("{app,components,lib,packages,src}/**/*.{ts,tsx}")
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => !isExcluded(f));

// ---------------------------------------------------------------------------
// Comment classification — shared by both rules, pure + testable.
//
// Tracks a single piece of state across a file's lines: are we currently
// inside an unclosed block comment? Needed because this codebase leans on
// multi-line `{/* … */}` JSX comments whose CONTINUATION lines carry no `//`,
// `/*`, or `*` prefix of their own (e.g.
// app/gob/maltrato/_inspector/InspectorMounter.tsx's mobile-dim-area comment,
// or SituationalMap.tsx's role="application" comment) — a naive per-line
// prefix check would misclassify those continuation lines as real code and
// hard-fail Rule 1 on a documentation sentence that happens to mention a
// banned glyph.
// ---------------------------------------------------------------------------

export type CommentState = { inBlock: boolean };

export function classifyLine(
  rawLine: string,
  state: CommentState,
): { isComment: boolean; nextState: CommentState } {
  const line = rawLine.trim();

  // Already inside an unclosed /* … */ or {/* … */} block: the whole line is
  // comment content. It stops being "inBlock" once a closing */ appears.
  if (state.inBlock) {
    const closes = line.includes("*/");
    return { isComment: true, nextState: { inBlock: !closes } };
  }

  if (line.startsWith("//")) {
    return { isComment: true, nextState: { inBlock: false } };
  }

  if (line.startsWith("/*") || line.startsWith("{/*")) {
    const closesSameLine = line.includes("*/");
    return { isComment: true, nextState: { inBlock: !closesSameLine } };
  }

  // JSDoc continuation line (" * foo") — covered defensively even though
  // proper inBlock tracking already handles the common case, in case a scan
  // ever starts mid-block.
  if (line.startsWith("*")) {
    return { isComment: true, nextState: { inBlock: false } };
  }

  return { isComment: false, nextState: { inBlock: false } };
}

// ---------------------------------------------------------------------------
// Rule 1 — emoji ban (hard, no baseline)
// ---------------------------------------------------------------------------

// The Variation Selector block (U+FE00-FE0F) is a defensive range alongside
// the pictograph blocks (task spec); this regex only tests codepoint
// membership (Rule 1 is a per-character scan), not grapheme composition, so
// pairing a combining selector with a base character inside the class is not
// a correctness bug here.
export const EMOJI_RANGE =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: intentional codepoint-membership scan (not grapheme composition) — see comment above.
  /[\u{1F000}-\u{1F02F}\u{1F300}-\u{1FAFF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;

// ---------------------------------------------------------------------------
// Rule 2 — symbol-as-icon ban (ratchet, baseline)
// ---------------------------------------------------------------------------

export const SYMBOL_CHARS = "✓✗✕✖⚠★☆✎●○⏸▶◔◑◕▲◹♥♦";
export const SYMBOL_ICON_CHAR = new RegExp(`[${SYMBOL_CHARS}]`, "g");

// "×" is sanctioned in dimensions/formulas — only banned when it is the
// ENTIRE trimmed JSX text node ( >×< ) or the entire string literal content
// ( "×" / '×' / `×` ). "44×44" / "cobertura × señal" never match either arm
// because × there is not immediately adjacent to a tag boundary or a quote.
export const X_STANDALONE = /(>\s*×\s*<)|(["'`]×["'`])/g;

/** Chars never flagged by either rule (sanctioned typography) — matched by
 * neither EMOJI_RANGE nor SYMBOL_ICON_CHAR/X_STANDALONE by construction. Kept
 * as a list for documentation and a precision unit test, not consumed by the
 * scan itself. */
export const WHITELIST_CHARS = ["→", "·", "–", "—", "›", "«", "»"];

type Rule2Hit = { line: number; char: string };

/** All Rule 2 hits in a file's source, skipping comment lines. Exported for
 * unit tests (drives the ratchet count exactly like the CLI scan). */
export function findRule2Hits(src: string): Rule2Hit[] {
  const hits: Rule2Hit[] = [];
  let state: CommentState = { inBlock: false };
  src.split(/\r?\n/).forEach((rawLine, i) => {
    const { isComment, nextState } = classifyLine(rawLine, state);
    state = nextState;
    if (isComment) return;
    for (const match of rawLine.matchAll(SYMBOL_ICON_CHAR)) {
      hits.push({ line: i + 1, char: match[0] });
    }
    for (const _match of rawLine.matchAll(X_STANDALONE)) {
      hits.push({ line: i + 1, char: "×" });
    }
  });
  return hits;
}

const REMEDY =
  'use <Icon name="..."/> from components/Icon.tsx, or plain es-AR text; sanctioned typography: → · × (dimensions/formulas)';

// ---------------------------------------------------------------------------
// Baseline (Rule 2 only) — scripts/professionalism-baseline.json
//
// Shape mirrors check-design-tokens.ts / check-timezone-dates.ts: a per-file
// count, grandfathered up to that count; any file exceeding it (or any new
// file not listed) fails.
// ---------------------------------------------------------------------------

type BaselineFile = {
  _meta: { totalViolations: number; description: string };
  files: Record<string, number>;
};

const BASELINE_PATH = "scripts/professionalism-baseline.json";

function loadBaseline(): Record<string, number> {
  try {
    const data = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile;
    return data.files;
  } catch {
    console.warn(
      `[warn] ${BASELINE_PATH} not found — Rule 2 (symbol-as-icon) will be strict (no grandfather). Run: pnpm tsx scripts/check-professionalism.ts --write-baseline`,
    );
    return {};
  }
}

function writeBaseline(): void {
  const files: Record<string, number> = {};
  let total = 0;
  for (const file of FILES) {
    const count = findRule2Hits(readFileSync(file, "utf8")).length;
    if (count > 0) {
      files[file] = count;
      total += count;
    }
  }
  const output: BaselineFile = {
    _meta: {
      totalViolations: total,
      description:
        "Baseline of symbol-as-icon glyphs (✓✗✕✖⚠★☆✎●○⏸▶◔◑◕▲◹♥♦, plus a standalone ×) outside comments. Files listed here are grandfathered up to their count. New violations (new files, or counts above these) fail lint:professionalism. Regenerate only after a deliberate, reviewed grandfather decision.",
    },
    files,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `Baseline written: ${total} grandfathered symbol-as-icon hit(s) across ${Object.keys(files).length} file(s).`,
  );
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function runScan(): void {
  const baseline = loadBaseline();
  let hits = 0;
  let emojiInfoCount = 0;
  let grandfathered = 0;

  for (const file of FILES) {
    const src = readFileSync(file, "utf8");
    const lines = src.split(/\r?\n/);

    // --- Rule 1: emoji (hard, line-level, comment-aware) ---
    let state: CommentState = { inBlock: false };
    lines.forEach((line, i) => {
      const { isComment, nextState } = classifyLine(line, state);
      state = nextState;
      for (const match of line.matchAll(EMOJI_RANGE)) {
        if (isComment) {
          emojiInfoCount += 1;
          continue;
        }
        console.error(`${file}:${i + 1}: emoji "${match[0]}" in UI code — ${REMEDY}`);
        hits += 1;
      }
    });

    // --- Rule 2: symbol-as-icon (ratchet, comment-aware) ---
    const rule2Hits = findRule2Hits(src);
    if (rule2Hits.length > 0) {
      const allowed = baseline[file] ?? 0;
      grandfathered += Math.min(rule2Hits.length, allowed);
      if (rule2Hits.length > allowed) {
        for (const hit of rule2Hits) {
          console.error(`${file}:${hit.line}: symbol-as-icon "${hit.char}" — ${REMEDY}`);
        }
        console.error(
          `${file}: ratchet — ${rule2Hits.length} symbol-as-icon violation(s) (baseline allows ${allowed}). To grandfather a reviewed exception, run: pnpm tsx scripts/check-professionalism.ts --write-baseline`,
        );
        hits += 1;
      }
    }
  }

  if (hits > 0) {
    console.error(`\n✗ ${hits} professionalism violation(s).`);
    process.exit(1);
  }

  console.log(
    `✓ Professionalism clean — 0 emoji (${emojiInfoCount} in comments, informational only), 0 new symbol-as-icon violations across ${FILES.length} files.`,
  );
  console.log(
    `  Ratchet: ${grandfathered} grandfathered symbol-as-icon hit(s) across ${Object.keys(baseline).length} file(s). New ones will fail.`,
  );
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-professionalism.ts") ||
    process.argv[1].endsWith("check-professionalism.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  if (process.argv.includes("--write-baseline")) {
    writeBaseline();
  } else {
    runScan();
  }
}

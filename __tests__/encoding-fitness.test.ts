// Encoding fitness — no mojibake ever reaches a source file again.
//
// 2026-07-04: OpenInvestigationForm.tsx shipped a double-encoded em-dash
// (bytes 0xC3A2E282AC) that rendered as a replacement character in the ENO
// disease selector — caught by the PO watching a demo video. An agent or
// editor had saved the file through the wrong codepage. This scan is the
// machine-enforced version of the "UTF-8 or nothing" contract rule
// (docs/agents/): it fails CI the moment any tracked source contains the
// classic UTF-8-read-as-CP1252 artifacts or a literal replacement character.
//
// 2026-07-18 (cowork demo validation): a U+00AD SOFT HYPHEN rode into the
// localidades seed ("Agustín Roca") — an invisible format char that splits a
// word for the naked eye but corrupts equality/search on the name. The second
// test below fails on any soft hyphen in CODE / DATA dirs. It intentionally
// EXCLUDES docs: prose reviews (the demo-validation note itself) legitimately
// QUOTE the offending string to document the bug, and a couple of design docs
// carry accidental soft hyphens whose cleanup is a docs-owner follow-up, not a
// source-fitness failure. The ingest path is separately guarded at the boundary
// (scripts/import-indec-localities.ts strips U+00AD + mojibake before persist).
//
// 2026-08-17 (audit sweep): this file called itself "the machine-enforced UTF-8
// or nothing contract" while banning exactly two things — mojibake and soft
// hyphens. Two encoding defects were live in the tree the whole time and neither
// was a spelling of either:
//
//   · Raw NUL bytes (U+0000) used as a field separator in
//     src/modules/panorama/application/kpis-cache.ts and
//     scripts/backfill-locality-id.ts. A NUL makes git classify the file as
//     BINARY: no inline diff, no `--numstat` line count. Two modules that
//     decide dashboard caching and rewrite FK columns in bulk were, to every
//     reviewer and every diff-based tool, opaque blobs.
//   · A leading UTF-8 BOM on __tests__/decomiso-schema.test.ts and
//     __tests__/org-config.test.ts — invisible in an editor, and enough to
//     break a naive parser or a first-line directive.
//
// Plus one the sweep found on the way: two literal U+0008 BACKSPACE characters
// inside a comment in lib/events/event-capture-matcher.ts, where someone had
// typed the regex word-boundary `\b` and a tool interpreted the escape.
//
// So the ban is now stated as a CLASS (control characters), not as an
// enumeration of the spellings we happened to have been bitten by — the fence
// that enumerates forms always misses the next one.
//
// TWO deliberate non-bans, both real and both legitimate:
//   · U+FEFF is only banned as the FIRST character. Eleven CSV/export modules
//     PREPEND a BOM to their output on purpose so Excel opens the file as UTF-8;
//     banning U+FEFF outright would fail them for doing the right thing.
//   · docs/ is excluded from the control/BOM scans for the same reason it is
//     excluded from the soft-hyphen scan: five archived design docs carry BOMs,
//     and cleaning them is a docs-owner follow-up, not a source-fitness failure.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const SCAN_DIRS = ["app", "components", "lib", "src", "db", "scripts", "e2e", "docs"];
// Soft-hyphen scan omits docs (prose that quotes the character — see header).
const CODE_SCAN_DIRS = ["app", "components", "lib", "src", "db", "scripts", "e2e"];
// Control/BOM scans additionally cover __tests__ — the BOMs that motivated this
// pass lived THERE, so a fence that skipped it would have been born blind.
const BYTE_SCAN_DIRS = [...CODE_SCAN_DIRS, "__tests__"];
const EXTENSIONS = new Set([".ts", ".tsx", ".sql", ".md", ".json", ".mjs", ".css"]);
// U+FFFD replacement char + the common double-encoding artifacts. "Ã" alone
// is too broad (legit in some transliterations) — pair it with the vowels
// that only appear via mojibake in this codebase's languages.
const MOJIBAKE = /�|â€|Ã©|Ã­|Ã³|Ãº|Ã±|Ã¡|Â¿|Â°/;
// U+00AD SOFT HYPHEN — an invisible format character that must never sit inside
// source or seed data (it silently corrupts word equality / search). Written as
// an escape so no editor can strip the invisible glyph out of this regex.
const SOFT_HYPHEN = /\u00AD/;
// C0 controls + DEL, minus the three that are legitimate text: TAB (U+0009),
// LF (U+000A) and CR (U+000D). Written as a RANGE on purpose — the point is to
// ban the CLASS, so the next invisible byte nobody predicted is already covered.
// U+0000 (the NUL that made two files binary to git) and U+0008 (the BACKSPACE
// that ate a comment) are both members; neither is named.
//
// The ignore below is the rule meeting its own exception. noControlCharactersInRegex
// exists to catch someone who put a control character into a pattern by accident —
// a good rule, and the very defect this constant is built to hunt repo-wide. A
// fence against control characters cannot be written without naming them. Kept as
// a RANGE of unicode escapes (never literal bytes) so the file it lives in is not
// itself an offender, and the anti-vacuity block below pins every escape against a
// synthetic offender so a typo in one cannot pass unnoticed.
// biome-ignore lint/suspicious/noControlCharactersInRegex: this regex IS the control-character fence — see the comment above
const CONTROL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// U+FEFF as the FIRST character only — a leading BOM. Mid-file U+FEFF is a
// deliberate Excel-compatibility marker in the CSV exporters (see header).
const LEADING_BOM = /^\uFEFF/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walk(full);
    } else if (EXTENSIONS.has(full.slice(full.lastIndexOf(".")))) {
      yield full;
    }
  }
}

/**
 * Scan `dirs` for `pattern`.
 *
 * Returns the file COUNT alongside the offenders (2026-08-17). Every assertion
 * here is `toEqual([])` — the single easiest assertion in the world to satisfy
 * by scanning nothing. Rename a top-level directory, break `walk`, tighten
 * EXTENSIONS, and this file reports a clean tree having opened zero files. The
 * count is what lets the floor below tell "clean" apart from "blind".
 */
function scan(dirs: string[], pattern: RegExp): { offenders: string[]; filesScanned: number } {
  const offenders: string[] = [];
  let filesScanned = 0;
  for (const dir of dirs) {
    const abs = join(ROOT, dir);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const file of walk(abs)) {
      const text = readFileSync(file, "utf8");
      filesScanned += 1;
      const m = text.match(pattern);
      if (m) {
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(`${file.slice(ROOT.length + 1)}:${line} (${JSON.stringify(m[0])})`);
      }
    }
  }
  return { offenders, filesScanned };
}

/**
 * Corpus floor. Measured 2026-08-17: 4.418 files under SCAN_DIRS, 3.045 under
 * BYTE_SCAN_DIRS. The floor sits well below both so ordinary file churn never
 * trips it, and far enough above zero that a broken walk cannot pass as a clean
 * tree. Same correction check-degraded-chrome.ts and check-view-scope.ts carry.
 */
const MIN_FILES_SCANNED = 1500;

/**
 * THE CLOCK, AND WHY EVERY CASE IN THIS FILE NOW CARRIES IT.
 *
 * Each `it` below performs ONE full recursive walk of the repo, reading every
 * matching file synchronously. Measured on an idle machine (2026-08-27):
 * 1.688 ms over CODE_SCAN_DIRS (3.505 files, 26,5 MB) and 1.928 ms over
 * BYTE_SCAN_DIRS (4.153 files, 33,3 MB) — against vitest's DEFAULT of 5.000 ms.
 * That is ~38% of the budget spent before any contention exists, in the "unit"
 * project, which is PARALLEL by design.
 *
 * THIS EXACT DEFECT WAS DIAGNOSED AND FIXED ONCE ALREADY, on 2026-08-25
 * (`4e55e97be`), and the fix landed on ONE of the FIVE cases that need it — the
 * anti-vacuity block below, which got an explicit 20 s budget and a paragraph
 * of measurement justifying it. The other FOUR are the four `it`s in the
 * `describe` immediately below this comment; they were left on the default and
 * timed out in the two full-suite runs of WU-Q-1, both times passing in
 * isolation (14 s for the whole file). That is the same wall-clock signature
 * the earlier commit documented, on the siblings its remedy did not reach.
 *
 * The counts are stated twice in this file and one of them used to be wrong:
 * this paragraph said "four cases" and "the other three" while the block at the
 * bottom said "the four cases above" and "all four". Five cases, four of them
 * up here — the bottom one was right. Corrected 2026-08-27 rather than quietly
 * reworded, in the shape that block already uses for its own error.
 *
 * SO THE FIX IS THE SAME ONE, APPLIED TO THE WHOLE SET rather than to one
 * member of it — which is the failure mode this repo keeps paying for: a remedy
 * applied to the instance that was in front of somebody instead of to the class.
 *
 * NO ASSERTION MOVES. Every case still asserts `toEqual([])` over the same
 * scan, and the anti-vacuity floor below still tells "clean" apart from
 * "blind". Only the clock moves, because the clock was measuring the disk.
 *
 * NOT THE CORPUS GROWING, and the arithmetic is worth keeping: WU-Q-1 added 8
 * files to 4.153 — about 4 ms of the 1.900. If any of these ever times out at
 * 20.000 ms, the walk really is broken and that is worth stopping for.
 */
const SCAN_TIMEOUT_MS = 20_000;

describe("encoding fitness", () => {
  it(
    "no source file contains mojibake or replacement characters",
    () => {
      const { offenders } = scan(SCAN_DIRS, MOJIBAKE);
      expect(offenders, offenders.join("\n")).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    "no code/data file contains a U+00AD soft hyphen",
    () => {
      const { offenders } = scan(CODE_SCAN_DIRS, SOFT_HYPHEN);
      expect(offenders, offenders.join("\n")).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    "no code/test file contains a control character (NUL, BACKSPACE, ESC …)",
    () => {
      // The NUL case is the expensive one: a single U+0000 makes git treat the
      // whole file as BINARY, so it loses its inline diff and its line counts.
      // Two modules shipped that way. TAB/LF/CR are excluded as legitimate text.
      const { offenders } = scan(BYTE_SCAN_DIRS, CONTROL_CHAR);
      expect(
        offenders,
        `Control characters in source. A NUL (U+0000) also makes git treat the file as binary — no diff, no line counts. Use a JSON tuple or an explicit escape instead of a raw control byte.\n${offenders.join("\n")}`,
      ).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    "no code/test file starts with a UTF-8 BOM",
    () => {
      // Leading BOM only. The CSV exporters PREPEND U+FEFF to their OUTPUT on
      // purpose (Excel), which is correct and must not fail here.
      const { offenders } = scan(BYTE_SCAN_DIRS, LEADING_BOM);
      expect(
        offenders,
        `Source files starting with a UTF-8 BOM. Invisible in an editor; enough to break a first-line directive or a naive parser. Re-save as UTF-8 without BOM.\n${offenders.join("\n")}`,
      ).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );
});

describe("encoding fitness — anti-vacuity", () => {
  // Without this block every assertion above is `toEqual([])` over a list that
  // is empty when the scan works AND empty when the scan is broken.
  //
  // AN EXPLICIT TIMEOUT, AND WHY IT IS NOT A WEAKENED ASSERTION
  // -------------------------------------------------------------------------
  // This one case performs THREE full recursive walks of the repo, reading
  // every matching file synchronously — roughly 2.200 files × 3. Measured on an
  // idle machine (2026-08-25): 1.800 ms against vitest's DEFAULT 5.000 ms, i.e.
  // 36% of its budget already spent before any contention. It runs in the
  // "unit" project, which is PARALLEL by design, so ~1.300 other files are
  // doing their own disk I/O at the same time; a 2,8× slowdown is all it takes,
  // and on Windows with a real-time AV scanner that is an ordinary Tuesday. It
  // timed out in four consecutive full-suite runs and passed in isolation every
  // time — the signature of a wall-clock landmine, not of a hang.
  //
  // The ASSERTION is untouched: still `filesScanned >= MIN_FILES_SCANNED`, the
  // floor that tells "clean" apart from "blind". Only the clock moves, because
  // the clock was measuring the disk and not the code.
  //
  // NOT the corpus growing: this budget is deliberately generous enough that a
  // normal week of new files cannot approach it (WU-A added 9 files to ~2.200 —
  // about 7 ms of the 1.800). If this ever times out again at 20.000 ms, the
  // walk really is broken and that is worth stopping for.
  //
  // WHAT THIS PARAGRAPH GOT WRONG, recorded rather than quietly corrected: it
  // was written as if this case were the only one that walks the tree. It is
  // not — the four cases above each walk it once, and they were left on the
  // default 5.000 ms while this one was given room. All four timed out in
  // WU-Q-1's full-suite runs. The remedy is now `SCAN_TIMEOUT_MS`, shared by
  // the whole set; this block keeps its own literal because its budget covers
  // THREE walks rather than one.
  it("actually opens a corpus, in every scan set it judges", () => {
    for (const [name, dirs] of [
      ["SCAN_DIRS", SCAN_DIRS],
      ["CODE_SCAN_DIRS", CODE_SCAN_DIRS],
      ["BYTE_SCAN_DIRS", BYTE_SCAN_DIRS],
    ] as const) {
      const { filesScanned } = scan(dirs, MOJIBAKE);
      expect(
        filesScanned,
        `${name} scanned ${filesScanned} files — the walk is broken or a directory was renamed. This suite cannot pass having judged nothing.`,
      ).toBeGreaterThanOrEqual(MIN_FILES_SCANNED);
    }
  }, 20_000);

  it("every scan directory it names still exists on disk", () => {
    // A stale-baseline failure: rename `src/` and the floor above might still
    // clear on the remaining dirs while one whole tree silently stops being
    // checked. Name each directory so its disappearance is the failure.
    for (const dir of new Set([...SCAN_DIRS, ...BYTE_SCAN_DIRS])) {
      expect(statSync(join(ROOT, dir)).isDirectory(), `${dir} is no longer a directory`).toBe(true);
    }
  });

  it("the patterns it ships really match the bytes they claim to ban", () => {
    // The regexes are written as \\u escapes precisely so no editor can strip
    // the invisible glyph out of them — which means a typo in an escape is
    // invisible too. Pin each against a synthetic offender.
    expect(CONTROL_CHAR.test(`a${String.fromCharCode(0)}b`)).toBe(true); // NUL
    expect(CONTROL_CHAR.test(`a${String.fromCharCode(8)}b`)).toBe(true); // BACKSPACE
    expect(CONTROL_CHAR.test(`a${String.fromCharCode(0x1b)}b`)).toBe(true); // ESC
    expect(CONTROL_CHAR.test(`a${String.fromCharCode(0x7f)}b`)).toBe(true); // DEL
    // …and do NOT ban the three that are legitimate text.
    expect(CONTROL_CHAR.test("a\tb\nc\rd")).toBe(false);

    expect(LEADING_BOM.test(`${String.fromCharCode(0xfeff)}import x`)).toBe(true);
    // A mid-file BOM is the deliberate CSV/Excel marker — never an offender.
    expect(LEADING_BOM.test(`csv,header\n${String.fromCharCode(0xfeff)}row`)).toBe(false);

    expect(SOFT_HYPHEN.test(`Agust${String.fromCharCode(0xad)}in`)).toBe(true);
    expect(SOFT_HYPHEN.test("Agustin")).toBe(false);
  });
});

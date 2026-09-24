// Brand lint fence — two rules, one concern: the name a user reads.
//
//   Rule 1 — brand CASING:   the public brand is spelled "miMAR".
//   Rule 2 — brand IDENTITY: the public brand is the only name that appears.
//
// Rule 1 shipped first (2026-07-18) and was, on its own, not enough. On
// 2026-07-30 the Ley 14.346 denuncia PDF — the document filed with the Unidad
// Fiscal de Maltrato Animal — was found signing itself "Documento generado por
// DIM" three lines under a header reading "miMAR — Mi Mascota Argentina".
// This file already SCANNED that source (the glob covers lib/**), it just had
// no rule for it: it checked HOW the public brand is spelled, never that the
// INTERNAL codename stays internal. Rule 2 is that missing rule.
//
// ---------------------------------------------------------------------------
// RULE 2 — internal codename containment
// ---------------------------------------------------------------------------
//
// THE HARD PART: "DIM" cannot simply be banned. `DIM-PAMP-0001` is a PUBLIC
// credential token, printed on the physical credential, resolved by the QR,
// and typed into the Atender walk-in form by name. Roughly a hundred such
// literals live in seeds, tests and copy — all legitimate.
//
// THE DISTINCTION, and it is structural rather than heuristic: a hyphen.
//
//   DIM-PAMP-0001   token   — the codename is a namespace PREFIX, and the
//                             hyphen is what makes it one. Never flagged.
//   ...-DIM-...     token   — same, mid-token. Never flagged.
//   DIM             codename— a bare word standing in for the product's name.
//                             Flagged.
//
// So Rule 2 matches `DIM` as a standalone word with NO hyphen on either side:
// /(?<!-)\bDIM\b(?!-)/. Word boundaries already spare identifiers, because `_`
// is a word character — `DIM_TOKEN_RE` and `petDimensions` never match. Case
// sensitivity spares "dimension", "dim", and the mimar.com.ar domain.
//
// Across ~1.900 in-scope files this leaves SEVEN hits: four were the real
// leak (three PDF footers plus the MPF "GENERADO POR" fallback, fixed in the
// preceding commit) and three are legitimate, listed below.
//
// THE ESCAPE HATCH: `dim-codename-ok: <reason>` on the offending line, or
// anywhere in the comment block above it. It exempts exactly one line of code,
// so it can never silence a file or a region. Deliberately NOT a numeric
// baseline like Rule 1:
// a count in a JSON file says "three of these are fine" without saying WHICH
// or WHY, and the whole failure mode here was a leak nobody could see. A
// pragma sits at the exception, carries its reason, and `rg dim-codename-ok`
// enumerates every one of them in a second. Three exist today:
//
//   lib/infra/publicToken.ts   — the token prefix itself, at its definition.
//                                This is the one place the bare word IS the
//                                token, and the reason the rule has to be
//                                shaped around a hyphen at all.
//   app/(public)/acerca/page.tsx — deliberate institutional disclosure. The
//                                codename is not a secret; /acerca explains
//                                what it stands for. It just is not the name
//                                the product signs documents with.
//   lib/infra/geocoding.ts     — the Nominatim User-Agent. Machine-to-machine,
//                                no human reader, and the surrounding contact
//                                mailbox is an open PO call already documented
//                                in __tests__/no-personal-contact-in-ui.test.ts.
//                                Rewriting half of it mid-decision is exactly
//                                the drive-by that test warns against. Tracked
//                                here so it resurfaces when the mailbox lands.
//
// ---------------------------------------------------------------------------
// RULE 1 — brand casing (original header follows)
// ---------------------------------------------------------------------------
//
// miMAR recase (PO decision 2026-07-18: canonical
// brand casing is "miMAR", lowercase m, capital M-A-R, matching the landing
// page). Companion sweep: recased ~194 wrong-cased "MiMAR" literals to
// "miMAR" across app/**, components/**, and lib/ui/branding.ts. This fence
// makes it stick — the codebase must never again accumulate wrong-cased
// brand literals in user-visible surfaces.
//
// Ratchet shape mirrors check-professionalism.ts Rule 2 (symbol-as-icon):
// baseline scripts/brand-casing-baseline.json grandfathers a per-file count
// of PRE-EXISTING wrong-cased hits. Any NEW violation (a file exceeding its
// baselined count, or any file not in the baseline at all) fails. The
// baseline starts empty — the recase sweep left zero legitimate wrong-cased
// literals in scope, so today this fence is effectively fail-closed. Only
// regenerate the baseline after a deliberate, reviewed grandfather decision
// (e.g. a formal proper-noun citation that must keep different casing) —
// this is a ratchet, not a snooze button.
//
// What counts as a violation: the standalone word "MiMAR", "Mimar", or
// "MIMAR" (word-boundary matched, case-sensitive) OUTSIDE a comment. Word
// boundaries mean identifiers that merely CONTAIN one of these forms as a
// prefix/substring (e.g. a hypothetical `MiMARBadge` component name) are NOT
// flagged — this fence targets display copy, not code identifiers. Comments
// are skipped (reusing check-professionalism.ts's classifyLine) because they
// never render to a user; a stray wrong-cased mention in a code comment is
// not a display-copy regression.
//
// Deliberately NOT flagged by Rule 1 (by construction — the regex only
// matches the three wrong-cased forms above): the correct "miMAR" casing, and
// technical/lowercase "mimar" (e.g. the mimar.com.ar email domain, the
// logo-mimar-mark.svg asset path, package/slug names). The codename is Rule 2's
// business, not Rule 1's.
//
// Scope (BOTH rules), the glob below verbatim: app/**, components/**, lib/**,
// packages/**, src/**, apps/mobile/app/**, apps/mobile/src/** — .ts/.tsx,
// excluding *.test.*, __tests__/**, *.stories.* (display copy lives in source,
// not in the tests that assert on it). lib/** is where the PDF renderers live;
// the two apps/mobile roots are the Expo client (CA-3, see the glob's note).
//
// Run: pnpm tsx scripts/check-brand-casing.ts
// Or:  pnpm lint:brand
// Rewrite baseline (only after a deliberate, reviewed grandfather decision):
//   pnpm tsx scripts/check-brand-casing.ts --write-baseline
//
// Exits 1 with file:line, the offending literal, and a remedy on each hit.
// Exits 0 if clean.

import { globSync, readFileSync, writeFileSync } from "node:fs";

import { type CommentState, classifyLine } from "./check-professionalism";

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

// THE PHONE APP IS A SURFACE TOO (CA-3, 2026-09-06). The glob named five roots
// and every one of them is the WEB tree: `app/` here is Next.js's route
// directory, not `apps/mobile/app`. So the Expo client — a build that carries
// the brand on its own splash screen — was outside both rules: it could write
// "MiMAR" in a Spanish sentence a person reads, or leak the internal codename
// into UI copy, and nothing in `pnpm verify` would say so. Its two source roots
// are added by name rather than by widening to `apps/**`, because a second app
// arriving is a decision somebody should make here rather than inherit.
const FILES = globSync(
  "{app,components,lib,packages,src,apps/mobile/app,apps/mobile/src}/**/*.{ts,tsx}",
)
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => !isExcluded(f));

// ---------------------------------------------------------------------------
// The wrong-cased brand regex — word-boundary matched, case-sensitive, so it
// never matches the correct "miMAR" casing or lowercase technical "mimar".
// ---------------------------------------------------------------------------

export const WRONG_CASE_BRAND = /\b(MiMAR|Mimar|MIMAR)\b/g;

const REMEDY =
  'canonical brand casing is "miMAR" (lowercase m, capital M-A-R) — recase the literal';

type BrandHit = { line: number; text: string };

/** All wrong-cased brand hits in a file's source, skipping comment lines.
 * Exported for unit tests (drives the ratchet count exactly like the CLI
 * scan). CRLF-safe: splits on \r?\n like check-professionalism.ts. */
export function findBrandHits(src: string): BrandHit[] {
  const hits: BrandHit[] = [];
  let state: CommentState = { inBlock: false };
  src.split(/\r?\n/).forEach((rawLine, i) => {
    const { isComment, nextState } = classifyLine(rawLine, state);
    state = nextState;
    if (isComment) return;
    for (const match of rawLine.matchAll(WRONG_CASE_BRAND)) {
      hits.push({ line: i + 1, text: match[0] });
    }
  });
  return hits;
}

// ---------------------------------------------------------------------------
// Rule 2 — internal codename containment
//
// `DIM` as a standalone word NOT followed by a hyphen. A TRAILING hyphen is
// the whole distinction (see the header): with one it is a `DIM-XXXX-XXXX`
// credential token, which is PUBLIC by design; without one it is the internal
// codename standing in for the product's name.
//
// Only the TRAILING hyphen. This rule first shipped as /(?<!-)\bDIM\b(?!-)/,
// guarding both sides for symmetry — and a surviving mutant asked what the
// leading guard was actually buying. Nothing: the token format is DIM-prefixed,
// so the codename is never a token SUFFIX. What the guard DID buy was a
// false-negative hole, because a preceding hyphen is how the codename gets used
// as a compound word — the repo's own docs say "outside-DIM" and "no-DIM", and
// those are exactly the usages this rule is for. Symmetry was the wrong
// instinct; the asymmetry is the point.
//
// Case-sensitive and word-boundary matched, so "dimension", "dim", "mimar.com.ar"
// and identifiers like `DIM_TOKEN_RE` (underscore is a word character) never
// match.
// ---------------------------------------------------------------------------

export const INTERNAL_CODENAME = /\bDIM\b(?!-)/g;

/**
 * Inline escape hatch. Put it on the offending line, or anywhere in the
 * comment block above it, with a reason. It exempts one line of code.
 * `rg dim-codename-ok` enumerates every exception in the repo.
 */
export const CODENAME_PRAGMA = "dim-codename-ok";

const CODENAME_REMEDY = `the internal codename must not appear in code a user reads — use the public brand "miMAR". If this is a DIM-XXXX-XXXX token prefix or a deliberate disclosure, annotate the line with \`${CODENAME_PRAGMA}: <reason>\``;

/**
 * All internal-codename hits in a file's source.
 *
 * Comment lines are skipped for the same reason Rule 1 skips them: they never
 * render to a user, and the codename is the correct word to use when a comment
 * is talking about the codename.
 *
 * PRAGMA SCOPE — the pragma ARMS an exemption that the next line of real code
 * consumes. Same-line works; so does anywhere inside the comment block above,
 * because a good reason is usually several lines long and pinning it to the
 * single line directly above would push authors toward one-word excuses.
 * Comment and blank lines neither arm nor consume, so the reason can sit at
 * the top of its block. Exactly ONE line of code is exempted per pragma — it
 * cannot silence a file or a region. CRLF-safe.
 */
export function findCodenameHits(src: string): BrandHit[] {
  const hits: BrandHit[] = [];
  let state: CommentState = { inBlock: false };
  let armed = false;

  src.split(/\r?\n/).forEach((rawLine, i) => {
    const { isComment, nextState } = classifyLine(rawLine, state);
    state = nextState;

    if (rawLine.includes(CODENAME_PRAGMA)) {
      armed = true;
      if (isComment) return;
    }
    if (isComment) return;
    if (rawLine.trim() === "") return; // blank: neither arms nor consumes

    if (armed) {
      armed = false; // consumed by this one line of code
      return;
    }

    for (const match of rawLine.matchAll(INTERNAL_CODENAME)) {
      hits.push({ line: i + 1, text: match[0] });
    }
  });
  return hits;
}

// ---------------------------------------------------------------------------
// Baseline — scripts/brand-casing-baseline.json
//
// Shape mirrors check-professionalism.ts Rule 2: a per-file count,
// grandfathered up to that count; any file exceeding it (or any new file not
// listed) fails.
// ---------------------------------------------------------------------------

type BaselineFile = {
  _meta: { totalViolations: number; description: string };
  files: Record<string, number>;
};

const BASELINE_PATH = "scripts/brand-casing-baseline.json";

function loadBaseline(): Record<string, number> {
  try {
    const data = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile;
    return data.files;
  } catch {
    console.warn(
      `[warn] ${BASELINE_PATH} not found — brand-casing will be strict (no grandfather).`,
    );
    return {};
  }
}

function writeBaseline(): void {
  const files: Record<string, number> = {};
  let total = 0;
  for (const file of FILES) {
    const count = findBrandHits(readFileSync(file, "utf8")).length;
    if (count > 0) {
      files[file] = count;
      total += count;
    }
  }
  const output: BaselineFile = {
    _meta: {
      totalViolations: total,
      description:
        'Baseline of wrong-cased brand literals (MiMAR/Mimar/MIMAR) outside comments, in app/**+components/**. Files listed here are grandfathered up to their count. New violations (new files, or counts above these) fail lint:brand. Regenerate only after a deliberate, reviewed grandfather decision — the canonical casing is "miMAR".',
    },
    files,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `Baseline written: ${total} grandfathered brand-casing hit(s) across ${Object.keys(files).length} file(s).`,
  );
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function runScan(): void {
  const baseline = loadBaseline();
  let violatingFiles = 0;
  let grandfathered = 0;
  let codenameHits = 0;
  let codenameFiles = 0;

  for (const file of FILES) {
    const src = readFileSync(file, "utf8");

    // Rule 1 — brand casing (ratcheted against the baseline).
    const hits = findBrandHits(src);
    if (hits.length > 0) {
      const allowed = baseline[file] ?? 0;
      grandfathered += Math.min(hits.length, allowed);
      if (hits.length > allowed) {
        for (const hit of hits) {
          console.error(`${file}:${hit.line}: wrong-cased brand "${hit.text}" — ${REMEDY}`);
        }
        console.error(
          `${file}: ratchet — ${hits.length} brand-casing violation(s) (baseline allows ${allowed}). To grandfather a reviewed exception, run: pnpm tsx scripts/check-brand-casing.ts --write-baseline`,
        );
        violatingFiles += 1;
      }
    }

    // Rule 2 — internal codename containment. Fail-closed, no baseline: the
    // exceptions carry their reason inline via the pragma instead of being
    // reduced to a count in a JSON file.
    const codename = findCodenameHits(src);
    if (codename.length > 0) {
      for (const hit of codename) {
        console.error(`${file}:${hit.line}: internal codename "${hit.text}" — ${CODENAME_REMEDY}`);
      }
      codenameHits += codename.length;
      codenameFiles += 1;
    }
  }

  if (violatingFiles > 0 || codenameFiles > 0) {
    if (violatingFiles > 0) {
      console.error(`\n✗ ${violatingFiles} file(s) with new brand-casing violation(s).`);
    }
    if (codenameFiles > 0) {
      console.error(
        `\n✗ ${codenameHits} internal-codename leak(s) across ${codenameFiles} file(s).`,
      );
    }
    process.exit(1);
  }

  console.log(
    `✓ Brand casing clean — 0 new wrong-cased "MiMAR"/"Mimar"/"MIMAR" literals across ${FILES.length} files.`,
  );
  console.log(
    `  Ratchet: ${grandfathered} grandfathered hit(s) across ${Object.keys(baseline).length} file(s). New ones will fail.`,
  );
  console.log(
    `✓ Brand identity clean — 0 unannotated "DIM" codename literals (DIM-XXXX-XXXX tokens are public and exempt).`,
  );
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-brand-casing.ts") ||
    process.argv[1].endsWith("check-brand-casing.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  if (process.argv.includes("--write-baseline")) {
    writeBaseline();
  } else {
    runScan();
  }
}

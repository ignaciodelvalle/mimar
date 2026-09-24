// C3 fence — ONE VIEWSCOPE (plan-maestro-integridad §C3 / §4 "The fence").
//
// Motivation: the shared /gob and /admin portal layouts render ONCE per
// navigation and have NO access to a page's own searchParams/filter state —
// so any chrome computed there can only ever describe the operator's MANDATE
// (session assignments), never the currently-filtered VIEW. A raw
// `jurisdictions.length` read in one of these files is exactly the class of
// bug that produced the verified S3 symptom: the /gob layout badge rendered
// "1774 LOCALIDADES" while the page itself was filtered to CABA. This linter
// makes that class of drift visible going forward: `lib/ui/scope-chrome.ts`
// (`describeMandate`) is the ONE allowlisted place permitted to turn a raw
// jurisdiction array into a scope claim inside these files.
//
// Scope: a narrow, explicit file list — the two portal layouts that render
// session-wide, page-agnostic chrome. This deliberately does NOT scan every
// page.tsx: a page computing its OWN filtered/resolved view
// (`filteredJurisdictions`, a `ProjectionContext`) is the legitimate owner of
// that computation — that is what `lib/ui/view-scope-caption.ts`
// (`describeNarrowedView`) is for, fed the page's own resolved values. Only
// the session-wide chrome that CANNOT know a page's filter is fenced here
// (mirrors check-scope-discipline.ts's narrow, single-domain scope).
//
// Run: pnpm tsx scripts/check-view-scope.ts   (or: pnpm lint:view-scope)
// Exits 0 clean; exits 1 listing each offending line.

import { readFileSync } from "node:fs";

import { stripComments } from "./check-scope-discipline";

/** The session-wide chrome files fenced against a raw jurisdiction-count read. */
export const VIEW_SCOPE_FILES = ["app/admin/layout.tsx", "app/gob/layout.tsx"] as const;

/** The one allowlisted computation site for a MANDATE claim from raw jurisdictions. */
export const ALLOWLISTED_FILE = "lib/ui/scope-chrome.ts";

// Matches `jurisdictions.length` (any receiver — `session.jurisdictions`,
// `profile.jurisdictions`, a bare destructured `jurisdictions`, …) EXCEPT when
// immediately followed by a comparison operator (`>`, `<`, `>=`, `<=`, `===`,
// `!==`, `==`, `!=`). A comparison is a BRANCH decision ("is there more than
// one? pick a component variant / gate access") — legitimate everywhere and
// already the fence's own precedent (check-authz-guards.ts et al. never flag
// an access gate). What THIS fence forbids is the count flowing into a
// rendered VALUE — a template interpolation, string concatenation, or a
// ternary's textual branch — the exact "1774 LOCALIDADES" shape.
const RAW_JURISDICTION_COUNT_RE =
  /\b(?:[\w.]+\.)?jurisdictions\.length\b(?!\s*(?:===|!==|==|!=|>=|<=|>|<))/;

export type ViewScopeOffense = { file: string; line: number; snippet: string };

// Scans one already-comment-stripped file and returns every offending line.
export function extractOffenses(relPath: string, rawSrc: string): ViewScopeOffense[] {
  const src = stripComments(rawSrc);
  const lines = src.split("\n");
  const offenses: ViewScopeOffense[] = [];

  lines.forEach((lineText, idx) => {
    if (RAW_JURISDICTION_COUNT_RE.test(lineText)) {
      offenses.push({ file: relPath, line: idx + 1, snippet: lineText.trim() });
    }
  });

  return offenses;
}

// ---------------------------------------------------------------------------
// Rule 2 — caption adoption (consistency sweep 2026-07-23).
//
// describeNarrowedView existed for a month wired into exactly ONE of ~15
// narrowing-capable screens — a disclosure mechanism without adoption is not a
// system. Mechanical contract: any non-test .tsx under app/gob or app/admin
// that calls `resolveJurisdictionScope(` (i.e. supports per-page jurisdiction
// narrowing) must also reference `describeNarrowedView` (the C3 caption
// computation), unless listed in CAPTION_EXEMPT with a reason.
// ---------------------------------------------------------------------------

import { globSync } from "node:fs";

/** Screens allowed to narrow without the caption — each with its reason. */
export const CAPTION_EXEMPT: ReadonlyMap<string, string> = new Map([
  ["app/gob/analytics/export/page.tsx", "headless CSV export route — no visual surface"],
  [
    "app/gob/padron/page.tsx",
    "hub chrome only — its tab screens (CensoScreen/PoblacionScreen) carry the caption",
  ],
]);

export function scanCaptionAdoption(): ViewScopeOffense[] {
  const offenses: ViewScopeOffense[] = [];
  const files = globSync("{app/gob,app/admin}/**/*.tsx").filter((f) => {
    const p = f.replaceAll("\\", "/");
    return !p.includes("__tests__/") && !p.endsWith(".test.tsx");
  });
  for (const file of files) {
    const relPath = file.replaceAll("\\", "/");
    if (CAPTION_EXEMPT.has(relPath)) continue;
    const src = stripComments(readFileSync(file, "utf8"));
    if (src.includes("resolveJurisdictionScope(") && !src.includes("describeNarrowedView")) {
      offenses.push({
        file: relPath,
        line: 1,
        snippet: "resolveJurisdictionScope without caption",
      });
    }
  }
  return offenses;
}

function describeOffense(offense: ViewScopeOffense): string {
  return `${offense.file}:${offense.line} — raw jurisdiction-count read outside ${ALLOWLISTED_FILE}: \`${offense.snippet}\`. Shared portal chrome must describe the operator's MANDATE via describeMandate() (${ALLOWLISTED_FILE}) — never a raw jurisdictions.length. That exact class of drift produced the verified "1774 LOCALIDADES" badge over a CABA-filtered view (plan-maestro-integridad §S3). A page describing its OWN filtered view should use describeNarrowedView() (lib/ui/view-scope-caption.ts) instead.`;
}

function runScan(): void {
  const offenders: string[] = [];
  let filesScanned = 0;

  for (const file of VIEW_SCOPE_FILES) {
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      // A portal layout is expected to exist; a missing file is a repo-layout
      // change, not something this fence should hard-fail the whole build over.
      continue;
    }
    filesScanned++;
    for (const offense of extractOffenses(file, src)) {
      offenders.push(describeOffense(offense));
    }
  }

  // Rule 2 — caption adoption.
  for (const offense of scanCaptionAdoption()) {
    offenders.push(
      `${offense.file} — calls resolveJurisdictionScope but never computes describeNarrowedView (lib/ui/view-scope-caption.ts): a screen that narrows below the operator's mandate MUST disclose the narrowed view via <ViewScopeCaption> (C3). Wire it like app/gob/page.tsx, or add the file to CAPTION_EXEMPT in scripts/check-view-scope.ts WITH a reason.`,
    );
  }

  // A scan of ZERO files passes vacuously and prints "✓ clean", which is what a
  // renamed layout looks like from CI. The per-file `catch { continue }` above
  // is the right call for ONE missing file; it is the wrong call for all of
  // them. Rule 1 has to have looked at something to be able to say it is clean.
  if (filesScanned === 0) {
    console.error(
      `✗ view-scope: none of the ${VIEW_SCOPE_FILES.length} registered chrome file(s) could be read — the portal layout was renamed or moved. Update VIEW_SCOPE_FILES in scripts/check-view-scope.ts. This check cannot pass having scanned nothing.`,
    );
    process.exit(1);
  }

  if (offenders.length > 0) {
    console.error(offenders.join("\n"));
    console.error(
      `\n✗ ${offenders.length} view-scope violation(s) (${filesScanned} chrome files scanned).`,
    );
    process.exit(1);
  }

  console.log(
    `✓ view-scope discipline clean — ${filesScanned} chrome files + caption adoption scanned.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-view-scope.ts") ||
    process.argv[1].endsWith("check-view-scope.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}

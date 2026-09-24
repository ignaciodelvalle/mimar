// Hard-nav anchor fence — anonymous one-shot public CTAs must be plain <a>.
//
// The lost-credential finder actions (`/p/[token]/encontre` "La tengo conmigo"
// and `/p/[token]/sighting` "La vi cerca de acá") are entered by an anonymous
// finder with no client state worth preserving. A next/link <Link> makes them a
// SOFT client navigation, which QA repeatedly caught stalling 2-4s and missing
// keyboard-Enter activation on the crisis path; a plain <a> hard-navigates and
// renders the server form instantly (see the "Plain anchors ON PURPOSE" note in
// components/pet-profile/PublicLostSections.tsx, generalizing fix d8300329).
//
// RULE: within app/(public)/** and components/pet-profile/**, a next/link <Link>
// whose href targets a one-shot finder route (/encontre or /sighting) is banned —
// use a plain <a href>. The two route segments are the real finder routes; add a
// segment here if a new one-shot anonymous action is introduced.
//
// Enforcement: hard ban, per-file allowlist (there is no legitimate soft-nav to
// these routes today, so the allowlist is empty). Detection spans the <Link>
// opening tag (props may wrap across lines) up to the href value; a <Link> with a
// DYNAMIC href expression that can't be read statically is not matched (it is not
// a static one-shot prefix), matching the spec's "static href" scope.
//
// Run: pnpm tsx scripts/check-hard-nav-anchors.ts
// Or:  pnpm lint:hard-nav
//
// Exits 1 with file:line on each banned <Link>. Exits 0 if clean.

import { globSync, readFileSync } from "node:fs";

// One-shot anonymous finder route segments (derived from the real routes
// /p/[token]/encontre and /p/[token]/sighting).
export const ONESHOT_ROUTE_SEGMENTS = ["encontre", "sighting"] as const;

// A next/link <Link …> whose (possibly multi-line) opening tag carries an href
// string reaching a one-shot segment. `[^>]*` (negated-> spans newlines) covers
// wrapped props; the href value opens with a quote (`"' or backtick) and the
// chars up to the segment carry no quote/>. The `g` flag drives per-match report.
const HREF_OPEN_QUOTE = "[`\"']"; // opening quote of the href value
const HREF_UP_TO_SEGMENT = "[^`\"'>]*"; // href chars before the route segment
export const HARD_NAV_LINK = new RegExp(
  `<Link\\b[^>]*\\bhref=\\s*\\{?${HREF_OPEN_QUOTE}${HREF_UP_TO_SEGMENT}\\/(${ONESHOT_ROUTE_SEGMENTS.join("|")})\\b`,
  "g",
);

// Directories whose files are in scope (repo-relative, forward slashes).
const SCOPE_PREFIXES = ["app/(public)/", "components/pet-profile/"];

// Per-file allowlist ("relativePath") for a reviewed, intentional soft-nav.
export const HARD_NAV_ALLOWLIST = new Set<string>([
  // (empty — every finder CTA today is a plain <a>, on purpose)
]);

const FILES = globSync("{app,components}/**/*.tsx")
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => SCOPE_PREFIXES.some((p) => f.startsWith(p)));

function runScan(): void {
  let hits = 0;

  for (const relPath of FILES) {
    if (HARD_NAV_ALLOWLIST.has(relPath)) continue;
    const content = readFileSync(relPath, "utf8");
    HARD_NAV_LINK.lastIndex = 0;
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop.
    while ((match = HARD_NAV_LINK.exec(content)) !== null) {
      const lineNo = content.slice(0, match.index).split(/\r?\n/).length;
      const segment = match[1];
      console.error(
        `${relPath}:${lineNo}: next/link <Link> targets the one-shot finder route "/${segment}" — use a plain <a href> so the anonymous finder hard-navigates (soft nav stalls the crisis path; see PublicLostSections).`,
      );
      hits += 1;
    }
  }

  if (hits > 0) {
    console.error(`\n✗ ${hits} soft-nav <Link> to a one-shot finder route.`);
    process.exit(1);
  }
  console.log(
    `✓ Hard-nav anchors clean — no next/link <Link> to /encontre or /sighting across ${FILES.length} public/pet-profile file(s).`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-hard-nav-anchors.ts") ||
    process.argv[1].endsWith("check-hard-nav-anchors.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}

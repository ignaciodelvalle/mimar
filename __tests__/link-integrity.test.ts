/**
 * Link-integrity guard test
 *
 * Deterministic, no-DB, no-network.
 *
 * WHAT IT DOES
 * ─────────────
 * 1. Builds a route map by walking app/ for page.tsx + route.ts files.
 *    - Strips the leading "app/" prefix.
 *    - Strips route-group segments (parenthesised, e.g. "(public)", "(app)").
 *    - Strips the trailing "/page.tsx" or "/route.ts" filename.
 *    - Converts [...segment] → "**" (catch-all) and [segment] → "*" (dynamic).
 *
 * 2. Collects every STATIC internal link path from:
 *    - components/layout/nav-presets.ts  → PUBLIC_NAV, OWNER_NAV, GOB_NAV,
 *                                          ADMIN_NAV, buildOrgNav (placeholder token)
 *    - components/layout/AppFooter.tsx   → DEFAULT_COLUMNS constant
 *    - lib/event-capture-registry.ts     → entries whose route starts with "/"
 *                                          (prefixed with /mis-mascotas/[token])
 *    - Regex scan of href="/…" string literals across app/ and components/
 *
 * 3. SKIPS:
 *    - External URLs (http:// / https://)
 *    - Template-literal hrefs (dynamic — cannot be statically resolved)
 *    - ?sheet= param-only links (SheetMounter sheets — no dedicated page.tsx)
 *    - /api/* routes
 *    - Dev-only pages: /design, /design/dashboards
 *    - mailto: / tel: schemes
 *    - Query-string suffixes (stripped before resolution)
 *
 * 4. RESOLVES a link against the route map:
 *    - Exact match wins.
 *    - Dynamic patterns: * matches a single path segment ([^/?]+),
 *      ** matches any path (catch-all, [^?]+).
 *    - Root "/" resolves against the top-level app/page.tsx pattern.
 *
 * 5. ASSERTS every collected link resolves; failure message names the dead link.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// ─── 1. Build route map ──────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, "..");
const APP_DIR = path.join(REPO_ROOT, "app");

/**
 * Walk a directory recursively and call collect() for every file.
 */
function walkDir(dir: string, collect: (filePath: string) => void): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, collect);
    } else if (entry.isFile()) {
      collect(full);
    }
  }
}

/**
 * Convert a filesystem path under app/ to a URL pattern string.
 *
 * Steps:
 *   1. Make relative to app/, normalise separators to "/".
 *   2. Strip trailing "/page.tsx" or "/route.ts".
 *   3. Remove route-group segments: segments matching /^\([^)]+\)$/.
 *   4. Replace [...segment] with "**" and [segment] with "*".
 *   5. Prepend "/" to form a URL-like pattern.
 *
 * Root page.tsx → "/" (the root route).
 */
function filePathToRoutePattern(absolutePath: string): string {
  // Relative to app/, forward-slashes.
  let rel = path.relative(APP_DIR, absolutePath).replace(/\\/g, "/");

  // Strip the filename.
  // Two cases:
  //   a) "some/dir/page.tsx"  → strip "/page.tsx"  → "some/dir"
  //   b) "page.tsx"           → root page, no leading slash; strip directly → ""
  if (rel === "page.tsx" || rel === "route.ts") {
    rel = "";
  } else {
    rel = rel.replace(/\/(page\.tsx|route\.ts)$/, "");
  }

  // Split into segments, drop route-group segments (e.g. "(public)", "(app)").
  const segments = rel.split("/").filter((seg) => !/^\([^)]+\)$/.test(seg));

  // Replace Next.js dynamic segment syntax.
  const normalised = segments.map((seg) => {
    if (/^\[\.{3}[^\]]+\]$/.test(seg)) return "**"; // [...catchAll]
    if (/^\[[^\]]+\]$/.test(seg)) return "*"; // [dynamic]
    return seg;
  });

  const joined = normalised.join("/");
  return joined === "" ? "/" : `/${joined}`;
}

// Collect all page.tsx and route.ts → route patterns.
const routePatterns = new Set<string>();

walkDir(APP_DIR, (filePath) => {
  const name = path.basename(filePath);
  if (name === "page.tsx" || name === "route.ts") {
    routePatterns.add(filePathToRoutePattern(filePath));
  }
});

// ─── 2. Resolve a link path against the route map ────────────────────────────

/**
 * Compile a route pattern to a regex for matching.
 *   *  → matches a single non-slash, non-query segment  ([^/?]+)
 *   ** → matches any non-empty path                      ([^?]+)
 */
function patternToRegex(pattern: string): RegExp {
  // Build the regex in two passes:
  //   1. Escape all regex metacharacters EXCEPT `*` (we handle it ourselves).
  //   2. Replace `**` with a catch-all token, then `*` with a single-segment token.
  //
  // Important: do NOT include `*` in the escape set — we need it unescaped so we
  // can match on it literally in step 2.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex metacharacters (not *)
    .replace(/\*\*/g, "[^?]+") // ** → any path (catch-all, no query string)
    .replace(/\*/g, "[^/?]+"); // * → single non-slash segment
  return new RegExp(`^${escaped}$`);
}

const compiledPatterns: Array<{ pattern: string; regex: RegExp }> = [];
for (const p of routePatterns) {
  compiledPatterns.push({ pattern: p, regex: patternToRegex(p) });
}

/**
 * Strip query-string AND hash-fragment from a path before resolution.
 * Routing is based purely on the path component; neither params (?…) nor
 * same-page anchors (#…) affect which page.tsx resolves — e.g. the home
 * capture deep-link "/inicio#asentar" resolves via "/inicio".
 */
function stripQuery(href: string): string {
  return href.split(/[?#]/)[0] ?? href;
}

function resolves(href: string): boolean {
  const clean = stripQuery(href);
  // Exact match first (fastest path).
  if (routePatterns.has(clean)) return true;
  // Pattern match (handles dynamic segments like [publicToken]).
  return compiledPatterns.some(({ regex }) => regex.test(clean));
}

// ─── 3. Collect static link sources ──────────────────────────────────────────

/**
 * Skip rules applied before resolution.
 * Add entries here when a link is intentionally unresolvable as a static page.
 */
function shouldSkip(href: string): boolean {
  // Anchor-only / deferred-nav sentinels (e.g. #defer-control-poblacional): client
  // anchors, never a page route. Includes the `deferred` NavItem affordance
  // (plan dim-interno:docs/superpowers-private/plans/archive/2026-06-23-population-cycle-deferred-nav-handoff.md) whose #defer-… hrefs
  // are intentionally unresolvable.
  if (href.startsWith("#")) return true;
  // External URLs.
  if (href.startsWith("http://") || href.startsWith("https://")) return true;
  // Non-HTTP schemes.
  if (href.startsWith("mailto:") || href.startsWith("tel:")) return true;
  // API routes — tested by their own unit/integration tests.
  if (href.startsWith("/api/")) return true;
  // SheetMounter sheets: ?sheet=foo params open a drawer, not a separate page.
  if (href.startsWith("?sheet=")) return true;
  // Dev-only design sandbox pages (no production page.tsx under these paths).
  if (href === "/design" || href === "/design/dashboards") return true;
  return false;
}

// ─── Source 1: nav-presets.ts — PUBLIC_NAV, OWNER_NAV, GOB_NAV, ADMIN_NAV ───

const NAV_PRESETS_PATH = path.join(REPO_ROOT, "components/layout/nav-presets.ts");
const navPresetsSource = fs.readFileSync(NAV_PRESETS_PATH, "utf8");

/**
 * Extract every quoted href value from a TypeScript source string.
 * Matches href: "/path" or href: '/path' (static strings only).
 * Template literals are intentionally skipped — they are dynamic.
 */
function extractQuotedHrefs(src: string): string[] {
  // Matches href: "/path" or href: '/path' (static strings only).
  return Array.from(src.matchAll(/\bhref\s*:\s*["']([^"'`\n]+)["']/g), (m) => m[1] as string);
}

const navPresetsHrefs = extractQuotedHrefs(navPresetsSource);

// buildOrgNav uses template literals: href: `/org/${orgToken}/agenda`.
// We substitute a static placeholder to convert them to checkable paths
// like "/org/PLACEHOLDER/agenda", which resolve via the /org/* pattern.
function extractOrgNavHrefs(src: string): string[] {
  // Template literals: href: `/org/${orgToken}/agenda` → substitute ${orgToken} with a
  // static placeholder so the path resolves via the /org/* pattern in the route map.
  return Array.from(src.matchAll(/\bhref\s*:\s*`([^`\n]+)`/g), (m) =>
    (m[1] as string).replace(/\$\{orgToken\}/g, "PLACEHOLDER"),
  );
}

const orgNavHrefs = extractOrgNavHrefs(navPresetsSource);

// ─── Source 2: AppFooter.tsx DEFAULT_COLUMNS ─────────────────────────────────
// Note: AppHeader (DEFAULT_NAV) was deleted in Item 7 Phase D. Its links
// (/adoptar, /denuncias) are already covered by Source 5 (regex scan of app/).

const APP_FOOTER_PATH = path.join(REPO_ROOT, "components/layout/AppFooter.tsx");
const appFooterHrefs = extractQuotedHrefs(fs.readFileSync(APP_FOOTER_PATH, "utf8"));

// ─── Source 4: event-capture-registry.ts — full-page routes ──────────────────
//
// Routes in the registry are relative to /mis-mascotas/{publicToken}.
// Only entries whose route starts with "/" are full-page routes.
// Routes starting with "?" are SheetMounter sheets — no dedicated page.tsx.

const EVENT_REGISTRY_PATH = path.join(REPO_ROOT, "lib/events/event-capture-registry.ts");
const eventRegistrySource = fs.readFileSync(EVENT_REGISTRY_PATH, "utf8");

// Routes starting with "/" are full-page routes; prefix with /mis-mascotas/*
// to form the canonical URL pattern. Routes starting with "?" are SheetMounter
// sheets (no dedicated page.tsx) — already covered by shouldSkip().
const eventCaptureHrefs: string[] = Array.from(
  eventRegistrySource.matchAll(/\broute\s*:\s*["']([^"'`\n]+)["']/g),
  (m) => m[1] as string,
)
  .filter((route) => route.startsWith("/"))
  .map((route) => `/mis-mascotas/*${route}`);

// ─── Source 5: Regex scan of href="/…" string literals across app/ + components/ ──
//
// Catches any static href not already covered by the structured nav sources above.

// `src/` is here because leaving it out cost the guard a real catch: on
// 2026-08-01 `src/modules/cases/domain/case-kinds.ts` carried a dead
// `/gob/disputas` in ROUTED_ELSEWHERE_DESTINATION. It had no consumers that
// day, so nothing broke — but the guard could never have caught the day one
// appeared, because domain modules were simply outside its field of view.
// A route literal is a route literal wherever it is declared; the layer it
// lives in says nothing about whether it resolves.
const SCAN_DIRS = [
  path.join(REPO_ROOT, "app"),
  path.join(REPO_ROOT, "components"),
  path.join(REPO_ROOT, "src"),
];

const scannedHrefs: string[] = [];

for (const scanDir of SCAN_DIRS) {
  walkDir(scanDir, (filePath) => {
    if (!/\.(tsx|ts|jsx|js)$/.test(filePath)) return;
    // Test files are not shipped surfaces, and scanning them makes this fence
    // react to PROSE ABOUT a link instead of the link. Concretely: on
    // 2026-08-01 `OrgSetupChecklist.test.tsx` gained
    // `expect(html).not.toContain("/org/ORG-TEST/null")` — an assertion that
    // exists to prove that dead href is never rendered — and this scan
    // collected the string out of the assertion and reported it as a dead
    // link. The fence failed BECAUSE the guard was tested.
    //
    // Third instance of this shape in one day: the raw-<button> ratchet counted
    // the tag inside comments, and a CSS review counted a comment reading
    // "computed font-size is below 16px" as one of the raw font-sizes it was
    // measuring. An instrument that reads text about the defect is measuring
    // the documentation, not the code.
    if (/\.(test|spec)\.(tsx|ts|jsx|js)$/.test(filePath)) return;
    const src = fs.readFileSync(filePath, "utf8");
    // matchAll requires a new regex instance (or a stateless literal) each call.
    // TWO forms, and the second is why this scan reaches src/ at all:
    //   href="/path"   — the JSX attribute. Almost everything in app/ and
    //                    components/ is written this way.
    //   href: "/path"  — the object-literal property. Domain modules declare
    //                    routes as DATA (nav presets, destination maps), never
    //                    as JSX, so an attribute-only pattern is blind to them.
    //
    // Adding src/ to SCAN_DIRS without this second form was inert, and I nearly
    // shipped it that way: the probe landed, the guard stayed green, and a
    // widened directory looked like coverage it did not have. Same shape as the
    // defects this whole sweep has been chasing — a check that passes without
    // checking. Verified by probe: `href: "/gob/no-existe-esta-ruta"` in a src/
    // module now fails this suite.
    for (const m of src.matchAll(/\bhref="(\/[^"]+)"/g)) {
      scannedHrefs.push(m[1] as string);
    }
    for (const m of src.matchAll(/\bhref\s*:\s*["'](\/[^"'`\n]+)["']/g)) {
      scannedHrefs.push(m[1] as string);
    }
  });
}

// ─── Merge and deduplicate all collected hrefs ────────────────────────────────

const allCollectedHrefs = [
  ...navPresetsHrefs,
  ...orgNavHrefs,
  ...appFooterHrefs,
  ...eventCaptureHrefs,
  ...scannedHrefs,
];

const uniqueHrefs = [...new Set(allCollectedHrefs)].filter((h) => !shouldSkip(h));

// ─── 4. Tests ─────────────────────────────────────────────────────────────────

describe("link-integrity: every static internal link resolves to a real route", () => {
  it("route map contains at least 50 entries (sanity check)", () => {
    expect(routePatterns.size).toBeGreaterThanOrEqual(50);
  });

  it("collects links from all expected sources (sanity check)", () => {
    expect(navPresetsHrefs.length).toBeGreaterThan(0);
    expect(orgNavHrefs.length).toBeGreaterThan(0);
    // AppHeader (DEFAULT_NAV) deleted in Item 7 Phase D; links covered by scannedHrefs.
    expect(appFooterHrefs.length).toBeGreaterThan(0);
    expect(eventCaptureHrefs.length).toBeGreaterThan(0);
    expect(scannedHrefs.length).toBeGreaterThan(0);
  });

  it("/denuncias resolves — regression guard for the hub page added in-flight", () => {
    // The only confirmed dead link from the 2026-06 dead-end audit.
    // The hub lives at app/(public)/denuncias/page.tsx.
    // This assertion must remain green forever after.
    expect(resolves("/denuncias")).toBe(true);
  });

  it("each nav-preset export contributes known hrefs (source-coverage guard)", () => {
    // If a nav export is renamed, this catches it before the main assertion.
    expect(navPresetsHrefs).toContain("/adoptar"); // PUBLIC_NAV
    // OWNER_NAV no longer contains /inicio (PO ronda 4 removed the Inicio tab;
    // the route itself survives as a redirect) — Mis mascotas is its anchor.
    expect(navPresetsHrefs).toContain("/mis-mascotas"); // OWNER_NAV
    expect(navPresetsHrefs).toContain("/gob"); // GOB_NAV
    // F3+F7 fusion (2026-07-22): RUPGA's own nav entry is gone (absorbed
    // into the Directorio hub as the "credenciales" tab) — Directorio is the
    // new coverage anchor for this source-coverage guard.
    expect(navPresetsHrefs).toContain("/gob/directorio"); // GOB_NAV — Directorio hub
    expect(navPresetsHrefs).toContain("/admin"); // ADMIN_NAV
  });

  /**
   * Core assertion — every static internal link must point to a real route.
   *
   * If this test fails, the failure message lists the dead link(s). Fix by:
   *   a) Creating the missing page.tsx / route.ts, OR
   *   b) Fixing the link to point to an existing route, OR
   *   c) Adding the path to shouldSkip() above with a comment explaining why
   *      it is intentionally unresolvable (e.g. redirect-only, future route).
   */
  it("every collected static link resolves to a real route", () => {
    const deadLinks: string[] = [];

    for (const href of uniqueHrefs) {
      if (!resolves(href)) {
        deadLinks.push(href);
      }
    }

    expect(
      deadLinks,
      `Dead links found (${deadLinks.length}):\n${deadLinks.map((l) => `  • ${l}`).join("\n")}\n\nFor each dead link above:\n  - Fix the href to point to an existing route, OR\n  - Create the missing page.tsx, OR\n  - Add it to shouldSkip() in __tests__/link-integrity.test.ts with a comment.`,
    ).toEqual([]);
  });
});

// ─── 5. Bounce guard: no UI link may target a redirect-only route ────────────
//
// WHY THIS EXISTS (added 2026-08-01 with the F9 fusion, by a mutation test that
// SURVIVED). The assertion above only asks "does this route exist?". After six
// hub fusions, plenty of routes exist purely to bounce: /gob/analytics,
// /gob/poblacion, /gob/censo, /gob/campanas, /gob/disputas, /admin/moderacion
// and a dozen more are one-line `redirect(...)` shims kept alive for old
// bookmarks. They RESOLVE, so the dead-link fence is happy — and a UI link
// aimed at one sails straight through it.
//
// That gap was measured, not assumed. Reverting one of F9's four re-pointed KPI
// tiles on /gob back to `href="/gob/analytics"` — the exact defect F9 was
// commissioned to remove — left 2200 tests across 194 files green. Nothing in
// the suite could tell the difference between a link to a screen and a link to
// a bounce.
//
// A redirect is the right answer for a URL someone SAVED. It is the wrong
// answer for a link we are rendering right now: we know the destination at
// build time, so shipping the extra hop is a choice, and the hop is where the
// F8-era "wait, why am I back where I started?" confusion comes from.
//
// SCOPE: static `href="/…"` literals in shipped app/ + components/ files. Test
// files are excluded for the same reason the scan above excludes them — an
// instrument that reads prose ABOUT a link measures the documentation, not the
// code. Template-literal hrefs are invisible here (as everywhere in this file),
// and only STATIC redirect-only routes are matched; a dynamic one
// (/gob/decomisos/[publicCode]) is only ever reachable through a template
// literal, so it could not be checked anyway.

/**
 * A page.tsx is "redirect-only" when it imports `redirect` from next/navigation,
 * calls it, and never returns JSX. Comments are stripped first so a page that
 * merely DISCUSSES a redirect is not miscounted.
 *
 * The JSX test is `return` followed by `(` or `<` — deliberately not a bare
 * `<[A-Za-z]` scan, which the first draft of this guard used and which matched
 * the generic parameters in `Promise<Record<string, string | undefined>>`,
 * silently classifying every modern redirect page as "renders JSX" and finding
 * zero routes.
 */
function isRedirectOnlyPage(absolutePath: string): boolean {
  const body = fs
    .readFileSync(absolutePath, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  if (!/from "next\/navigation"/.test(body)) return false;
  if (!/\bredirect\(/.test(body)) return false;
  return !/return\s*[(<]/.test(body);
}

const redirectOnlyRoutes = new Set<string>();
walkDir(APP_DIR, (filePath) => {
  if (!/[\\/]page\.tsx$/.test(filePath)) return;
  if (!isRedirectOnlyPage(filePath)) return;
  const pattern = filePathToRoutePattern(filePath);
  // Dynamic patterns are unreachable from a static href — see SCOPE above.
  if (pattern.includes("*")) return;
  redirectOnlyRoutes.add(pattern);
});

/**
 * Links allowed to point at a redirect-only route.
 *
 * Every entry states what it is. The two KNOWN DEFECT entries this guard found
 * on its first run (/gob/disputas from CasosScreen's subtitle, /admin/moderacion
 * from the QueueHealthCockpit tile) are GONE — both links now address their real
 * destination, so the excuses went with them (2026-08-01).
 *
 * What survives is exceptions, not to-dos: a hop that is deliberately wanted.
 * Keep it that way — an entry whose reason reads "not fixed here" is a defect
 * wearing an allowlist, and the ratchet only means something if that stays rare.
 */
const REDIRECT_LINK_ALLOWLIST: Record<string, string> = {
  "/inicio":
    "INTENTIONAL (PO ronda 4, see OWNER_NAV in nav-presets.ts). /inicio deliberately survives as the post-login LANDING that resolves the most-urgent pet and forwards its query string. The '← Inicio' back-link in app/(app)/denuncias/mias/page.tsx is aiming at that landing behaviour on purpose, not at a stale screen.",
  "/admin/moderacion":
    "NAV ENTRY ONLY (the QueueHealthCockpit tile that used to hide behind this entry now links /gob/denuncias?etapa=moderacion directly). The remaining holder is the ADMIN_NAV 'Moderación' item in nav-presets.ts, which keeps href=/admin/moderacion because matchPrefix=/admin/moderacion is what highlights the rail on the [id] DETAIL routes that genuinely still live under /admin/moderacion/. Pointing the nav href at /gob/denuncias would break that highlight for the exact routes the entry exists to serve. The documented fase-3 cleanup (see the comment on that nav item) is a thin admin-scoped hub stub — at which point this entry goes too.",
};

describe("link-integrity: no shipped link points at a redirect-only route", () => {
  it("finds the redirect-only routes at all (guard the guard)", () => {
    // Without this, a broken detector makes every assertion below vacuously
    // green — exactly how the first draft of this guard reported "0 violations"
    // while missing all 30 redirect routes.
    expect(redirectOnlyRoutes.size).toBeGreaterThanOrEqual(20);
    expect(redirectOnlyRoutes).toContain("/gob/analytics");
    expect(redirectOnlyRoutes).toContain("/gob/analitica");
  });

  it("every allowlist entry still names a redirect-only route (no stale grandfathering)", () => {
    // When a grandfathered route stops being a redirect (someone gives it a
    // real page again, or deletes it), its excuse must go too.
    for (const route of Object.keys(REDIRECT_LINK_ALLOWLIST)) {
      expect(
        redirectOnlyRoutes,
        `${route} is allowlisted but is no longer redirect-only`,
      ).toContain(route);
    }
  });

  it("no static href in app/ or components/ targets a redirect-only route", () => {
    const bounces: string[] = [];

    for (const scanDir of SCAN_DIRS) {
      walkDir(scanDir, (filePath) => {
        if (!/\.(tsx|ts|jsx|js)$/.test(filePath)) return;
        if (/\.(test|spec)\.(tsx|ts|jsx|js)$/.test(filePath)) return;
        const src = fs
          .readFileSync(filePath, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^[ \t]*\/\/.*$/gm, "");
        for (const m of src.matchAll(/\bhref="(\/[^"]+)"/g)) {
          const raw = m[1] as string;
          const routePath = (raw.split("?")[0] as string).split("#")[0] as string;
          if (!redirectOnlyRoutes.has(routePath)) continue;
          if (REDIRECT_LINK_ALLOWLIST[routePath]) continue;
          const line = src.slice(0, m.index).split("\n").length;
          const rel = path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");
          bounces.push(`${rel}:${line} → ${raw}`);
        }
      });
    }

    expect(
      bounces,
      `Links to redirect-only routes (${bounces.length}):\n${bounces
        .map((b) => `  • ${b}`)
        .join(
          "\n",
        )}\n\nEach one costs the visitor a hop we could have skipped. Fix by:\n  - Pointing the href at the real destination the redirect resolves to, OR\n  - Adding the route to REDIRECT_LINK_ALLOWLIST with a reason that says WHY the hop is wanted.`,
    ).toEqual([]);
  });

  it("no nav entry points at a redirect-only route", () => {
    // The worst instance of this shape, and the one F9 removed: a nav item
    // whose only job is to bounce. Nav hrefs come from the structured presets,
    // not the text scan, so they need their own pass.
    const navBounces = navPresetsHrefs.filter(
      (href) =>
        redirectOnlyRoutes.has((href.split("?")[0] as string).split("#")[0] as string) &&
        !REDIRECT_LINK_ALLOWLIST[(href.split("?")[0] as string).split("#")[0] as string],
    );
    expect(navBounces).toEqual([]);
  });
});

// ─── Source: ctaUrl destinations built in analytics / domain modules ─────────
//
// WHY THIS BLOCK EXISTS — A BUTTON THAT 404s ON THE OWNER'S OWN DASHBOARD
//
// `lib/analytics/owner-dashboard.ts` built two workflow cards whose `ctaUrl`
// pointed at `/cuenta/aprobaciones/{token}` — a route that has NEVER existed.
// Every applicant with a pending or decided approval request (a vet role
// upgrade, an org verification, a jurisdiction grant) saw a card about their
// own request with a button that dead-ended in a 404. Found on staging
// 2026-08-18 by crawling the org portal, not by any test.
//
// The fence above was already scanning nav presets and JSX `href=` literals —
// and it passed, because these destinations are assembled as `ctaUrl` VALUES in
// a lib module and rendered generically by CasesWidget / NotificationCard. The
// link map knew every route; nothing compared these strings against it. Same
// shape as the rest of this codebase's fence failures: the guard covered the
// place the last bug was found in, not the concept.
//
// Template literals are normalised by replacing every `${…}` with a dummy
// segment, so a dynamic destination is checked against the route PATTERN — the
// same way `resolves()` already handles `[publicToken]`.
describe("link integrity — ctaUrl destinations resolve to a real route", () => {
  const CTA_SOURCE_DIRS = ["lib", "src"];

  /** Every `ctaUrl:` value in the scanned tree, with its file and line. */
  function collectCtaUrls(): Array<{ where: string; raw: string; probe: string }> {
    const found: Array<{ where: string; raw: string; probe: string }> = [];
    for (const dir of CTA_SOURCE_DIRS) {
      walkDir(path.join(REPO_ROOT, dir), (filePath) => {
        if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) return;
        if (filePath.includes(".test.")) return;
        const src = fs.readFileSync(filePath, "utf8");
        src.split("\n").forEach((line, i) => {
          const m = line.match(/ctaUrl:\s*(["'`])([^"'`]+)\1/);
          if (!m) return;
          const raw = m[2] as string;
          if (!raw.startsWith("/")) return; // relative/dynamic-only, not a route claim
          found.push({
            where: `${path.relative(REPO_ROOT, filePath).replaceAll("\\", "/")}:${i + 1}`,
            raw,
            // `${expr}` → a dummy segment so the dynamic form is matched
            // against the route pattern rather than treated as a literal.
            probe: raw.replace(/\$\{[^}]*\}/g, "x"),
          });
        });
      });
    }
    return found;
  }

  it("finds the ctaUrl call sites at all", () => {
    // NON-VACUITY. A regex that stops matching would turn the assertion below
    // into a pass over an empty list — the exact failure this file keeps
    // catching elsewhere.
    expect(collectCtaUrls().length).toBeGreaterThan(5);
  });

  it("every ctaUrl points at a route that exists", () => {
    const rotos = collectCtaUrls()
      .filter(({ probe }) => !shouldSkip(probe) && !resolves(probe))
      .map(({ where, raw }) => `${where} → ${raw}`);

    expect(
      rotos,
      `ctaUrl destinations with no matching route (${rotos.length}):\n${rotos
        .map((r) => `  • ${r}`)
        .join("\n")}\n\nEach one is a button a real person can press that lands on a 404.`,
    ).toEqual([]);
  });
});

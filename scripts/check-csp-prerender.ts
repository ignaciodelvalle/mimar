// CSP × prerender fence — the third instance must not exist.
//
// THE MECHANISM
// ---------------------------------------------------------------------------
// middleware.ts mints a CSP nonce PER REQUEST, and the policy carries
// `'strict-dynamic'`. That combination is deliberate and good: with
// strict-dynamic a browser IGNORES `'self'` and host allowlists for scripts and
// executes only what carries the nonce.
//
// It also means a PRERENDERED page cannot work. Its HTML is written at build
// time, before any request exists, so its <script> tags carry no nonce — and in
// production every one of them is refused. The page still renders (the SSR
// markup is in the HTML) and then arrives dead: no hydration, no error
// boundaries, a wall of red in the console.
//
// WHY A FENCE
// ---------------------------------------------------------------------------
// This was found twice. First on the 404 (external review C3-P1: 13 refused
// chunks per load, and its one working link worked by accident because it is a
// plain <a>). The write-up predicted the shape of the next one: "cualquier ruta
// pública que hoy o mañana se prerenderice muere igual". It was right within the
// week — `/recuperar`, the password-recovery flow, reached by people who are
// already frustrated (X1-F2).
//
// Both were fixed with `export const dynamic = "force-dynamic"`. Nothing stopped
// a third: adding a page with no dynamic declaration is the DEFAULT, and the
// failure is invisible in dev (dev has no prerender) and invisible in the build
// log unless you know that `○` is fatal here.
//
// WHAT IT CHECKS
// Any prerendered HTML under .next/server/app is a violation, because under
// this CSP there is no such thing as a working static page. If a route must be
// static, the policy has to change first — and that is a decision, not an
// oversight.
//
// Run:  pnpm tsx scripts/check-csp-prerender.ts   (or: pnpm lint:csp-prerender)
//       pnpm lint:csp-prerender --require-build   (CI, where the build precedes)
//
// Requires a build. Skips loudly without one, because a build-less box is not a
// failure and a developer should not be blocked by it. With --require-build the
// same state is exit 1 instead: in CI the build ALWAYS precedes this step, so a
// missing directory does not mean "no build here", it means the ordering broke.
// That is not hypothetical. Its twin, check-route-weight, spent months in a
// pre-build lint step printing its own skip and exiting 0 while lint:ci-parity
// certified it as covered, because that fence matches a literal token and has no
// notion of step ordering.

import { existsSync, readFileSync } from "node:fs";
import { globSync } from "node:fs";

export const BUILD_APP_DIR = ".next/server/app";
export const MIDDLEWARE_PATH = "middleware.ts";

/**
 * True when the middleware's CSP makes prerendered pages unusable: a
 * per-request nonce in script-src, plus 'strict-dynamic' to close the
 * `'self'` escape hatch.
 */
export function cspBreaksPrerenders(middlewareSource: string): boolean {
  // Matched on ONE line and tolerant of quotes: the policy reads
  //   `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`
  // so a character class that excluded quotes stopped at `'self'` and reported
  // the fence inert — which is the vacuous-pass shape this wave keeps finding.
  const hasNonce = /script-src[^\n]*nonce-\$\{/.test(middlewareSource);
  const hasStrictDynamic = middlewareSource.includes("strict-dynamic");
  return hasNonce && hasStrictDynamic;
}

/** Route path for a prerendered HTML file, as the build log would print it. */
export function routeFromHtmlPath(htmlPath: string): string {
  // Normalise separators BEFORE stripping the prefix — BUILD_APP_DIR uses
  // forward slashes and globSync hands back backslashes on Windows.
  const rel = htmlPath.replaceAll("\\", "/").replace(`${BUILD_APP_DIR.replaceAll("\\", "/")}/`, "");
  const withoutExt = rel.replace(/\.html$/, "");
  return `/${withoutExt === "index" ? "" : withoutExt}`;
}

function runCheck(): void {
  // Same flag, same reason, as check-route-weight.ts. A developer running this
  // on a build-less box is not a failure; CI running it on one is, because in CI
  // the build always precedes and a missing directory means the ordering broke.
  // Its twin sat in a pre-build lint step for months, printed exactly the skip
  // below and exited 0, while `lint:ci-parity` certified it as covered because
  // that fence matches a literal token with no notion of step ordering. This
  // check lives one line away in the same workflow and had the same hole.
  const requireBuild = process.argv.includes("--require-build");

  if (!existsSync(BUILD_APP_DIR)) {
    const msg = `check-csp-prerender: no build found at ${BUILD_APP_DIR}.\n  NOT run: the prerendered-page check (the whole fence).\n  Run pnpm build first. This run proved nothing about the CSP.`;
    if (requireBuild) {
      console.error(`✗ ${msg}`);
      process.exit(1);
    }
    console.warn(`[skip] ${msg}`);
    return;
  }

  const middleware = readFileSync(MIDDLEWARE_PATH, "utf8");
  if (!cspBreaksPrerenders(middleware)) {
    console.log(
      "✓ CSP × prerender — the policy no longer pairs a per-request nonce with\n  'strict-dynamic', so static pages are viable again. This fence is inert;\n  delete it, or restate what it should guard now.",
    );
    return;
  }

  const html = globSync(`${BUILD_APP_DIR}/**/*.html`);
  if (html.length > 0) {
    for (const file of html) {
      console.error(
        `✗ ${routeFromHtmlPath(file)} is PRERENDERED (${file}), and this app's CSP refuses\n  every script in a page that was rendered before the request existed.`,
      );
    }
    console.error(
      `\n✗ ${html.length} prerendered page(s) under a per-request-nonce CSP with 'strict-dynamic'.\n  Add: export const dynamic = "force-dynamic" — to each route, or change the\n  policy on purpose. Found twice already: the 404 (C3-P1) and /recuperar\n  (X1-F2) — both shipped rendering fine and arriving dead.`,
    );
    process.exit(1);
  }

  console.log("✓ CSP × prerender — no prerendered pages; every route gets a request nonce.");
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-csp-prerender.ts") ||
    process.argv[1].endsWith("check-csp-prerender.js"));

if (isMain) {
  runCheck();
}

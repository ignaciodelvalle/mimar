// A4-custodia-08 — the web pages the NATIVE app hands a person to must come back.
//
// THE HANDOFF, AND WHY IT BREAKS SILENTLY
// ---------------------------------------------------------------------------
// The web resolves a visitor from a COOKIE; the app holds a bearer token. So
// every web URL the app hands over opens a SIGNED-OUT browser, and the page's
// own guard decides what happens next. `requireUserOrRedirect()` with no
// argument sends the person to `/iniciar-sesion` and, after they sign in, to
// `/mis-mascotas` — not to the page they were sent to.
//
// Measured on the dispute handoff: a finder reads "ya tiene dueño/a", taps
// "Iniciar una disputa desde la web", meets a login screen with no explanation,
// signs in, lands on Mis mascotas, and has to find Reclamar and retype the
// fifteen digits she had just typed in the app.
//
// WHY A SOURCE FENCE. The rule is "this page passes a returnTo", and the thing
// that regresses is somebody deleting the argument — a behavioural test would
// have to render a server component and assert on a redirect the guard's own
// tests (`__tests__/auth-guards.test.ts`) already cover. What is NOT covered
// anywhere else is that the call site supplies the argument at all.
//
// THE LIST IS DERIVED, NOT MAINTAINED (L2-11)
// ---------------------------------------------------------------------------
// It used to be a hand-written array of ONE entry, which is a fence over one
// spelling rather than over the subject. The subject is "a web page this app
// sends somebody to", and the first run of the derived version found a second
// one the list had never mentioned: `/cuenta/privacidad`, the account-deletion
// page named in the Play Data-safety form, whose guard was bare.
//
// It is also NOT scanned as `Linking.openURL` call sites, and that is
// deliberate: `ACCOUNT_DELETION_URL` is not passed to `Linking` at all — the
// privacy screen RENDERS it as selectable text for the person to open
// themselves. Same handoff, same signed-out browser, same dead end. So what is
// scanned for is the URL BEING BUILT, wherever it is built:
//
//   · a template literal on the app's origin — `${API_BASE_URL}/denuncias/nueva`,
//     `${origin.replace(…)}/mis-mascotas/reclamar`, and every `export const
//     …_URL` in `src/config/api.ts`, which is where most of them live; and
//   · `deepLinkUrl(origin, "name", …)`, resolved through the contract's own
//     table so a renamed route moves the fence with it.
//
// Paths with no `page.tsx` behind them (the `/api/…` bases, anything external)
// drop out by construction: a page that does not exist cannot carry a guard.

import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { resolve } from "node:path";

import { DEEP_LINK_MAP, type DeepLinkName } from "@dim/contract/links";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");

/**
 * Every same-origin web path the native app builds, wherever it builds it.
 *
 * Two shapes, and both are matched on the ORIGIN rather than on the caller:
 * a template that interpolates `API_BASE_URL` or an `origin` argument, and a
 * `deepLinkUrl` call naming a row of the shared table.
 */
const ORIGIN_TEMPLATE = /\$\{[^}]*(?:API_BASE_URL|origin)[^}]*\}(\/[A-Za-z0-9\-_/]*)/g;
const DEEP_LINK_CALL = /deepLinkUrl\(\s*[^,]+,\s*"([A-Za-z][A-Za-z0-9]*)"/g;

function discoverHandoffPaths(): string[] {
  const files = globSync("apps/mobile/**/*.{ts,tsx}", { cwd: ROOT })
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !f.includes("node_modules/") && !/\.test\.tsx?$/.test(f));

  const paths = new Set<string>();
  for (const file of files) {
    const source = readFileSync(resolve(ROOT, file), "utf8");
    for (const [, path] of source.matchAll(ORIGIN_TEMPLATE)) {
      // The API base is not a page and never carries a guard.
      if (path === "/" || path.startsWith("/api/")) continue;
      paths.add(path);
    }
    for (const [, name] of source.matchAll(DEEP_LINK_CALL)) {
      const destination = DEEP_LINK_MAP[name as DeepLinkName];
      if (destination) paths.add(destination.webPath);
    }
  }
  return [...paths].sort();
}

/**
 * The `page.tsx` behind a web path, or `null` when the path names no page.
 *
 * Route groups contribute nothing to the url and are erased; a `:param` in the
 * table's spelling and a `[param]` directory are compared as the same shape,
 * for the reason `deep-link-map.test.ts` gives — the directory's name is an
 * implementation detail of one page.
 */
function pageFileFor(path: string): string | null {
  const wanted = eraseParams(path);
  for (const file of globSync("app/**/page.tsx", { cwd: ROOT }).map((f) =>
    f.replaceAll("\\", "/"),
  )) {
    if (file.includes("node_modules/")) continue;
    const segments = file
      .replace(/^app/, "")
      .replace(/\/page\.tsx$/, "")
      .split("/")
      .filter((s) => s !== "" && !(s.startsWith("(") && s.endsWith(")")));
    if (eraseParams(`/${segments.join("/")}`) === wanted) return file;
  }
  return null;
}

/**
 * The page's CODE, with its comments removed.
 *
 * Not fussiness: `mis-mascotas/reclamar/page.tsx` explains the fix it received
 * by quoting the defect — "the bare `requireUserOrRedirect()` landed them on Mis
 * mascotas" — and a fence reading raw text flags the page for the sentence that
 * documents why it is correct. `https://` survives the line-comment rule via the
 * preceding-colon guard.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function eraseParams(pattern: string): string {
  return pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") || segment.startsWith("[") ? "*" : segment))
    .join("/");
}

const HANDOFF_PATHS = discoverHandoffPaths();

describe("web pages the app hands off to carry a returnTo", () => {
  // NON-VACUITY. A regex that stops matching produces an empty corpus, an empty
  // corpus makes every claim below trivially satisfied, and this repo has been
  // bitten by a fence whose corpus quietly missed its subject often enough to
  // write the floor first and the check second.
  it("finds the web paths the app really hands people", () => {
    expect(HANDOFF_PATHS.length).toBeGreaterThanOrEqual(5);
    expect(HANDOFF_PATHS).toContain("/mis-mascotas/reclamar");
    expect(HANDOFF_PATHS).toContain("/cuenta/privacidad");
    // The deepLinkUrl arm resolves through the contract table, not through a
    // literal — this is the one that proves it ran.
    expect(HANDOFF_PATHS).toContain("/p/:publicToken/sighting");
  });

  it("never leaves a guard bare on a page the app hands off to", () => {
    const bare: string[] = [];
    const guarded: string[] = [];

    for (const path of HANDOFF_PATHS) {
      const file = pageFileFor(path);
      if (file === null) continue;
      const source = stripComments(readFileSync(resolve(ROOT, file), "utf8"));
      if (!/requireUserOrRedirect\s*\(/.test(source)) continue;
      guarded.push(path);
      // The argument is what carries the person back. Matched loosely on the
      // quote style so a formatter cannot turn this red.
      if (/requireUserOrRedirect\(\s*\)/.test(source)) {
        bare.push(`${path} (${file})`);
        continue;
      }
      // A STATIC path must be the one passed. A parameterised one cannot be a
      // literal, so for those the non-bare call above is the whole rule.
      if (!path.includes(":")) {
        const escaped = path.replaceAll("/", "\\/");
        expect(
          source,
          `${file} guards the page but sends the visitor somewhere other than ${path}`,
        ).toMatch(new RegExp(`requireUserOrRedirect\\(\\s*["'\`]${escaped}`));
      }
    }

    expect(
      bare,
      "a page the native app hands somebody to calls requireUserOrRedirect() with no " +
        "returnTo, so signing in lands them on /mis-mascotas instead of where they were sent",
    ).toEqual([]);
    // NON-VACUITY for this test specifically: at least one handoff page really
    // is behind the guard, so the loop above is not skipping everything.
    expect(guarded.length).toBeGreaterThanOrEqual(2);
  });

  it("is not vacuous — a bare guard call is what this refuses", () => {
    // The shape the fence exists to refuse, checked against the pattern rather
    // than against a file, so the assertion cannot pass because a file was
    // renamed out from under it.
    expect("await requireUserOrRedirect();\n").toMatch(/requireUserOrRedirect\(\s*\)/);
    expect('await requireUserOrRedirect("/mis-mascotas/reclamar");\n').not.toMatch(
      /requireUserOrRedirect\(\s*\)/,
    );
  });
});

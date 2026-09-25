/**
 * Landing font-preload pin — which `localFont({...})` calls in the root
 * layout are eagerly preloaded on EVERY route, `/` included.
 *
 * Why this test exists
 * ---------------------
 * app/layout.tsx applies every family it loads to `<html>` for ALL routes
 * (there is no per-route font split — see the landing.css comment for why
 * that split exists for CSS but font loaders still live in the shared root
 * layout). Next.js preloads (`<link rel="preload" as="font">`) every `src`
 * file of a `localFont()` call unless that call passes `preload: false`.
 *
 * `/` (app/page.tsx + app/landing.css + components/landing/**) only ever
 * renders three of the five families: Encode Sans (`--font-sans`, body
 * type), IBM Plex Serif (`--font-ln-serif` / `.lp-display`, the hero H1 —
 * the LCP element) and IBM Plex Mono (`--font-ln-mono` / `--lp-mono`,
 * badges and the credential micro-type). IBM Plex Sans and Caveat
 * (`font-ln-sans` / `font-ln-caveat`) are used only by non-landing routes
 * (globals.css + app/(app)/**, app/(public)/**, …) — grepping
 * app/landing.css and components/landing/** for either turns up nothing.
 * Preloading them on `/` bought the landing page ~6 of its 17 preloaded
 * woff2 files for fonts it never paints (W5b landing LCP, 2026-09-24).
 *
 * This test pins `preload: false` on exactly those two calls, and pins the
 * other three as still eagerly preloaded (the hero H1 face in particular
 * must never silently regress to `preload: false`, or the LCP element's
 * font stops being fetched ahead of paint). A future family added to the
 * root layout with no explicit `preload` defaults to preloaded (Next's own
 * default), so this test only needs to watch the two exceptions plus the
 * three that must stay eager.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..");
const LAYOUT = join(REPO_ROOT, "app", "layout.tsx");

type FamilyKey = "encodeSans" | "ibmPlexSerif" | "ibmPlexSans" | "ibmPlexMono" | "caveat";

/** Every family the root layout loads and applies to `<html>` for every route. */
const ALL_FAMILIES: readonly FamilyKey[] = [
  "encodeSans",
  "ibmPlexSerif",
  "ibmPlexSans",
  "ibmPlexMono",
  "caveat",
];

/** Families `/` never renders — must opt out of preload. */
const NOT_PRELOADED_ON_LANDING: readonly FamilyKey[] = ["ibmPlexSans", "caveat"];

function localFontBlock(varName: string): string {
  const src = readFileSync(LAYOUT, "utf8");
  const call = new RegExp(`const\\s+${varName}\\s*=\\s*localFont\\(\\{([\\s\\S]*?)\\n\\}\\)`).exec(
    src,
  );
  if (!call) throw new Error(`const ${varName} = localFont(...) not found in app/layout.tsx`);
  return call[1];
}

describe("landing font preload (app/layout.tsx applies to every route, `/` included)", () => {
  it.each(NOT_PRELOADED_ON_LANDING)(
    "%s is not rendered by app/landing.css or components/landing/** and must set preload: false",
    (family) => {
      expect(localFontBlock(family), `${family} = localFont(...) in app/layout.tsx`).toMatch(
        /preload:\s*false/,
      );
    },
  );

  it("the hero H1 face (IBM Plex Serif, .lp-display) stays eagerly preloaded", () => {
    expect(localFontBlock("ibmPlexSerif")).not.toMatch(/preload:\s*false/);
  });

  it("Encode Sans (--font-sans, landing body type) stays eagerly preloaded", () => {
    expect(localFontBlock("encodeSans")).not.toMatch(/preload:\s*false/);
  });

  it("IBM Plex Mono (--font-ln-mono / --lp-mono, landing badges) stays eagerly preloaded", () => {
    expect(localFontBlock("ibmPlexMono")).not.toMatch(/preload:\s*false/);
  });

  it("covers every family the root layout loads (no family silently unaccounted for)", () => {
    // Guard against this list going stale: every localFont() call in
    // app/layout.tsx must resolve, whether or not it's in either list above.
    for (const family of ALL_FAMILIES) {
      expect(() => localFontBlock(family), family).not.toThrow();
    }
  });
});

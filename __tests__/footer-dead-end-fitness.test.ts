// Fitness test — the two footers must withhold the same dead ends.
//
// The product ships TWO footers: `LandingFooter` (marketing chrome, columns
// Ciudadanía / Operadores / Institucional, rendered on `/`) and `AppFooter`
// (Producto / Información / Legales, rendered everywhere else). Different
// taxonomies is a deliberate design call; different DEAD ENDS is not.
//
// Blind QA 2026-08-19 caught the asymmetry: `/sugerencias` renders a "muy
// pronto" placeholder with no way to submit anything. AppFooter had already
// dropped the link with an explicit comment ("no feedback channel exists yet;
// link hidden to avoid dead end") — and the landing footer, on the
// highest-traffic page in the product, went on offering it. A fix that lands
// on one surface of a two-surface concept is the same defect class as the
// bite-observation window leaking into six screens.
//
// This test is a ratchet, not a ban: when a route below stops being a
// placeholder, delete its entry here IN THE SAME COMMIT that restores the
// links, and restore them in BOTH footers.

import { describe, expect, it } from "vitest";

import { FOOTER_NAV } from "@/components/landing/landing-content";
import { DEFAULT_COLUMNS } from "@/components/layout/AppFooter";

/**
 * Routes that exist but cannot yet do the thing their link name promises.
 *
 * Empty since pilot T1-P5: `/sugerencias` now names the mailbox a person reads
 * instead of promising a channel "muy pronto". Its footer links were NOT
 * restored in that change — whether the footers carry it again is a separate
 * call — so the list is empty rather than the links being back. The second
 * test below keeps this from passing vacuously.
 */
const DEAD_END_ROUTES: Array<{ href: string; why: string }> = [];

const landingHrefs = FOOTER_NAV.flatMap(([, links]) => links.map(([, href]) => href));
const appHrefs = DEFAULT_COLUMNS.flatMap((column) => column.links.map((link) => link.href));

describe("footer dead ends", () => {
  it("neither footer links to a route that cannot deliver on its label", () => {
    for (const { href, why } of DEAD_END_ROUTES) {
      expect(landingHrefs, `LandingFooter links ${href}, which ${why}`).not.toContain(href);
      expect(appHrefs, `AppFooter links ${href}, which ${why}`).not.toContain(href);
    }
  });

  it("reads real link sets from both footers (guards against a vacuous pass)", () => {
    // Without this, renaming either export would silently empty the arrays
    // above and the assertion would pass by having nothing to check.
    expect(landingHrefs.length).toBeGreaterThan(5);
    expect(appHrefs.length).toBeGreaterThan(5);
    expect(landingHrefs).toContain("/denuncias/nueva");
    expect(appHrefs).toContain("/privacidad");
  });
});

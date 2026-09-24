// Fitness test — a card-style radio must show focus on the card, not on its
// 1×1 hidden input (S7-F01).
//
// PURPOSE:
//   Several surfaces build a "pick one" card by hiding a real <input
//   type="radio"> with .sr-only and letting the <label> carry the whole visual.
//   globals.css has a global :focus-visible outline, so everyone assumed focus
//   was handled — but the focused element IS the clipped 1×1 input, so the ring
//   is painted where nobody can see it. Measured on /denuncias/nueva step 1:
//   outline, box-shadow and border all byte-identical before and after focus.
//
// WHY A FENCE:
//   Cowork reported ONE screen. The pattern is in five files, and the next card
//   list someone writes will inherit the same hole. The rule now lives in
//   globals.css; this test asserts the rule exists and that nobody deletes it
//   while the pattern is still in use.
//
// HOW TO MAINTAIN:
//   If the last card-style radio disappears, this test tells you the rule is
//   now dead weight. Until then, the rule stays.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const CSS = readFileSync(join(ROOT, "app", "globals.css"), "utf8");

/**
 * `<label> … <input type="radio" … sr-only`, the card-radio shape.
 *
 * The caps were 600/400 and missed three real files whose label className
 * template plus an intervening <span> ran past them — including Step3Where, in
 * the anonymous denuncia flow this fence singles out as the most exposed
 * (adversarial review 2026-08-08). Widened to 2000/800 and pinned by an explicit
 * file list below, because an under-counting detector is worse than none: this
 * file's own maintenance contract says "if the count drops to zero the CSS rule
 * is dead weight", so a silent undercount could talk someone into deleting a
 * rule that three unseen surfaces depend on.
 */
const CARD_RADIO = /<label[\s\S]{0,2000}?type="radio"[\s\S]{0,800}?sr-only/;

/**
 * The files that use this shape, as of 2026-08-08.
 *
 * Pinned rather than merely counted so a regex regression shows up as a NAMED
 * diff. Add a file here when you write a new card radio; the CSS rule covers it
 * automatically because the input is a descendant of the label.
 *
 * NOT covered by the `:has()` rule, and deliberately out of this list: the
 * sibling shape this repo also uses (`<label htmlFor=x>` … `<input id=x
 * className="sr-only">` OUTSIDE the label, styled with `peer-focus-visible` —
 * see components/ui/Field.tsx and OpFileInput.tsx). Those carry their own focus
 * treatment. A new card radio written that way would match the regex above but
 * NOT the CSS selector, so if one ever appears, give it `peer-focus-visible`
 * rather than assuming this rule reaches it.
 */
const KNOWN_CARD_RADIO_FILES: readonly string[] = [
  "app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/mordedura/BiteForm.tsx",
  "app/(public)/adoptar/[petToken]/postular/ApplicationForm.tsx",
  "app/(public)/denuncias/nueva/_components/Step1Kind.tsx",
  "app/(public)/denuncias/nueva/_components/Step2Severity.tsx",
  "app/(public)/denuncias/nueva/_components/Step3Where.tsx",
  "app/(public)/denuncias/nueva/_components/Step4Subject.tsx",
  "app/gob/reglas/nueva/RulesWizard.tsx",
  "app/org/[orgToken]/mordedura/nuevo/OrgBiteForm.tsx",
];

function componentsUsingCardRadios(): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (extname(full) !== ".tsx") continue;
      if (/\.(test|spec)\.tsx$/.test(full)) continue;
      if (CARD_RADIO.test(readFileSync(full, "utf8"))) {
        hits.push(relative(ROOT, full).replace(/\\/g, "/"));
      }
    }
  };
  for (const dir of ["app", "components"]) walk(join(ROOT, dir));
  return hits.sort();
}

describe("card-style radios — the focus ring reaches the card", () => {
  it("globals.css propagates :focus-visible from the hidden input to its label", () => {
    expect(
      CSS,
      "globals.css lost the `label:has(input.sr-only:focus-visible)` rule — every card-style radio is back to showing no keyboard focus at all (WCAG 2.4.7, Ley 26.653)",
    ).toMatch(/label:has\(input\.sr-only:focus-visible\)/);
  });

  it("the rule draws an actual ring, not an empty block", () => {
    // Non-vacuity: the selector could survive with its body gutted and this
    // suite would still be green while the cards showed nothing.
    const rule = CSS.match(/label:has\(input\.sr-only:focus-visible\)\s*\{([^}]*)\}/);
    expect(rule, "the rule exists but has no body").not.toBeNull();
    expect(rule?.[1]).toMatch(/outline:\s*var\(--focus-ring-width\)/);
  });

  it("covers exactly the files known to use the shape", () => {
    // Named, not counted. The previous version asserted `length > 0`, which the
    // detector satisfied while silently missing three files — and the fence
    // reported "five files" in a comment that was simply wrong. A regex that
    // stops matching now names what it dropped.
    expect(componentsUsingCardRadios()).toEqual([...KNOWN_CARD_RADIO_FILES].sort());
  });

  it("the focus-ring width is not zero", () => {
    // The three assertions above all pass if --focus-ring-width is set to 0px:
    // the selector exists, its body references the var, the files are found, and
    // every card shows nothing. Pin the one value that makes the rule visible.
    const width = CSS.match(/--focus-ring-width:\s*([^;]+);/)?.[1]?.trim();
    expect(width, "--focus-ring-width is missing from globals.css").toBeTruthy();
    expect(width).not.toMatch(/^0(px|rem|em)?$/);
  });
});

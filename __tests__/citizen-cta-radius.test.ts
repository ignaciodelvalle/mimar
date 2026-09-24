/**
 * Canon D.1 — citizen surfaces are pills, operator surfaces are 6px.
 *
 * The "Crear cuenta" CTA on the landing shipped as an 8px rectangle one click
 * away from /signup, which is all pills. It was not an exemption and not a raw
 * value: `.lp-btn` used `var(--radius-lg)`, the WRONG TOKEN. Both fences that
 * could have caught it looked elsewhere — `lint:buttons` reads `rounded-*`
 * utilities in JSX and `.lp-btn` is CSS, and the CSS token fence's radius rule
 * (C4) only flags raw px, so a tokenized-but-wrong value passes it cleanly.
 *
 * It was fixed on 2026-07-31 (e23ebca1's follow-up). This file exists so the
 * fix cannot silently revert the same way it silently shipped: nothing else in
 * the repo asserts what radius a citizen CTA actually has.
 *
 * Deliberately narrow. This is not a general radius audit — it pins the small
 * set of surfaces a person crosses on the way to creating an account, which is
 * where the mismatch was visible as two different button shapes in two clicks.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

// The corpus is "the app's stylesheets", not one file. The lp-* layer moved to
// app/landing.css on 2026-08-19 (while it lived in globals.css it shipped on
// every route) and this test went red, correctly: `rule()` throws when a
// selector it asserts on cannot be found, instead of passing vacuously.
// Register any new stylesheet here rather than narrowing what the test reads.
const STYLESHEET_PATHS: readonly string[][] = [
  ["app", "globals.css"],
  ["app", "landing.css"],
];
const STYLESHEETS = STYLESHEET_PATHS.map((p) => read(...p)).join("\n");
/** Where the Tailwind v4 `@theme` layer itself is declared. */
const THEME_LAYER = read("app", "globals.css");
const BUTTON = read("components", "ui", "Button.tsx");

/** The declaration block of an exact CSS selector. Throws if it moved. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^{}]*)\\}`, "m").exec(STYLESHEETS);
  if (!match) {
    const where = STYLESHEET_PATHS.map((p) => p.join("/")).join(" or ");
    throw new Error(`selector not found in ${where}: ${selector}`);
  }
  return match[1];
}

describe("Canon D.1 — the citizen path to an account is pills all the way", () => {
  it("the landing CTA is a pill", () => {
    // The one that was wrong. `--radius-lg` is 8px; the CTA must be the pill.
    const radius = /border-radius:\s*([^;]+)/.exec(rule(".lp .lp-btn"))?.[1].trim();
    expect(
      radius,
      "`.lp-btn` is the landing's Crear cuenta / Empezar CTA — an 8px rectangle " +
        "here sits one click away from /signup, which is all pills",
    ).toBe("var(--radius-pill)");
  });

  it("LnButton — every citizen button that is not the landing — is a pill", () => {
    expect(BUTTON).toContain("rounded-[var(--radius-pill)]");
  });

  it("neither uses a raw pixel radius", () => {
    // A raw value would at least be caught by the CSS fence's C4 rule; the
    // point of this assertion is that the two failure modes are different and
    // this file covers the one C4 cannot see.
    expect(rule(".lp .lp-btn")).not.toMatch(/border-radius:\s*\d/);
    expect(BUTTON).not.toMatch(/rounded-\[\d+px\]/);
  });

  it("the tokens still mean what these assertions assume", () => {
    // If --radius-pill ever stopped being a pill, every assertion above would
    // keep passing while every button turned into a rectangle. Matched against
    // the whole sheet rather than a block: these live in the Tailwind v4
    // `@theme` layer, not in a `:root` rule. Read from globals.css by name
    // rather than the joined corpus — the `@theme` layer is defined there
    // specifically, and every other stylesheet only consumes it.
    expect(THEME_LAYER).toMatch(/--radius-pill:\s*9999px/);
    expect(THEME_LAYER).toMatch(/--radius-lg:\s*8px/);
  });
});

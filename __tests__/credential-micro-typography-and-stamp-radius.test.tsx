/**
 * RA-10 (b) + (d) — the two VISIBLE aesthetic defects on the credential.
 *
 * (b) MICRO-TYPOGRAPHY. "Credencial pública" — the label directly under the
 *     miMAR wordmark on the flagship public surface — shipped at `text-[8px]`,
 *     two steps below the `--text-xs` (10px) floor the type scale in
 *     app/globals.css declares for "micro labels, badge counters".
 *
 *     The bump could not be made alone, and this is the part worth pinning.
 *     Measured on the running build at a 390px viewport: at 10px the tracked
 *     uppercase run needs 133px inside a box that was 123px wide, and the
 *     element carries `truncate` — so raising the size WITHOUT raising the flex
 *     basis would have replaced an unreadable label with a clipped one
 *     ("CREDENCIAL PÚBLIC…") on the credential's own identity band. `basis-8rem`
 *     (128px) is the first step that exceeds what fits beside the nowrap tier
 *     chip, which makes the chip drop to the second line the surrounding comment
 *     already describes as the intended wrap mechanism.
 *
 *     So the size and the basis are ONE change and the test treats them as one:
 *     re-lowering either half reintroduces the defect the other half fixed.
 *
 * (d) STAMP RADIUS. ConfidenceBadge was the badge family's only untokenized
 *     corner (a bare `rounded`, Tailwind's 4px default) and it renders beside
 *     LnVstamp and LnBadge — both `--radius-xs` — on this very page and on the
 *     owner's libreta. Three corner radii for one role on one card.
 *
 * Source-level for (b) because the credential page is an async server component
 * behind data fetches; a render test here would assert against fixtures rather
 * than the shipped markup. (d) is rendered for real — the component is pure.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConfidenceBadge } from "@/components/event/ConfidenceBadge";
import { chromeForSurface } from "@dim/contract/credential";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

const CREDENTIAL = read("app", "(public)", "p", "[publicToken]", "page.tsx");
const GLOBALS = read("app", "globals.css");

/**
 * The masthead moved out of the page (redesign 2026-10): the label is the
 * `.pc-band-doctype` span of the shared PublicDocumentBand, styled in
 * globals.css. Same two defects to guard, new home: the label must sit on the
 * 10px floor, and it must never be clipped at 390px.
 */
const BAND = read("components", "credential", "PublicDocumentBand.tsx");

/** One CSS rule body, by its exact selector. */
function cssRule(selector: string): string {
  const start = GLOBALS.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`${selector} not found in globals.css`);
  return GLOBALS.slice(start, GLOBALS.indexOf("}", start));
}

describe("RA-10 (b) — the credential's smallest type sits on the floor", () => {
  it("the type scale still puts the floor at 10px", () => {
    // The premise. If --text-xs ever moves, the token below moves with it and
    // this file should be revisited rather than silently guarding a new number.
    expect(GLOBALS).toMatch(/--text-xs:\s*10px/);
  });

  it("the masthead label is tokenized, not an 8px literal", () => {
    expect(chromeForSurface("public").subtitleFront).toBe("Credencial pública");
    // The page hands the contract's subtitle to the band; the band prints it
    // in the doctype span; the span is sized by the token.
    expect(CREDENTIAL).toContain("subtitle={publicChrome.subtitleFront}");
    expect(BAND).toContain('<span className="pc-band-doctype">{subtitle}</span>');
    expect(cssRule(".pc-band-doctype")).toContain("font-size: var(--text-xs)");
  });

  it("no sub-floor 8px literal survives anywhere on the credential", () => {
    expect(CREDENTIAL).not.toContain("text-[8px]");
    expect(BAND).not.toContain("text-[8px]");
    expect(cssRule(".pc-band-doctype")).not.toMatch(/font-size:\s*[0-9]px/);
  });

  it("the label cannot be clipped: an auto track between two shrinkable ones", () => {
    // The old masthead needed a raised flex basis because `truncate` would
    // otherwise cut "CREDENCIAL PÚBLIC…" at 390px. The band head is a grid now:
    // the label owns the `auto` middle track at its natural width, and the two
    // side tracks (mark, flip) are the ones that yield.
    expect(cssRule(".pc-band-head")).toContain(
      "grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)",
    );
    const doctype = cssRule(".pc-band-doctype");
    expect(doctype).toContain("white-space: nowrap");
    expect(doctype).not.toMatch(/overflow:|text-overflow:/);
  });
});

describe("RA-10 (d) — one role, one corner", () => {
  it("the confidence stamp uses the stamp token", () => {
    const html = renderToStaticMarkup(<ConfidenceBadge tier="professional_verified" />);
    expect(html).toContain("rounded-[var(--radius-xs)]");
  });

  it("no bare `rounded` survives — it was 4px against its 2px neighbours", () => {
    const html = renderToStaticMarkup(<ConfidenceBadge tier="self_reported" />);
    expect(html).not.toMatch(/class="[^"]*\brounded\b(?!-)/);
  });

  it("matches LnVstamp, the stamp it renders beside on the credential", () => {
    const vstamp = read("components", "ui", "StatusFlag.tsx");
    const badge = read("components", "event", "ConfidenceBadge.tsx");
    expect(vstamp).toContain("rounded-[var(--radius-xs)]");
    expect(badge).toContain("rounded-[var(--radius-xs)]");
  });

  it("leaves the citizen chip canon alone — pills stay pills", () => {
    // The consolidation was scoped to the stamp role. A later pass that
    // "unified" CaseBadge/AuthorChip onto the stamp radius would be a
    // different, unmade decision.
    expect(read("components", "CaseBadge.tsx")).toContain("rounded-full");
    expect(read("components", "pet-profile", "AuthorChip.tsx")).toContain("rounded-full");
  });

  it("leaves LnChip's status DOTS alone — their shape carries meaning", () => {
    // `lost` is rounded-[1px] and `sick` is --radius-xs on purpose: the state
    // must be readable without color. Consolidating these would delete the
    // non-color channel, not tidy it.
    const chip = read("components", "ui", "Chip.tsx");
    expect(chip).toContain("rounded-[1px]");
    expect(chip).toContain("rounded-full");
  });
});

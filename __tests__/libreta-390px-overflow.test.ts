/**
 * The libreta must not clip its own content on a 390px phone.
 *
 * Two clips, both silent, both inside a container that already declares
 * `overflow: hidden` — so there is no scrollbar, no ellipsis, nothing that
 * distinguishes truncated content from short content. On a medical record that
 * distinction is the whole point.
 *
 *  1. `.ln-vac-list-meta` was `white-space: nowrap`, which is right for
 *     "Próxima 12 mar 2026" and wrong for the "unconfirmed" state, whose meta
 *     is a 62-character sentence. A nowrap flex child's automatic minimum size
 *     is its entire unwrapped run, so the row could not shrink and the sentence
 *     ran off the card.
 *
 *  2. `.ln-fact .ln-v` renders payload values that are unbounded strings at the
 *     schema level (batch, brand, administered_by, chip_number, and the generic
 *     fallback) with no break rule under `.ln-asiento`'s `overflow: hidden`.
 *
 * These are CSS-only fixes, so they are pinned against the stylesheet. The last
 * test guards the PREMISE rather than the fix: if the long copy that motivates
 * the wrap ever gets shortened, this file should be revisited rather than
 * quietly keeping a constraint whose reason has gone.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const GLOBALS = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");
const VAC_BADGES = readFileSync(
  join(__dirname, "..", "components", "pet-profile", "VacunasStatusBadges.tsx"),
  "utf8",
);

/**
 * The declaration block of a rule, matched on an exact selector.
 * Throws rather than returning empty: a renamed selector must fail loudly here,
 * not silently turn every assertion below into a check against "".
 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^{}]*)\\}`, "m").exec(GLOBALS);
  if (!match) throw new Error(`selector not found in app/globals.css: ${selector}`);
  return match[1];
}

function declares(selector: string, prop: string): string | null {
  const found = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i").exec(rule(selector));
  return found ? found[1].trim() : null;
}

describe("libreta vaccine drill-down — the long meta must wrap, not clip", () => {
  it("lets the row wrap so the meta can take its own line", () => {
    expect(
      declares(".ln-vac-list-item", "flex-wrap"),
      "without flex-wrap the name and the meta are locked onto one line and the " +
        "longer of the two gets clipped by .ln-vac-list's overflow:hidden",
    ).toBe("wrap");
  });

  it("does NOT force the meta onto a single line", () => {
    expect(
      declares(".ln-vac-list-meta", "white-space"),
      "`white-space: nowrap` here truncated the 'Sin confirmar' sentence mid-word " +
        "on a 390px phone — the state an official most needs to read in full",
    ).not.toBe("nowrap");
  });

  it("lets both flex children shrink below their min-content", () => {
    // A flex item's automatic minimum size is min-content, so a long child does
    // not shrink — it pushes the row wider — unless min-width is set to 0.
    expect(declares(".ln-vac-list-name", "min-width")).toBe("0");
    expect(declares(".ln-vac-list-meta", "min-width")).toBe("0");
  });
});

describe("libreta asiento facts — unbounded payload values must break", () => {
  it("breaks a long unbroken value instead of running off the card", () => {
    const wrap = declares(".ln-fact .ln-v", "overflow-wrap");
    expect(
      wrap,
      "chip_number, batch, brand and administered_by have no max length in " +
        "lib/events/event-schemas.ts, and .ln-asiento clips — a 15-digit chip " +
        "number or a spaceless lot code needs somewhere to break",
    ).toBeTruthy();
    expect(["anywhere", "break-word"]).toContain(wrap);
  });

  it("keeps the fact cell shrinkable (the half of this that was already right)", () => {
    expect(declares(".ln-fact", "min-width")).toBe("0");
  });
});

describe("the premise these CSS fixes rest on", () => {
  it("the 'unconfirmed' meta really is long enough to need wrapping", () => {
    // If this copy is ever shortened, revisit the rules above rather than
    // keeping a constraint whose reason has quietly disappeared.
    const copy = /case "unconfirmed":\s*\n\s*return "([^"]+)"/.exec(VAC_BADGES);
    expect(copy, "the 'unconfirmed' branch of metaFor() moved or changed shape").not.toBeNull();
    expect(
      (copy?.[1] ?? "").length,
      "this meta is a sentence, not a date — that is why the row has to wrap",
    ).toBeGreaterThan(40);
  });

  it("the drill-down row still renders both children in the same flex row", () => {
    expect(VAC_BADGES).toContain('className="ln-vac-list-item"');
    expect(VAC_BADGES).toContain('className="ln-vac-list-name"');
    expect(VAC_BADGES).toContain('className="ln-vac-list-meta"');
  });

  it("the container that would do the clipping is still overflow:hidden", () => {
    // Not a bug — it clips the list to its rounded border. It is what makes a
    // wrapping failure invisible rather than merely ugly, which is why the
    // rules above are pinned instead of left to visual review.
    expect(declares(".ln-vac-list", "overflow")).toBe("hidden");
  });
});

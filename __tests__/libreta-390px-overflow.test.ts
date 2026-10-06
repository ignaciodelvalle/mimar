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

const FICHA_CSS = readFileSync(
  join(__dirname, "..", "app", "(public)", "design", "ficha-estados", "ficha.css"),
  "utf8",
);

type CssRule = { selector: string; body: string };

/**
 * Every rule inside every at-rule block whose header is exactly `header`
 * (e.g. `@container (min-width: 572px)`), comments stripped, braces matched.
 * Throws when no such block exists — a renamed query must fail loudly.
 */
function rulesIn(css: string, header: string): CssRule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  let at = source.indexOf(`${header} {`);
  if (at === -1) throw new Error(`no "${header}" block`);
  while (at !== -1) {
    let i = source.indexOf("{", at) + 1;
    const open = i;
    let depth = 1;
    while (depth > 0 && i < source.length) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    const inner = source.slice(open, i - 1);
    for (const m of inner.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      rules.push({ selector: (m[1] ?? "").trim(), body: m[2] ?? "" });
    }
    at = source.indexOf(`${header} {`, i);
  }
  return rules;
}

function prop(body: string, name: string): string | null {
  const found = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i").exec(body);
  return found ? (found[1] ?? "").trim() : null;
}

function inBlock(css: string, header: string, selector: string, name: string): string | null {
  const rule = rulesIn(css, header).find((r) => r.selector === selector);
  if (!rule) throw new Error(`"${selector}" not found in "${header}"`);
  return prop(rule.body, name);
}

/** Top-level track count of a grid-template-columns value. */
function trackCount(value: string): number {
  return value
    .replace(/\([^()]*\)/g, "X")
    .trim()
    .split(/\s+/).length;
}

const WIDE = "@container (min-width: 572px)";
const PHONE = "@media (max-width: 440px)";
const FICHA_PHONE = "@container (max-width: 440px)";

/** A rule that sets columns must never outrank the deceased one-track rule. */
function respectsDeceased(selector: string): boolean {
  return (
    selector === ".pc-id" ||
    selector.includes('[data-photo="hero"]') ||
    selector.includes(':not([data-cell="none"])')
  );
}

// The /p/ and owner-face identity row (`.pc-id`), laid out by the CARD's width
// (`.pc-cred` is an inline-size container), not the viewport. /p/ caps the card
// at ≤428px; the owner face fills a ~830px column on desktop. A narrow card
// with three tracks left the name 37-56px and the nowrap token ran under the
// opaque QR; a wide card with two rows pinned photo and QR to the far edges.
describe("credential identity row — laid out by the card's width", () => {
  it("the card is the container", () => {
    expect(declares(".pc-cred", "container-type")).toBe("inline-size");
  });

  it("narrow card (default): photo and right cell share row 1 in two 156px tracks", () => {
    expect(declares(".pc-id", "grid-template-columns")).toBe("156px 156px");
    expect(declares('.pc-id:not([data-photo="hero"]) .pc-id-copy', "grid-column")).toBe("1 / -1");
    expect(declares('.pc-id:not([data-photo="hero"]) .pc-id-copy', "grid-row")).toBe("2");
  });

  it("wide card (≥572px = 372px of mounts, gaps and padding + a 200px name): one row, three tracks", () => {
    expect(inBlock(GLOBALS, WIDE, ".pc-id", "grid-template-columns")).toBe(
      "156px minmax(0, 1fr) 156px",
    );
    expect(inBlock(GLOBALS, WIDE, '.pc-id:not([data-photo="hero"]) .pc-id-copy', "grid-row")).toBe(
      "1",
    );
    expect(
      inBlock(GLOBALS, WIDE, '.pc-id:not([data-photo="hero"]) .pc-id-copy', "grid-column"),
    ).toBe("2");
  });

  it("≤440px viewport: the narrow card's two tracks shrink to 116px", () => {
    expect(inBlock(GLOBALS, PHONE, ".pc-id", "grid-template-columns")).toBe("116px 116px");
  });

  it("no narrow block declares a three-track identity grid — every declaration checked", () => {
    const narrow = [
      ...rulesIn(GLOBALS, PHONE).map((r) => ({ ...r, where: `globals ${PHONE}` })),
      ...rulesIn(FICHA_CSS, FICHA_PHONE).map((r) => ({ ...r, where: `ficha ${FICHA_PHONE}` })),
    ];
    const columns = narrow.filter((r) => prop(r.body, "grid-template-columns") !== null);
    // Non-vacuity: both blocks really set identity columns.
    expect(columns.length).toBeGreaterThanOrEqual(3);
    const threeTrack = columns
      .filter((r) => trackCount(prop(r.body, "grid-template-columns") ?? "") >= 3)
      .map((r) => `${r.where}: ${r.selector}`);
    expect(threeTrack).toEqual([]);
  });

  it("deceased (data-cell=none): one fluid track that no width rule overrides", () => {
    expect(declares('.pc-id[data-cell="none"]', "grid-template-columns")).toBe("minmax(0, 1fr)");
    expect(declares('.pc-id[data-cell="none"] .pc-photo-mount', "justify-self")).toBe("center");
    const overriders = [
      ...rulesIn(GLOBALS, WIDE),
      ...rulesIn(GLOBALS, PHONE),
      ...rulesIn(FICHA_CSS, FICHA_PHONE),
    ]
      .filter((r) => prop(r.body, "grid-template-columns") !== null)
      .filter((r) => !respectsDeceased(r.selector))
      .map((r) => r.selector);
    expect(overriders).toEqual([]);
    // In the wide card the deceased name goes back under the lone photo.
    expect(inBlock(GLOBALS, WIDE, '.pc-id[data-cell="none"] .pc-id-copy', "grid-row")).toBe("2");
  });

  it("wraps the name at word boundaries, breaking a word only as a last resort", () => {
    expect(declares(".pc-id-copy h1", "overflow-wrap")).toBe("break-word");
    expect(declares(".pc-id-copy h1", "hyphens")).toBe("manual");
    expect(declares(".pc-id-copy h1", "text-wrap")).toBe("balance");
  });

  it("never wraps the token", () => {
    expect(declares(".pc-id-token", "white-space")).toBe("nowrap");
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

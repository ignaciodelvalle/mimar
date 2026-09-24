// Fitness test — every text token clears WCAG AA on every surface it can land on.
//
// PURPOSE:
//   The palette has been contrast-fixed three separate times, and each fix was
//   verified against ONE background. The tokens still carry the receipts:
//     --color-ln-mute   "5.02:1 on ln-paper"
//     --color-ln-faint  "4.60:1 on ln-paper"
//     --color-ln-warn   "5.28:1 on white"
//   ln-faint was then measured at 4.37:1 on ln-stripe — the cream the credential
//   card uses (adversarial review 2026-08-08, S7-F03). The colour was never the
//   problem; the unchecked PAIR was.
//
// WHY HERE AND NOT IN THE AXE SCANS:
//   The enforcing a11y checks are the Playwright axe specs, which catch this at
//   runtime — but only on the pages a spec actually visits, and e2e is its own
//   gate outside `pnpm verify`. A token that fails on a surface no spec opens
//   ships. This runs on every verify, reads the REAL values out of globals.css,
//   and costs milliseconds.
//
// WHAT THIS TEST DOES NOT DO:
//   It does not know which pairs the app actually renders. The matrix below is
//   written by hand for that reason: a blind cross-product would flag legitimate
//   pairings (white on ln-azul is correct and would look like a failure against
//   a light surface). Adding a token means deciding where it may sit.
//
// HOW TO MAINTAIN:
//   A failure is a real WCAG AA failure. Darken the token until it clears the
//   WORST surface in its row — and re-run, because ln-faint must also stay
//   lighter than ln-mute or the visual hierarchy inverts.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");

/** Reads a token's hex straight from globals.css — never a copy of the value. */
function token(name: string): string {
  const match = CSS.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`token --color-${name} not found in globals.css`);
  return match[1].toLowerCase();
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const channels = [0, 2, 4]
    .map((i) => Number.parseInt(hex.slice(1 + i, 3 + i), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA for normal-size text. Nothing in these rows is "large text". */
const AA_NORMAL = 4.5;

// The light surfaces a body-text token can legitimately sit on.
const LIGHT_SURFACES = ["ln-card", "ln-paper", "ln-stripe"] as const;

// Tokens used as TEXT on those surfaces. Fills and borders are excluded — the
// 4.5:1 floor is a text rule, and ln-celeste is a brand fill that only ever
// failed when it was used as small text (S7-F02).
const TEXT_ON_LIGHT = [
  "ln-ink",
  "ln-ink-2",
  "ln-mute",
  "ln-faint",
  "ln-ok",
  "ln-warn",
  "ln-err",
  "ln-azul",
] as const;

// Solid chips print white on a saturated fill — the inverse pairing, same floor.
const WHITE_ON_FILL = ["ln-ok", "ln-azul", "ln-err"] as const;

/**
 * Every `--color-X` that has a `--color-X-050` / `-bg` / `-025` tint, paired
 * with each of its own tints — DISCOVERED from globals.css, not listed here.
 *
 * Two rounds of this file got the scope wrong by hand. The first checked only
 * the three page surfaces and was green over ln-ok at 4.44:1 on its own tint.
 * The second added three tints by hand and still missed ln-rosa (4.25) and the
 * whole `ln-op-*` operator palette. Enumerating is the only version that closes
 * "the unchecked PAIR", which is what the file claims to be for.
 */
function ownTintPairs(): Array<{ text: string; tint: string }> {
  const hexes = new Map<string, string>();
  for (const m of CSS.matchAll(/--color-(ln-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    if (!hexes.has(m[1])) hexes.set(m[1], m[2].toLowerCase());
  }
  const pairs: Array<{ text: string; tint: string }> = [];
  for (const base of hexes.keys()) {
    for (const suffix of ["-050", "-bg", "-025"]) {
      if (hexes.has(base + suffix)) pairs.push({ text: base, tint: base + suffix });
    }
  }
  return pairs;
}

/**
 * Pairs that are NOT a text-on-background pair, with the reason. Everything
 * else discovered above must clear AA.
 *
 * Adding an entry here is a claim that the token is never printed as text on
 * that tint. It is not a way to silence a failure.
 */
const NOT_A_TEXT_PAIR: Record<string, string> = {
  "ln-celeste on ln-celeste-050":
    "ln-celeste is a brand FILL (2.89:1). Printing it as small text is the S7-F02 defect; the guard for that is the white-on-fill block below.",
  "ln-op-celeste on ln-op-celeste-050": "Operator-palette twin of the above, same hex, same rule.",
  "ln-rosa on ln-rosa-050":
    "4.25:1 — used only as toneIconBg (an icon container, Sheet.tsx), never as text. If a surface ever prints ln-rosa as text on its tint, darken the token instead of extending this list.",
  "ln-rosa on ln-rosa-bg": "4.27:1 — same container-only use as ln-rosa-050.",
};

describe("token contrast — text on light surfaces", () => {
  for (const text of TEXT_ON_LIGHT) {
    for (const surface of LIGHT_SURFACES) {
      it(`${text} on ${surface} clears AA`, () => {
        const ratio = contrast(token(text), token(surface));
        expect(
          Number(ratio.toFixed(2)),
          `--color-${text} on --color-${surface} is ${ratio.toFixed(2)}:1, below the ${AA_NORMAL}:1 WCAG AA floor for normal text`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
      });
    }
  }
});

describe("token contrast — every token on its own tint", () => {
  for (const { text, tint } of ownTintPairs()) {
    const key = `${text} on ${tint}`;
    if (key in NOT_A_TEXT_PAIR) continue;
    it(`${key} clears AA`, () => {
      const ratio = contrast(token(text), token(tint));
      expect(
        Number(ratio.toFixed(2)),
        `--color-${text} on --color-${tint} is ${ratio.toFixed(2)}:1, below the ${AA_NORMAL}:1 WCAG AA floor. Status tokens live on these tinted backgrounds, not only on the page surfaces.`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }

  it("finds pairs at all", () => {
    // A regex regression would empty the list and turn the whole block above
    // into zero assertions — green, and meaningless.
    expect(ownTintPairs().length).toBeGreaterThan(10);
  });

  it("every exemption still corresponds to a real pair", () => {
    // Keeps NOT_A_TEXT_PAIR honest: a renamed or deleted token would otherwise
    // leave a permanent excuse behind for a pair that no longer exists.
    const discovered = new Set(ownTintPairs().map((p) => `${p.text} on ${p.tint}`));
    const stale = Object.keys(NOT_A_TEXT_PAIR).filter((k) => !discovered.has(k));
    expect(stale, `stale entries in NOT_A_TEXT_PAIR: ${stale.join(", ")}`).toEqual([]);
  });
});

describe("token contrast — white on solid fills", () => {
  for (const fill of WHITE_ON_FILL) {
    it(`white on ${fill} clears AA`, () => {
      const ratio = contrast("#ffffff", token(fill));
      expect(
        Number(ratio.toFixed(2)),
        `white on --color-${fill} is ${ratio.toFixed(2)}:1, below ${AA_NORMAL}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }

  it("ln-celeste is NOT in that list, because white on it fails", () => {
    // Guards the reason, not just the result. ln-celeste is a legitimate brand
    // FILL; what failed was printing 12px white on it (S7-F02, /adoptar card)
    // and 12px ln-celeste text on white (/perdidas). If someone later "fixes"
    // ln-celeste by darkening it into an accessible text colour, this test
    // fails and asks them to reconsider — the brand blue is not a text token.
    expect(contrast("#ffffff", token("ln-celeste"))).toBeLessThan(AA_NORMAL);
  });
});

describe("token contrast — the hierarchy survives the fix", () => {
  it("ln-faint stays lighter than ln-mute on the worst surface", () => {
    // Non-vacuity in the other direction: the cheap way to pass every test
    // above is to darken the greys until they are all nearly ln-ink, which
    // would satisfy WCAG and destroy the visual hierarchy. ln-faint is the
    // faintest text in the system and must remain so.
    const stripe = token("ln-stripe");
    expect(contrast(token("ln-faint"), stripe)).toBeLessThan(contrast(token("ln-mute"), stripe));
  });
});

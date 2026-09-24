/**
 * Font-weight contract — every requested weight must be a LOADED weight.
 *
 * Why this test exists
 * --------------------
 * A `font-weight` the app asks for but never loaded does not fail. Per CSS
 * Fonts 4 §5.2 (font matching), the browser silently substitutes the nearest
 * loaded face of the same family. So `font-bold` on a `font-ln-mono` element
 * rendered **600**, and `font-medium` rendered **400**. The build passed, the
 * token fence passed, the whole suite passed. Only a computed-style read in a
 * real browser caught it — 30 inert declarations in .tsx and 5 in globals.css
 * had accumulated, including three operator primitives whose own comments said
 * "9px bold" over text that was not bold.
 *
 * What this test does
 * -------------------
 * It re-derives BOTH sides of the contract from source — no hand-maintained
 * list to drift:
 *
 *   supply — the `weight: [...]` arrays in app/layout.tsx, per family
 *   demand — every (family, weight) pair the app actually asks for:
 *              • `font-ln-{mono,serif,sans,caveat}` + a `font-<weight>`
 *                utility in the same className string (.tsx)
 *              • `font-family: var(--font-ln-*)` (or the `--lp-*` aliases)
 *                paired with `font-weight: N` in the same rule (globals.css)
 *              • the `font:` SHORTHAND, which a `font-weight:` grep misses —
 *                that is how `.lp-hcard-badge` hid for so long
 *
 * Then it asserts demand ⊆ supply. A new `font-bold` on a mono element fails
 * here with the exact file:line, instead of shipping as a silent 600.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..");
const LAYOUT = join(REPO_ROOT, "app", "layout.tsx");

/**
 * Every stylesheet that may request a weight. Register new ones here: a font
 * the layout never loaded still renders, silently synthesised by the browser,
 * so a sheet this list forgets is a sheet whose contract nobody checks.
 */
const STYLESHEETS: readonly string[][] = [
  ["app", "globals.css"],
  ["app", "landing.css"],
];

/** The four families exposed as `font-ln-*` utilities + `--font-ln-*` vars. */
type FamilyKey = "mono" | "serif" | "plexsans" | "caveat";

/**
 * app/layout.tsx variable name assigned to each family's `localFont({...})`
 * call. Was the next/font/google loader name (`IBM_Plex_Mono`, etc.) until
 * L-21 (2026-09-18) moved every family to next/font/local with vendored
 * .woff2 files — the google loader NAME no longer appears in the source, so
 * the call is identified by the `const <name> = localFont({` it's assigned
 * to instead.
 */
const LOADER_BY_FAMILY: Record<FamilyKey, string> = {
  mono: "ibmPlexMono",
  serif: "ibmPlexSerif",
  plexsans: "ibmPlexSans",
  caveat: "caveat",
};

/** Tailwind weight utility → numeric weight. */
const WEIGHT_UTILITY: Record<string, number> = {
  thin: 100,
  extralight: 200,
  light: 300,
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
};

/**
 * CSS custom properties that resolve to one of the four families.
 * `--lp-*` are the landing-page aliases declared on `.lp` (globals.css) — they
 * point at the same `--font-ln-*` stacks, so a weight requested through an
 * alias is exactly as dead as one requested directly.
 */
const FAMILY_BY_CSS_VAR: Record<string, FamilyKey> = {
  "--font-ln-mono": "mono",
  "--font-ln-serif": "serif",
  "--font-ln-sans": "plexsans",
  "--font-ln-caveat": "caveat",
  "--lp-mono": "mono",
  "--lp-serif": "serif",
};

type Request = { family: FamilyKey; weight: number; where: string };

// ---------------------------------------------------------------------------
// Supply — what app/layout.tsx actually loads
// ---------------------------------------------------------------------------

function loadedWeights(): Record<FamilyKey, number[]> {
  const src = readFileSync(LAYOUT, "utf8");
  const out = {} as Record<FamilyKey, number[]>;

  for (const [family, varName] of Object.entries(LOADER_BY_FAMILY) as [FamilyKey, string][]) {
    // `const <varName> = localFont({ ... })` — every `weight: "NNN"` inside a
    // `src: [{ path, weight, style }, ...]` entry is a loaded weight.
    const call = new RegExp(
      `const\\s+${varName}\\s*=\\s*localFont\\(\\{([\\s\\S]*?)\\n\\}\\)`,
    ).exec(src);
    if (!call) throw new Error(`const ${varName} = localFont(...) not found in app/layout.tsx`);
    const weights = [...call[1].matchAll(/weight:\s*["'](\d{3})["']/g)].map((m) => Number(m[1]));
    if (weights.length === 0) {
      throw new Error(`${varName} = localFont(...) has no weight entries in app/layout.tsx`);
    }
    out[family] = [...new Set(weights)];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Demand — what the app asks for
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".claude",
  ".design-sync",
  "dist",
  "coverage",
  "docs",
  "scripts",
]);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) acc.push(full);
  }
  return acc;
}

function rel(p: string): string {
  return relative(REPO_ROOT, p).split(sep).join("/");
}

/**
 * `font-ln-<family>` and a `font-<weight>` utility in the same className.
 * Scoped to a single source LINE, which is how Tailwind class strings are
 * written here — a class list split across lines belongs to the same element,
 * but pairing across lines would produce false positives from sibling
 * elements, so we stay conservative and only pair within a line.
 */
function scanTsx(): Request[] {
  const found: Request[] = [];
  for (const file of sourceFiles(REPO_ROOT)) {
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        const fam = /font-ln-(mono|serif|sans|caveat)\b/.exec(line);
        if (!fam) return;
        // `font-ln-sans` is IBM Plex Sans; the default `--font-sans` (Encode
        // Sans) is a different family and is not part of this contract.
        const family: FamilyKey = fam[1] === "sans" ? "plexsans" : (fam[1] as FamilyKey);
        for (const m of line.matchAll(
          /\bfont-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/g,
        )) {
          found.push({ family, weight: WEIGHT_UTILITY[m[1]], where: `${rel(file)}:${i + 1}` });
        }
      });
  }
  return found;
}

/**
 * Stylesheet rules that name one of the families AND a weight.
 * Handles both the `font-family:` + `font-weight:` pair and the `font:`
 * shorthand — the shorthand is invisible to a `font-weight` grep, and that is
 * precisely where `.lp-hcard-badge` (`font: 700 10px/1 var(--font-ln-mono)`)
 * hid while every audit counted four dead CSS declarations instead of five.
 *
 * Scans EVERY stylesheet, not just globals.css. That badge lives in the lp-*
 * layer, which moved to app/landing.css on 2026-08-19; a scanner pinned to one
 * filename would have gone on reporting a clean contract while the very
 * declaration it was written for sat unread in the other file. The
 * "scans a non-empty corpus" assertion below is what caught the move — keep it.
 */
function scanCss(): Request[] {
  const found: Request[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;

  for (const sheet of STYLESHEETS) {
    const css = readFileSync(join(REPO_ROOT, ...sheet), "utf8");
    const label = sheet.join("/");

    for (const rule of css.matchAll(ruleRe)) {
      const body = rule[2];
      const line = css.slice(0, rule.index).split("\n").length;

      const shorthand = /(?:^|[;\s])font:\s*(\d{3})\s+[^;]*?var\((--[a-z0-9-]+)\)/i.exec(body);
      if (shorthand) {
        const family = FAMILY_BY_CSS_VAR[shorthand[2]];
        if (family) {
          found.push({ family, weight: Number(shorthand[1]), where: `${label}:${line}` });
        }
        continue;
      }

      const familyDecl = /font-family:\s*var\((--[a-z0-9-]+)\)/i.exec(body);
      const weightDecl = /font-weight:\s*(\d{3})/i.exec(body);
      if (!familyDecl || !weightDecl) continue;
      const family = FAMILY_BY_CSS_VAR[familyDecl[1]];
      if (family) {
        found.push({ family, weight: Number(weightDecl[1]), where: `${label}:${line}` });
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("font-weight contract (app/layout.tsx ⊇ what the app requests)", () => {
  const loaded = loadedWeights();

  it("loads the weights the operator micro-type tier and the libreta ask for", () => {
    // Pinned separately from the derived check below: these three weights are
    // the ones the 2026-08-01 audit found inert, and pinning them means a
    // "cleanup" that drops one fails HERE with a named reason, not as an
    // unexplained diff in the derived set.
    expect(loaded.mono, "IBM Plex Mono 500 — .lp-ch-num, .lp-lib-y, .ln-band-title").toContain(500);
    expect(loaded.mono, "IBM Plex Mono 700 — Op* operator primitives, .ln-ledlbl").toContain(700);
    expect(loaded.serif, "IBM Plex Serif 700 — font-bold on font-ln-serif").toContain(700);
  });

  it("requests no font-weight it has not loaded (.tsx)", () => {
    const dead = scanTsx().filter((r) => !loaded[r.family].includes(r.weight));
    expect(
      dead.map((r) => `${r.where}  font-ln-${r.family} @ ${r.weight}`),
      "these weights are requested but not loaded — the browser silently renders " +
        "the nearest loaded face instead. Add the weight to app/layout.tsx.",
    ).toEqual([]);
  });

  it("requests no font-weight it has not loaded (globals.css, incl. the `font:` shorthand)", () => {
    const dead = scanCss().filter((r) => !loaded[r.family].includes(r.weight));
    expect(
      dead.map((r) => `${r.where}  ${r.family} @ ${r.weight}`),
      "these weights are requested but not loaded — the browser silently renders " +
        "the nearest loaded face instead. Add the weight to app/layout.tsx.",
    ).toEqual([]);
  });

  it("sees the `font:` shorthand, not only `font-weight:`", () => {
    // Mutation guard: scanCss() must not be reducible to a `font-weight:` scan.
    // Filtering by (family, weight) alone does NOT prove this — `.ln-ledlbl`
    // independently declares mono@700 as a normal family+weight pair, so a
    // count-based assertion stays green with the shorthand branch dead (this
    // test survived that exact mutant once). So: locate every `font:` shorthand
    // in the CSS *by line*, and require scanCss() to have reported each one.
    // Across EVERY stylesheet, and keyed by file: `.lp-hcard-badge`, the
    // declaration this guard was written for, now lives in landing.css, and
    // two files mean line numbers alone collide.
    const shorthandLines = STYLESHEETS.flatMap((sheet) => {
      const label = sheet.join("/");
      return readFileSync(join(REPO_ROOT, ...sheet), "utf8")
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) =>
          /(?:^|[;\s])font:\s*\d{3}\s+[^;]*var\(--(?:font-ln|lp)-[a-z]+\)/i.test(line),
        )
        .map(({ n }) => ({ file: label, n, where: `${label}:${n}` }));
    });

    expect(
      shorthandLines.length,
      "no `font:` shorthand with a font-ln-*/lp-* family left in any stylesheet — " +
        "this guard has nothing to protect; delete it or re-point it",
    ).toBeGreaterThan(0);

    // Rule blocks are matched whole, so a shorthand's reported line is the line
    // of the SELECTOR, not of the declaration — accept the nearest reported
    // line at or above each shorthand, IN THE SAME FILE.
    const reported = scanCss().map((r) => {
      const idx = r.where.lastIndexOf(":");
      return { file: r.where.slice(0, idx), n: Number(r.where.slice(idx + 1)) };
    });
    for (const { file, n: declLine, where } of shorthandLines) {
      expect(
        reported.some((r) => r.file === file && r.n <= declLine && declLine - r.n < 30),
        `the \`font:\` shorthand at ${where} was not reported by scanCss() — the shorthand branch is blind, and any dead weight declared that way ships silently`,
      ).toBe(true);
    }
  });

  it("scans a non-empty corpus", () => {
    // Guard against a silently-empty scan making the checks above vacuous
    // (a bad SKIP_DIRS entry or a broken regex would turn them green).
    expect(scanTsx().length).toBeGreaterThan(20);
    expect(scanCss().length).toBeGreaterThan(20);
  });
});

#!/usr/bin/env node
/**
 * codemod-dead-font-var — rewrites the dead `font-[var(--font-ln-*)]` utility
 * to the NAMED family utility (`font-ln-mono`, `font-ln-serif`, `font-ln-sans`).
 *
 * WHY
 * ---
 * `font-` is exactly as ambiguous to Tailwind v4 as `text-` was: it is the
 * prefix for font-family, font-weight AND font-style. For a bare CSS variable
 * Tailwind resolves it to font-WEIGHT. Straight out of the compiled stylesheet:
 *
 *   .font-\[var\(--font-ln-mono\)\]{--tw-font-weight:var(--font-ln-mono);
 *                                   font-weight:var(--font-ln-mono)}   <- DEAD
 *   .font-ln-mono{font-family:var(--font-ln-mono)}                     <- WORKS
 *
 * `--font-ln-mono` is a font STACK ("IBM Plex Mono", "Menlo", monospace), not a
 * <font-weight>, so the declaration is invalid, the browser drops it, and the
 * element keeps the font-family it INHERITED — which on this app is the body's
 * "Encode Sans", not the intended IBM Plex face. 520 such declarations
 * accumulated across 143 files. Nothing failed: not the build, not the token
 * fence (its DEAD_TEXT_VAR regex only ever matched the `text-` prefix), not the
 * test suite. It is invisible to everything except a computed-style read.
 *
 * The named utility works for the same reason `text-sm` works: `--font-*` IS
 * Tailwind v4's font-family namespace, so `font-ln-mono` compiles to a real
 * `font-family` declaration. Same token, same single source of truth, and it
 * actually applies.
 *
 * TWO THINGS THIS SCRIPT IS CAREFUL ABOUT
 * ---------------------------------------
 * 1. It substitutes RAW TEXT, not JSX `className` attributes. In this
 *    population 518 of 520 uses sit in a literal `className`, but two live in
 *    module-level constants (components/ui/Badge.tsx `base`,
 *    components/ui/Field.tsx `controlBase`) that an AST walk keyed on the
 *    attribute name would skip in silence. The sibling `text-` pass hit the
 *    same shape in a custom `summaryClassName` prop.
 * 2. It is anchored on the three tokens that exist (`ln-mono`, `ln-serif`,
 *    `ln-sans`). Any other `font-[var(--font-*)]` is REPORTED as unhandled
 *    rather than rewritten on a guess.
 *
 * Usage:
 *   node scripts/codemod-dead-font-var.mjs --dry     # report only
 *   node scripts/codemod-dead-font-var.mjs           # rewrite in place
 */

import fs from "node:fs";
import { globSync } from "node:fs";

// Anchored on the three defined families (app/globals.css --font-ln-*).
const DEAD = /\bfont-\[var\(--font-(ln-mono|ln-serif|ln-sans)\)\]/g;
// Anything else shaped like an arbitrary font var — reported, never rewritten.
const UNHANDLED = /\bfont-\[var\(--font-(?!ln-mono\)|ln-serif\)|ln-sans\))[^)]*\)\]/g;
// A named family utility already present on the same line, so a rewrite that
// would produce TWO competing families gets reported rather than hidden.
const NAMED_FAMILY = /(?<![\w-])font-ln-(mono|serif|sans)(?![\w-])/g;

const DRY = process.argv.includes("--dry");

// Same file set as the design-token fence (scripts/check-design-tokens.ts).
// scripts/ is excluded on purpose: check-design-tokens.ts and this file both
// carry the pattern in their own regexes and prose.
const FILES = globSync("{app,components}/**/*.{ts,tsx}");

let totalReplacements = 0;
let filesTouched = 0;
const byToken = {};
const collisions = [];
const unhandled = [];

for (const file of FILES) {
  const src = fs.readFileSync(file, "utf8");

  for (const m of src.matchAll(UNHANDLED)) unhandled.push(`${file}: ${m[0]}`);

  const matches = [...src.matchAll(DEAD)];
  if (matches.length === 0) continue;

  for (const m of matches) byToken[m[1]] = (byToken[m[1]] || 0) + 1;

  const out = src.replace(DEAD, (_full, token) => `font-${token}`);

  // Collision report: a line that ends up with two DIFFERENT named families.
  out.split(/\r?\n/).forEach((line, i) => {
    const found = [...line.matchAll(NAMED_FAMILY)].map((x) => x[1]);
    if (new Set(found).size > 1) {
      collisions.push(
        `${file}:${i + 1}: ${[...new Set(found)].join(" + ")} :: ${line.trim().slice(0, 160)}`,
      );
    }
  });

  totalReplacements += matches.length;
  filesTouched += 1;
  if (!DRY) fs.writeFileSync(file, out);
}

console.log(`${DRY ? "[dry] " : ""}replacements: ${totalReplacements}  files: ${filesTouched}`);
console.log(`by token: ${JSON.stringify(byToken)}`);
console.log(`unhandled font-[var(--font-*)] forms: ${unhandled.length}`);
for (const u of unhandled) console.log(`  ${u}`);
console.log(`potential competing-family lines: ${collisions.length}`);
for (const c of collisions) console.log(`  ${c}`);

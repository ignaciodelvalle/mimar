#!/usr/bin/env node
/**
 * codemod-dead-text-var — rewrites the dead `text-[var(--text-*)]` utility to
 * Tailwind's NAMED size utility (`text-sm`, `text-title`, …).
 *
 * WHY
 * ---
 * Tailwind v4 cannot tell whether an arbitrary `text-[…]` is a size or a
 * colour, and for a bare CSS variable it resolves to COLOUR. Straight out of
 * the compiled stylesheet:
 *
 *   .text-\[var\(--text-sm\)\]{color:var(--text-sm)}          <- DEAD
 *   .text-sm{font-size:var(--text-sm);line-height:…}          <- WORKS
 *
 * So `color: 12px` is an invalid <color>, the declaration is dropped, and the
 * element keeps its INHERITED font-size. 703 such declarations accumulated
 * (207 files) before a heading was measured in the browser and came back
 * 16px instead of 28px. See scripts/check-design-tokens.ts DEAD_TEXT_VAR.
 *
 * TWO THINGS THIS SCRIPT IS CAREFUL ABOUT
 * ---------------------------------------
 * 1. It must NEVER touch `text-[var(--color-*)]` — 1.8k uses that WORK,
 *    because the var name carries `color-`, which is exactly what lets
 *    Tailwind infer the type. The pattern is anchored on `--text-`.
 * 2. It substitutes RAW TEXT, not JSX `className` attributes. ~14 uses live
 *    in variant maps (OpButton.tsx), module constants (AlcanceScreen.tsx) and
 *    parameter defaults (ResultCount.tsx); an AST walk over JSX attributes
 *    skips those in silence.
 *
 * Usage:
 *   node scripts/codemod-dead-text-var.mjs --dry     # report only
 *   node scripts/codemod-dead-text-var.mjs           # rewrite in place
 */

import fs from "node:fs";
import { globSync } from "node:fs";

// Anchored on `--text-`; `--color-` can never match.
const DEAD = /\btext-\[var\(--text-([a-z0-9-]+)\)\]/g;
// Any named font-size utility already on the same class string, so a rewrite
// that would produce a DUPLICATE size utility gets reported rather than hidden.
const NAMED_SIZE = /(?<![\w-])text-(xs|sm|md|base|lg|xl|2xl|3xl|4xl|5xl|hero|title)(?![\w-])/g;

const DRY = process.argv.includes("--dry");

// Same file set as the design-token fence (scripts/check-design-tokens.ts),
// minus nothing: tests carry zero occurrences (verified), and scripts/ must be
// excluded because check-design-tokens.ts contains the pattern in its own
// regex and prose.
const FILES = globSync("{app,components}/**/*.{ts,tsx}");

let totalReplacements = 0;
let filesTouched = 0;
const byToken = {};
const collisions = [];

for (const file of FILES) {
  const src = fs.readFileSync(file, "utf8");
  const matches = [...src.matchAll(DEAD)];
  if (matches.length === 0) continue;

  for (const m of matches) byToken[m[1]] = (byToken[m[1]] || 0) + 1;

  const out = src.replace(DEAD, (_full, token) => `text-${token}`);

  // Collision report: a line that ends up with two named size utilities.
  out.split(/\r?\n/).forEach((line, i) => {
    const found = [...line.matchAll(NAMED_SIZE)].map((x) => x[1]);
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
console.log(`potential duplicate-size lines: ${collisions.length}`);
for (const c of collisions) console.log(`  ${c}`);

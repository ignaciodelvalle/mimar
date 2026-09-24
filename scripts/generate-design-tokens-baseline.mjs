// One-time script to generate scripts/design-tokens-baseline.json.
// Run: node scripts/generate-design-tokens-baseline.mjs
// Then commit the baseline file alongside the updated check-design-tokens.ts.

import { globSync, readFileSync, writeFileSync } from "node:fs";

const files = globSync("{app,components}/**/*.{ts,tsx}");
const EXCLUDE_PATH_PREFIXES = ["node_modules/"];

const filtered = files.filter((f) => {
  const p = f.replaceAll("\\", "/");
  return !EXCLUDE_PATH_PREFIXES.some((prefix) => p.startsWith(prefix) || p.includes(`/${prefix}`));
});

const textRe = /text-\[\d+\.?\d*px\]/g;
// Rule 9 — kept in sync with DEAD_TEXT_VAR in check-design-tokens.ts.
// `text-[var(--text-*)]` compiles to `color:var(--text-*)` in Tailwind v4, not
// to a font-size, so every one of these is a dead declaration.
const deadTextVarRe = /\btext-\[var\(--text-[a-z0-9-]+\)\]/g;
// Rule 10 — kept in sync with DEAD_FONT_VAR in check-design-tokens.ts.
// `font-[var(--font-*)]` compiles to `font-weight:var(--font-*)` in Tailwind
// v4, not to a font-family. A font stack is not a valid <font-weight>, so the
// declaration is dropped and the element keeps its INHERITED family. This
// category is at 0 across the whole baseline (SC-7, 2026-07-31) and must stay
// there — any hit is a new regression, not inherited debt.
const deadFontVarRe = /\bfont-\[var\(--font-[a-z0-9-]+\)\]/g;
// Kept in sync with ARBITRARY_SPACING_PX in check-design-tokens.ts (also matches
// 2-4 value compound shorthand, e.g. p-[14px_16px]) — this generator has its own
// copy of the regex rather than importing it, so both must be updated together.
const spaceRe =
  /\b(?:p|m|gap|space|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|gap-x|gap-y)-\[\d+\.?\d*(?:px|rem)(?:_\d+\.?\d*(?:px|rem)){0,3}\]/g;
const roundedRe = /rounded-\[\d+\.?\d*px\]/g;
const shadowRe = /shadow-\[[^\]]+\]/g;
const hexStyleRe =
  /(?:style|fill|color|stroke|background|backgroundColor)=\{[^}]*#[0-9a-fA-F]{3,8}/g;

const baseline = {};
let grandTotal = 0;

for (const f of filtered) {
  const rel = f.replaceAll("\\", "/");
  const src = readFileSync(f, "utf8");
  const t = [...src.matchAll(textRe)].length;
  const dtv = [...src.matchAll(deadTextVarRe)].length;
  const dfv = [...src.matchAll(deadFontVarRe)].length;
  const s = [...src.matchAll(spaceRe)].length;
  const r = [...src.matchAll(roundedRe)].length;
  const sh = [...src.matchAll(shadowRe)].length;
  const h = [...src.matchAll(hexStyleRe)].length;
  const total = t + dtv + dfv + s + r + sh + h;
  if (total > 0) {
    baseline[rel] = {
      text: t,
      deadTextVar: dtv,
      deadFontVar: dfv,
      space: s,
      rounded: r,
      shadow: sh,
      hexStyle: h,
    };
    grandTotal += total;
  }
}

const output = {
  _meta: {
    generatedAt: "2026-07-05",
    branch: "integration/all-20260703",
    totalViolations: grandTotal,
    description:
      "Baseline of arbitrary text/spacing/radius/shadow/hex-in-style values. " +
      "Files listed here are grandfathered. New violations in unlisted files or " +
      "counts exceeding these values will fail lint:tokens.",
  },
  files: baseline,
};

writeFileSync("scripts/design-tokens-baseline.json", `${JSON.stringify(output, null, 2)}\n`);
console.log(
  `Baseline written: ${grandTotal} total violations across ${Object.keys(baseline).length} files.`,
);

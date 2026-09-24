// Codemod: raw Tailwind palette → Poncho gob-* tokens.
//
// Run: pnpm tsx scripts/codemod-poncho-tokens.ts
// Idempotent: ejecutar 2 veces produce el mismo resultado.
//
// Handoff: Poncho PR-D (2026-05-28). Después de este script + el purge de
// dark:* (scripts/codemod-purge-dark.ts), corre `npx biome check --write`
// para normalizar la indentación que pueda haber quedado fragmentada.

import { readFileSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";

const MAPPINGS: Array<[RegExp, string]> = [
  // ── Text colors ─────────────────────────────────────────────────────
  [/\btext-neutral-50\b/g, "text-white"],
  [/\btext-neutral-100\b/g, "text-white"],
  [/\btext-neutral-200\b/g, "text-gob-border"],
  [/\btext-neutral-300\b/g, "text-gob-border-strong"],
  [/\btext-neutral-400\b/g, "text-gob-text-muted"],
  [/\btext-neutral-500\b/g, "text-gob-text-muted"],
  [/\btext-neutral-600\b/g, "text-gob-text-gray"],
  [/\btext-neutral-700\b/g, "text-gob-text-gray"],
  [/\btext-neutral-800\b/g, "text-gob-text"],
  [/\btext-neutral-900\b/g, "text-gob-text"],
  [/\btext-neutral-950\b/g, "text-gob-text"],

  // ── Bg colors (neutral) ─────────────────────────────────────────────
  [/\bbg-neutral-50\b/g, "bg-gob-surface-alt"],
  [/\bbg-neutral-100\b/g, "bg-gob-surface-alt"],
  [/\bbg-neutral-200\b/g, "bg-gob-surface-alt"],
  [/\bbg-neutral-800\b/g, "bg-gob-primary"],
  [/\bbg-neutral-900\b/g, "bg-gob-primary"],
  [/\bbg-neutral-950\b/g, "bg-gob-primary"],

  // ── Borders (neutral) ───────────────────────────────────────────────
  [/\bborder-neutral-200\b/g, "border-gob-border"],
  [/\bborder-neutral-300\b/g, "border-gob-border-strong"],
  [/\bborder-neutral-700\b/g, "border-gob-border-strong"],
  [/\bborder-neutral-800\b/g, "border-gob-border-strong"],

  // ── Rings (neutral) ─────────────────────────────────────────────────
  [/\bring-neutral-300\b/g, "ring-gob-border-strong"],
  [/\bring-neutral-700\b/g, "ring-gob-border-strong"],
  [/\bring-neutral-900\b/g, "ring-gob-primary"],
  [/\bring-neutral-50\b/g, "ring-white"],

  // ── Divides (neutral) ───────────────────────────────────────────────
  [/\bdivide-neutral-200\b/g, "divide-gob-border"],
  [/\bdivide-neutral-800\b/g, "divide-gob-border-strong"],

  // ── Semantic — danger / red ─────────────────────────────────────────
  [/\btext-red-(400|500|600|700|800|900)\b/g, "text-gob-danger"],
  [/\bbg-red-(50|100)\b/g, "bg-gob-danger/10"],
  [/\bbg-red-(500|600|700)\b/g, "bg-gob-danger"],
  [/\bborder-red-(200|300|400|500|600)\b/g, "border-gob-danger"],
  [/\bring-red-(500|600)\b/g, "ring-gob-danger"],

  // ── Semantic — warning / amber ──────────────────────────────────────
  [/\btext-amber-(600|700|800|900)\b/g, "text-gob-warning-text"],
  [/\bbg-amber-(50|100)\b/g, "bg-gob-warning/10"],
  [/\bbg-amber-(400|500|600)\b/g, "bg-gob-warning"],
  [/\bborder-amber-(200|300|400|500)\b/g, "border-gob-warning"],

  // ── Semantic — success / emerald ────────────────────────────────────
  [/\btext-emerald-(500|600|700|800|900)\b/g, "text-gob-success"],
  [/\bbg-emerald-(50|100)\b/g, "bg-gob-success/10"],
  [/\bbg-emerald-(500|600|700)\b/g, "bg-gob-success"],
  [/\bborder-emerald-(200|300|400|500|600)\b/g, "border-gob-success"],

  // ── Semantic — info / sky / blue ────────────────────────────────────
  [/\btext-sky-(500|600|700|800|900)\b/g, "text-gob-info"],
  [/\bbg-sky-(50|100)\b/g, "bg-gob-info/10"],
  [/\bbg-sky-(500|600|700)\b/g, "bg-gob-info"],
  [/\bborder-sky-(200|300|400|500)\b/g, "border-gob-info"],
  [/\btext-blue-(500|600|700|800|900)\b/g, "text-gob-azul-link"],
  [/\bbg-blue-(50|100)\b/g, "bg-gob-info/10"],
  [/\bborder-blue-(200|300|400|500)\b/g, "border-gob-info"],

  // ── Tailwind gray family (alias to neutral) ────────────────────────
  [/\btext-gray-(400|500)\b/g, "text-gob-text-muted"],
  [/\btext-gray-(600|700|800|900)\b/g, "text-gob-text"],
  [/\bbg-gray-(50|100)\b/g, "bg-gob-surface-alt"],
  [/\bborder-gray-(200|300)\b/g, "border-gob-border"],

  // ── Rose (used as danger / lost-pet emphasis) ──────────────────────
  [/\btext-rose-(400|500|600|700|800|900)\b/g, "text-gob-danger"],
  [/\bbg-rose-(50|100)(\/\d+)?\b/g, "bg-gob-danger/10"],
  [/\bbg-rose-(500|600|700)\b/g, "bg-gob-danger"],
  [/\bborder-rose-(200|300|400|500|600)\b/g, "border-gob-danger"],

  // ── Indigo (used as deep-emphasis accent) ──────────────────────────
  [/\btext-indigo-(400|500|600|700|800|900)\b/g, "text-gob-primary"],
  [/\bbg-indigo-(50|100)(\/\d+)?\b/g, "bg-gob-primary/10"],
  [/\bbg-indigo-(500|600|700)\b/g, "bg-gob-primary"],
  [/\bborder-indigo-(200|300|400|500|600)\b/g, "border-gob-primary"],

  // ── Zinc / slate / stone (rare; map to neutral equivalents) ────────
  [/\b(text|bg|border|ring)-(zinc|slate|stone)-(50|100)\b/g, "$1-gob-surface-alt"],
  [/\b(text|bg|border|ring)-(zinc|slate|stone)-(200|300)\b/g, "$1-gob-border"],
  [/\b(text|bg|border|ring)-(zinc|slate|stone)-(400|500|600)\b/g, "$1-gob-text-muted"],
  [/\b(text|bg|border|ring)-(zinc|slate|stone)-(700|800|900|950)\b/g, "$1-gob-text"],

  // ── Green (alias to emerald → success) ──────────────────────────────
  [/\btext-green-(400|500|600|700|800|900)\b/g, "text-gob-success"],
  [/\bbg-green-(50|100)(\/\d+)?\b/g, "bg-gob-success/10"],
  [/\bbg-green-(500|600|700)\b/g, "bg-gob-success"],
  [/\bborder-green-(200|300|400|500|600)\b/g, "border-gob-success"],

  // ── Cleanup misses on previous families ────────────────────────────
  // neutral bg-* and ring-* shades not in the initial list
  [/\bbg-neutral-(300|400|500|600|700)\b/g, "bg-gob-border-strong"],
  [/\bring-neutral-(100|200|800|950)\b/g, "ring-gob-border-strong"],
  [/\bborder-neutral-(50|100|400|500|600|900|950)\b/g, "border-gob-border-strong"],
  // amber heavier shades + ring + text-500
  [/\btext-amber-(300|400|500)\b/g, "text-gob-warning"],
  [/\bbg-amber-(700|800|900)(\/\d+)?\b/g, "bg-gob-warning"],
  [/\bring-amber-(400|500|600|700)\b/g, "ring-gob-warning"],
  [/\bborder-amber-(600|700|800|900)\b/g, "border-gob-warning"],
  // sky/blue heavier + border-*-700
  [/\bbg-blue-(400|500|600|700|800|900)\b/g, "bg-gob-info"],
  [/\bbg-sky-(400)(\/\d+)?\b/g, "bg-gob-info"],
  [/\bborder-blue-(600|700|800|900)\b/g, "border-gob-info"],
  // red heavier border
  [/\bborder-red-(700|800|900)\b/g, "border-gob-danger"],
  // rose with opacity modifiers
  [/\bbg-rose-(800|900|950)(\/\d+)?\b/g, "bg-gob-danger/15"],
  // emerald ring
  [/\bring-emerald-(200|300|400|500|600|700)\b/g, "ring-gob-success"],
  // dark bg shades for danger/success
  [/\bbg-red-(800|900)\b/g, "bg-gob-danger"],
  [/\bbg-green-(800|900)\b/g, "bg-gob-success"],
  [/\bbg-emerald-(800|900)\b/g, "bg-gob-success"],
  // divide neutral-100
  [/\bdivide-neutral-(50|100)\b/g, "divide-gob-border"],
  // ring neutral middle
  [/\bring-neutral-(400|500|600)\b/g, "ring-gob-primary"],
  // amber-950 text
  [/\btext-amber-950\b/g, "text-gob-warning-text"],
  // Tailwind yellow → warning
  [/\btext-yellow-(600|700|800|900)\b/g, "text-gob-warning-text"],
  [/\bbg-yellow-(50|100)\b/g, "bg-gob-warning/10"],
  [/\bbg-yellow-(400|500|600|700)\b/g, "bg-gob-warning"],
  [/\bborder-yellow-(200|300|400|500)\b/g, "border-gob-warning"],
  // Tailwind orange → warning (same family in our DS)
  [/\btext-orange-(500|600|700|800|900)\b/g, "text-gob-warning-text"],
  [/\bbg-orange-(50|100)\b/g, "bg-gob-warning/10"],
  [/\bbg-orange-(400|500|600|700)\b/g, "bg-gob-warning"],
  [/\bborder-orange-(200|300|400|500)\b/g, "border-gob-warning"],
  // ring/border amber + emerald lower shades
  [/\bring-amber-(100|200|300)\b/g, "ring-gob-warning"],
  [/\bring-emerald-(50|100)\b/g, "ring-gob-success"],
  [/\bborder-emerald-(50|100)\b/g, "border-gob-success"],
  // ring blue focus indicator → gob azul-link (Poncho official link blue)
  [/\bring-blue-(400|500|600|700)\b/g, "ring-gob-azul-link"],
  // amber-200/300 bg
  [/\bbg-amber-(200|300)\b/g, "bg-gob-warning/30"],
  // accent-* (native checkbox / radio / range tint) → gob-primary
  [/\baccent-neutral-(700|800|900)\b/g, "accent-gob-primary"],
  [/\baccent-(zinc|slate|stone|gray)-(700|800|900)\b/g, "accent-gob-primary"],
  [/\baccent-blue-(500|600|700|800)\b/g, "accent-gob-azul-link"],
  [/\baccent-red-(500|600|700|800)\b/g, "accent-gob-danger"],
  [/\baccent-emerald-(500|600|700|800)\b/g, "accent-gob-success"],
  [/\baccent-green-(500|600|700|800)\b/g, "accent-gob-success"],
  // Gradient stops (from-/to-/via-) — same family rules as bg-*
  [/\b(from|to|via)-neutral-(50|100|200)\b/g, "$1-gob-surface-alt"],
  [/\b(from|to|via)-(zinc|slate|stone|gray)-(50|100|200)\b/g, "$1-gob-surface-alt"],
  [/\b(from|to|via)-emerald-(50|100|200)\b/g, "$1-gob-success/10"],
  [/\b(from|to|via)-green-(50|100|200)\b/g, "$1-gob-success/10"],
  [/\b(from|to|via)-blue-(50|100|200)\b/g, "$1-gob-info/10"],
  [/\b(from|to|via)-sky-(50|100|200)\b/g, "$1-gob-info/10"],
  [/\b(from|to|via)-amber-(50|100|200)\b/g, "$1-gob-warning/10"],
  [/\b(from|to|via)-yellow-(50|100|200)\b/g, "$1-gob-warning/10"],
  [/\b(from|to|via)-red-(50|100|200)\b/g, "$1-gob-danger/10"],
  [/\b(from|to|via)-rose-(50|100|200)\b/g, "$1-gob-danger/10"],
];

const files = globSync("{app,components}/**/*.{ts,tsx}", {
  exclude: ["**/node_modules/**", "**/*.test.*", "components/ui/**"],
});

let total = 0;
let changed = 0;
for (const file of files) {
  total += 1;
  const original = readFileSync(file, "utf8");
  let updated = original;
  for (const [pattern, replacement] of MAPPINGS) {
    updated = updated.replace(pattern, replacement);
  }
  if (updated !== original) {
    writeFileSync(file, updated, "utf8");
    changed += 1;
    console.log(`✓ ${file}`);
  }
}
console.log(`\nCodemod listo. ${changed}/${total} archivos modificados.`);

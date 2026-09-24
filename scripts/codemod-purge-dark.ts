// Codemod: elimina toda clase Tailwind con prefijo `dark:` en JSX className.
//
// Run: pnpm tsx scripts/codemod-purge-dark.ts
// Idempotente.
//
// Por qué: globals.css desactivó dark mode con
//   @variant dark (&:where(.dark, .dark *));
// y nada monta `.dark`. Las clases `dark:bg-neutral-950` etc. nunca aplican —
// son rot visual. Cuando dark mode se reactive, se reintroduce desde tokens
// semánticos, no desde paleta cruda.
//
// Limitación intencional: solo opera dentro de templates JSX (strings y
// className= attrs). No toca comentarios — biome formateará el resto.

import { readFileSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";

const files = globSync("{app,components}/**/*.{ts,tsx}", {
  exclude: ["**/node_modules/**", "components/ui/**"],
});

// `dark:utility-name` — matches one token. Repeated globally so adjacent
// dark: classes all go.
const DARK_CLASS = /(\s|"|')dark:[\w\-/\[\]()%.:]+/g;

let total = 0;
let changed = 0;
for (const file of files) {
  total += 1;
  const original = readFileSync(file, "utf8");
  // Replace `<sep>dark:foo` with `<sep>` (preserves the leading whitespace
  // or quote so the JSX string boundaries stay valid).
  const updated = original.replace(DARK_CLASS, (_match, leading) => leading);
  if (updated !== original) {
    writeFileSync(file, updated, "utf8");
    changed += 1;
    console.log(`✓ ${file}`);
  }
}
console.log(`\nDark purge listo. ${changed}/${total} archivos modificados.`);

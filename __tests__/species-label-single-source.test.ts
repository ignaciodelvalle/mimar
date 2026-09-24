// Fitness test — one species dictionary, and only one (2026-08-08).
//
// PURPOSE:
//   `speciesLabel` / `speciesLabelPlural` in lib/utils/format.ts are the ONLY
//   place a species enum value may be translated to es-AR. A private copy in a
//   component is not a style problem: it is a defect that ships, because the
//   copy is written against whatever species the author had in mind that day
//   and then silently stops matching the enum.
//
// WHY A FENCE AND NOT JUST A TEST OF THE MAP:
//   __tests__/species-label.test.ts already asserts the shared map is
//   exhaustive. It cannot see a RIVAL map, so it guarded the right door of the
//   wrong house — and the bug came back twice:
//     - 2026-07-08 (Ciudadano Cero QA): /mis-mascotas and the org pipeline
//       board each had a local dog/cat map and leaked the raw English enum for
//       every other species.
//     - 2026-08-08 (adversarial review): four more copies, including two in a
//       single file 35 lines apart, and a ternary in the org services detail
//       that rendered EVERY non-dog species as "Gatos" — not a leak but a
//       falsehood.
//
// WHAT THIS TEST DOES:
//   Scans app/, components/, lib/ and src/ for the SHAPE of a species→Spanish
//   mapping — an object entry, a ternary, or a value/label option pair — and
//   fails naming the file. It matches the mapping shape rather than the mere
//   presence of the word "Perro", so ordinary Spanish copy is untouched.
//
// HOW TO MAINTAIN:
//   Do not add an exception. If a surface needs a different wording, add it to
//   lib/utils/format.ts as a named export (as the plural was) so every caller
//   gets it. The only exempt file is format.ts itself.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "@/scripts/lib/strip-comments.mjs";

const ROOT = join(__dirname, "..");
const SCAN_DIRS = ["app", "components", "lib", "src"];

// The single legitimate home. Paths are compared with forward slashes.
// El diccionario se separo de lib/utils/format.ts el 2026-08-09 (ese modulo
// volvio a cruzar el fence de 1500 lineas). format.ts lo RE-EXPORTA, asi que no
// contiene ningun switch y no necesita exencion; la unica casa del mapa es esta.
const DICTIONARY_FILE = "lib/utils/species.ts";

// Canonical species set (pets.species) with both es-AR numbers, mirroring
// lib/utils/format.ts. Kept literal so a species added there without a plural
// shows up here as a diff rather than passing vacuously.
const SPECIES: ReadonlyArray<{ token: string; labels: readonly string[] }> = [
  { token: "dog", labels: ["Perro", "Perros"] },
  { token: "cat", labels: ["Gato", "Gatos"] },
  { token: "rabbit", labels: ["Conejo", "Conejos"] },
  { token: "guinea_pig", labels: ["Cobayo", "Cobayos"] },
  { token: "ferret", labels: ["Hurón", "Hurones"] },
];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (![".ts", ".tsx"].includes(extname(full))) continue;
      // Tests legitimately spell out expected labels — that is their job.
      if (/\.(test|spec)\.tsx?$/.test(full)) continue;
      out.push(full);
    }
  };
  for (const dir of SCAN_DIRS) walk(join(ROOT, dir));
  return out;
}

/**
 * Regexes for the shapes a hand-rolled map takes in this codebase.
 *
 * The `switch` case is the important one and was missing: it is the shape
 * `speciesLabel` ITSELF is written in (lib/utils/format.ts), so the single most
 * likely way a rival map gets born — copy the exempt file's body into a
 * component — was invisible to this fence (adversarial review 2026-08-08).
 * Nothing hits it today; a fence exists precisely for the prospective case.
 */
function mapShapes(token: string, labels: readonly string[]): RegExp[] {
  // El `[^"']*` después de la etiqueta acepta las variantes de prosa —
  // "perro/a", "otra especie"— que son mapas rivales igual.
  const label = `(?:${labels.join("|")})`;
  // INSENSIBLE A MAYÚSCULAS (2026-08-09). Las etiquetas de arriba están
  // capitalizadas, así que un mapa en MINÚSCULAS para prosa mid-sentence
  // —`{ dog: "perro/a", cat: "gato/a" }`— era invisible para este fence. Y
  // había uno vivo, en el mismo archivo que ya tenía otros dos: el baseline
  // llegó a quedar en CERO mientras ese sobrevivía por una diferencia de
  // capitalización.
  //
  // Es la misma familia que el resto de los fences que se corrigieron hoy:
  // declaraban una propiedad más angosta que la que su nombre prometía.
  const flags = "i";
  return [
    // { dog: "Perro" } / { "dog": "Perro" } / { dog: "perro/a" }
    new RegExp(`["']?${token}["']?\\s*:\\s*["']${label}[^"']*["']`, flags),
    // s === "dog" ? "Perros" : …
    new RegExp(`===\\s*["']${token}["']\\s*\\?\\s*["']${label}[^"']*["']`, flags),
    // A hardcoded label paired with the enum token ANYWHERE in the same object
    // literal, in either order.
    //
    // WIDENED 2026-08-09. These two used to require the keys to be named exactly
    // `value` and `label` AND to be adjacent. A live offender sat outside both
    // conditions — app/org/[orgToken]/censo/page.tsx wrote
    // `{ label: "Perros", slot: breakdown.dogs, species: "dog" }`: the key was
    // `species`, and `slot` came between. So the fence read CLEAN on a screen
    // that spelled "Otros" while the dictionary says "Otras". The keys a caller
    // picks are its own business; the SPELLING is not. Now any key name works
    // and up to ~120 chars of other properties may sit in between, without
    // crossing an object boundary (`[^{}]`).
    new RegExp(
      `["']?\\w+["']?\\s*:\\s*["']${token}["']\\s*,[^{}]{0,120}?\\blabel\\s*:\\s*["']${label}[^"']*["']`,
      flags,
    ),
    new RegExp(
      `\\blabel\\s*:\\s*["']${label}[^"']*["']\\s*,[^{}]{0,120}?["']?\\w+["']?\\s*:\\s*["']${token}["']`,
      flags,
    ),
    // <OpKpi label="Perros" … href="…?species=dog"> — the same pair spelled as
    // JSX attributes instead of object properties.
    new RegExp(`\\blabel\\s*=\\s*["']${label}["'][^>]{0,200}?species=${token}\\b`, flags),
    new RegExp(`species=${token}\\b[^>]{0,200}?\\blabel\\s*=\\s*["']${label}["']`, flags),
    // case "dog": return "Perro";  — the canonical implementation's own shape.
    new RegExp(
      `case\\s*["']${token}["']\\s*:[\\s\\S]{0,80}?return\\s*["']${label}[^"']*["']`,
      flags,
    ),
  ];
}

/** Every file that currently hand-rolls a species map, repo-relative. */
function findOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (rel === DICTIONARY_FILE) continue;

    // COMENTARIOS FUERA. Este fence leía el archivo crudo, así que el propio
    // comentario que explica un arreglo —"antes era { dog: 'Perro', cat:
    // 'Gato' }"— lo volvía a marcar como ofensor. Documentar por qué se sacó un
    // mapa no puede ser lo que reinstale la falla. Es la misma lección que
    // check-db-budget (un substring no es una llamada) y check-confused-deputy,
    // que ya usan este mismo stripper compartido.
    const source = stripComments(readFileSync(file, "utf8"));
    if (
      SPECIES.some(({ token, labels }) => mapShapes(token, labels).some((re) => re.test(source)))
    ) {
      offenders.push(rel);
    }
  }
  return offenders.sort();
}

const BASELINE: string[] = JSON.parse(
  readFileSync(join(ROOT, "scripts/species-dictionary-baseline.json"), "utf8"),
).files;

// Walked ONCE and shared: the scan reads every source file, so calling it per
// baseline entry turned a 500ms check into a timeout.
const OFFENDERS = findOffenders();

describe("species labels — a single dictionary", () => {
  it("adds no NEW hand-rolled species map", () => {
    const added = OFFENDERS.filter((f) => !BASELINE.includes(f));
    expect(
      added,
      `These files translate a species enum themselves instead of importing speciesLabel / speciesLabelPlural from lib/utils/format.ts:\n  ${added.join("\n  ")}\n\nAdd the wording to lib/utils/format.ts and import it. Do not add these to the baseline.`,
    ).toEqual([]);
  });

  it("keeps the baseline honest — a fixed file must be removed from it", () => {
    // The ratchet. Without this the baseline would quietly become a list of
    // files that USED to be wrong, and would stop meaning anything.
    const stale = BASELINE.filter((f) => !OFFENDERS.includes(f));
    expect(
      stale,
      `These files no longer hand-roll a species map. Delete them from scripts/species-dictionary-baseline.json:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });

  it("is not vacuous — the shapes it looks for do match a hand-rolled map", () => {
    // Guards the fence itself: a typo in the regexes would make the scan above
    // pass by matching nothing, which reads exactly like "the codebase is clean".
    const planted = `const m = { dog: "Perro", cat: "Gato" };`;
    expect(mapShapes("dog", ["Perro", "Perros"]).some((re) => re.test(planted))).toBe(true);

    const ternary = `const s = x === "dog" ? "Perros" : "Gatos";`;
    expect(mapShapes("dog", ["Perro", "Perros"]).some((re) => re.test(ternary))).toBe(true);

    const option = `{ value: "dog", label: "Perros" }`;
    expect(mapShapes("dog", ["Perro", "Perros"]).some((re) => re.test(option))).toBe(true);

    // The shape speciesLabel itself uses — the most likely way a copy is born.
    const switchCase = `switch (s) {\n  case "dog":\n    return "Perro";\n}`;
    expect(mapShapes("dog", ["Perro", "Perros"]).some((re) => re.test(switchCase))).toBe(true);
  });

  // Added 2026-08-09 after an adversarial audit found a LIVE offender the fence
  // read as clean: app/org/[orgToken]/censo/page.tsx wrote
  // `{ label: "Perros", slot: breakdown.dogs, species: "dog" }`. The old shapes
  // demanded the keys be named `value`/`label` AND be adjacent — this one used
  // `species` with `slot` in between. The screen shipped "Otros" while the
  // dictionary says "Otras".
  it("sees the pair under ANY key name, with other properties in between", () => {
    const shapes = mapShapes("dog", ["Perro", "Perros"]);
    const censo = `{ label: "Perros", slot: breakdown.dogs, species: "dog" },`;
    const inverso = `{ species: "dog", slot: x, label: "Perros" },`;

    expect(shapes.some((re) => re.test(censo))).toBe(true);
    expect(shapes.some((re) => re.test(inverso))).toBe(true);
  });

  it("sees the pair spelled as JSX attributes", () => {
    const jsx = `<OpKpi label="Perros" value={v} href={\`/org/\${t}/mascotas?species=dog\`} />`;

    expect(mapShapes("dog", ["Perro", "Perros"]).some((re) => re.test(jsx))).toBe(true);
  });

  it("does NOT reach across an object boundary, or into prose", () => {
    const shapes = mapShapes("dog", ["Perro", "Perros"]);
    const dosObjetos = `{ species: "dog" }, { other: 1, label: "Perros" }`;
    const prosa = `const msg = "Los perros y los gatos se registran igual";`;

    expect(shapes.some((re) => re.test(dosObjetos))).toBe(false);
    expect(shapes.some((re) => re.test(prosa))).toBe(false);
  });

  it("does not fire on ordinary Spanish copy that merely says Perro", () => {
    const copy = `const hint = "Perro, gato o la especie que corresponda.";`;
    expect(mapShapes("dog", ["Perro", "Perros"]).some((re) => re.test(copy))).toBe(false);
  });
});

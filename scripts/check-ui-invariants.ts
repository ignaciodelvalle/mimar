// UI invariants linter — CI guardrails for UX-audit regressions.
//
// Rules enforced:
//   1. Touch target ≥ 44px  — flags h-9/min-h-9/min-w-9 inside className on tsx files
//   2. No raw SCREAMING_CASE enum in JSX text  — catches un-localized event codes
//   3. es-AR missing accents  — known missing-accent regressions in Spanish copy
//   4. No raw English UI words in JSX text (+ nav labels / metadata titles)  — un-translated copy
//   5. Raw <button> growth guard (operator tier) — ratchet toward OpButton
//   6. No snake_case internal token in JSX text  — catches raw payload/enum codes
//
// Run: pnpm tsx scripts/check-ui-invariants.ts
// Or:  pnpm lint:ui
//
// Exits 1 with file:line:col on each hit. Exits 0 if clean.
//
// Post-filter approach: glob all files then filter by path.
// Follows the same shape as scripts/check-design-tokens.ts.

import { globSync, readFileSync } from "node:fs";
import { stripComments } from "./lib/strip-comments.mjs";

// ---------------------------------------------------------------------------
// Rule 1 — Touch target ≥ 44px
// ---------------------------------------------------------------------------
// Flags h-9, min-h-9, min-w-9, w-9 that appear inside a className attribute
// value in .tsx files.  These tokens produce 36px elements, below the 44px
// WCAG minimum for interactive controls.
//
// Scope: all components/**/*.tsx INCLUDING components/ui/ (that exclusion only
// applies to the design-token linter — touch targets matter everywhere).
// app/**/*.tsx is also scanned.
//
// Heuristic: we scan at the line level for className strings containing the
// token. Full multi-line JSX parsing is out of scope. To avoid false positives
// on legitimately-small NON-interactive elements (avatar images, icon dots,
// spinners, decorative containers), we maintain an ALLOWLIST keyed by
// "relativePath:lineNumber" OR "relativePath:classToken".
//
// Allowlist format: "file/path.tsx:TOKEN" where file path is relative with
// forward slashes from the repo root.
//
// PREFER to fix real interactive hits to h-11/min-h-11/min-w-11.
// Only allowlist verified non-interactive elements.
export const TOUCH_TARGET_TOKENS = /\b(h-9|min-h-9|min-w-9|w-9)\b/g;

// Regex to detect className attribute presence on the same or nearby line.
// We flag any line that contains className= AND one of the touch-target tokens
// (both in the same line), OR a line containing the token inside a template
// literal that is the continuation of a className=.
// For simplicity: flag any tsx line where the class token appears inside a
// quoted/template className value.  The className check isn't strictly required
// because the token is only meaningful as a Tailwind class anyway.
//
// Allowlist: "relativePath:token" pairs (path uses forward slashes).
// Add entries with a justification comment for each allowlisted case.
export const TOUCH_TARGET_ALLOWLIST = new Set<string>([
  // components/CasesWidget.tsx — aria-hidden <span> icon container,
  // non-interactive decorative element.
  "components/CasesWidget.tsx:h-9",
  "components/CasesWidget.tsx:w-9",

  // app/(app)/mis-mascotas/_components/OwnerRollupStrip.tsx — aria-hidden
  // <span> icon badge inside the rollup cell, non-interactive (same shape
  // as CasesWidget's allowlisted container).
  "app/(app)/mis-mascotas/_components/OwnerRollupStrip.tsx:h-9",
  "app/(app)/mis-mascotas/_components/OwnerRollupStrip.tsx:w-9",

  // components/pet-profile/LostScanFeed.tsx — aria-hidden emoji <span>
  // icon container, non-interactive.
  "components/pet-profile/LostScanFeed.tsx:h-9",
  "components/pet-profile/LostScanFeed.tsx:w-9",

  // components/ui/dashboard/OpCallout.tsx — decorative icon <div>,
  // non-interactive display element.
  "components/ui/dashboard/OpCallout.tsx:h-9",
  "components/ui/dashboard/OpCallout.tsx:w-9",

  // app/(public)/denuncias/page.tsx — decorative icon <div> (aria-hidden SVG)
  // inside a <Link> that is the actual touch target.
  "app/(public)/denuncias/page.tsx:h-9",
  "app/(public)/denuncias/page.tsx:w-9",
]);

// ---------------------------------------------------------------------------
// Rule 2 — No raw SCREAMING_CASE enum in JSX text
// ---------------------------------------------------------------------------
// Catches event-type/enum codes rendered as visible text.
// Regressions like LOST_EPISODE_RESOLVED_OWNER or PPP_BREED_LIST_UPDATED
// rendered directly in JSX instead of going through a label map.
//
// Detection heuristic (precision over recall):
// Only flag tokens that appear in JSX TEXT content — i.e. the trimmed line
// looks like JSX text: it starts with a word character or ">" or "{" (after
// optional whitespace) and contains the SCREAMING token not inside an
// identifier, import, className, href, or code expression.
//
// Patterns that indicate JSX text position:
//   >\s*SOME_ENUM\s*<         direct JSX text child
//   {"SOME_ENUM"}             JSX expression string child
//   {`SOME_ENUM`}             JSX expression template child
//
// We do NOT flag:
//   const FOO_BAR = ...       variable declarations
//   import FOO_BAR            imports
//   type Foo = "FOO_BAR"      TypeScript type literals (in type/enum positions)
//   className="..."           class attributes
//   href="..."                link targets
//   aria-label="FOO_BAR"      accessibility strings (these should use labels but
//                              are not user-visible in the same way)
export const SCREAMING_ENUM = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/g;

// Lines that match SCREAMING_ENUM in JSX text position:
// A line is "JSX text" if, after stripping leading whitespace, it matches one
// of:  />ENUM</  or  {"ENUM"}  or  {`ENUM`}  or just bare text like  ENUM
// But we require the line NOT to be a TS statement (const/let/type/import/export).
const JSX_TEXT_EXCLUSIONS = [
  /^\s*(?:const|let|var|type|interface|enum|import|export|\/\/|\/\*|\*)\s/,
  // className=, href=, aria-, data-, action=, name=, id= attributes
  /(?:className|href|aria-\w+|data-\w+|action|name|id|value|src|alt|placeholder)\s*=\s*["'`][^"'`]*$/,
  // Inside a TS object key position: "FOO": or FOO:
  /^\s*["']?[A-Z_]+["']?\s*:/,
  // TypeScript type/enum member: | "FOO_BAR" or = "FOO_BAR"
  /(?:\||\=)\s*["'`][A-Z_]+["'`]/,
];

// JSX text indicators — at least one must be true for us to flag.
// We ONLY flag unambiguous literal cases.  Key distinction:
//   LITERAL (flag):     >SOME_ENUM<   {"SOME_ENUM"}   {'SOME_ENUM'}   {`SOME_ENUM`}
//   IDENTIFIER (skip):  {SOME_MAP[key]}   const SOME_MAP   import SOME_CONST
//   EXPRESSION (skip):  ? SOME_MAP   GOB_ALL_PROVINCES,   IDENT.property
//
// MUST NOT flag TypeScript identifiers, imports, or expressions —
// false positives that break CI are worse than missed catches.
function looksLikeJsxText(line: string, token: string): boolean {
  // >TOKEN< — token as a literal JSX text child between open/close tags
  if (new RegExp(`>\\s*${token}\\s*<`).test(line)) return true;
  // {"TOKEN"} or {'TOKEN'} or {`TOKEN`} — JSX expression STRING literal child
  if (new RegExp(`\\{["'\`]${token}["'\`]\\}`).test(line)) return true;
  // DO NOT flag anything else.  Identifiers, object keys, imports, ternaries,
  // multi-line import entries, and JS expressions cannot be reliably
  // distinguished without a parser.
  return false;
}

// Case-insensitive twin of looksLikeJsxText — used ONLY by the English-word rule
// (Rule 4). A visible-copy leak reads the same regardless of case, so ">Panel<"
// vs ">panel<" must both be catchable; the SCREAMING-enum rule stays strictly
// case-sensitive (enum codes are always upper). `word` is a plain literal here
// (no regex metachars in the denylist), so no escaping is needed.
function looksLikeJsxTextCI(line: string, word: string): boolean {
  if (new RegExp(`>\\s*${word}\\s*<`, "i").test(line)) return true;
  if (new RegExp(`\\{["'\`]${word}["'\`]\\}`, "i").test(line)) return true;
  return false;
}

// Extract the quoted VALUE assigned to a specific object key on a line, e.g.
// `label: "Bandeja de salida"` → "Bandeja de salida". Scanning by key (label /
// title) — not every string on the line — keeps route values (`href: "/gob/
// outbox"`, `matchPrefix: "/gob/outbox"`) OUT of the English-word check: a URL
// segment named after an internal concept is not user copy.
function valueForKey(line: string, key: string): string | null {
  const m = line.match(new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`\\n]*)["'\`]`));
  return m ? m[1] : null;
}

// Allowlist for rule 2 — "relativePath:TOKEN" pairs
export const SCREAMING_ENUM_ALLOWLIST = new Set<string>([
  // (empty — the repo should be clean after UX 3.4 localization)
]);

// ---------------------------------------------------------------------------
// Rule 3 — es-AR missing accents
// ---------------------------------------------------------------------------
// Flags known missing-accent regressions in Spanish user-facing copy.
// Only flags tokens that appear as visible Spanish copy (JSX text or string
// literals in JSX position) — NOT in identifiers, URLs, imports, or code.
//
// Each entry: [unaccented, accented, regex]
// Regex uses \b word boundaries and is case-sensitive.
// We do NOT flag words inside URLs, hrefs, classNames, or code identifiers.
// NOTE on word selection: only add words that are (a) real Spanish copy in the
// repo and (b) very unlikely to be a code identifier. Identifiers in this
// codebase are English (description, configuration, …), so adverbs/connectors
// and Spanish-only nouns are safe; words that double as common variable/prop
// names (descripcion, version, opcion, numero) are NOT added — they would
// false-positive on JSX expressions like {descripcion}.
export const ACCENT_WORDS: Array<{ bad: string; good: string; re: RegExp }> = [
  { bad: "Ultimas", good: "Últimas", re: /\bUltimas\b/g },
  { bad: "notificacion", good: "notificación", re: /\bnotificacion\b/g },
  { bad: "pais", good: "país", re: /\bpais\b/g },
  { bad: "evaluan", good: "evalúan", re: /\bevaluan\b/g },
  { bad: "duenos", good: "dueños", re: /\bduenos\b/g },
  { bad: "accion", good: "acción", re: /\baccion\b/g },
  { bad: "jurisdiccion", good: "jurisdicción", re: /\bjurisdiccion\b/g },
  { bad: "auditoria", good: "auditoría", re: /\bauditoria\b/g },
  // Adverbs/connectors + administración — never identifiers in this codebase.
  { bad: "administracion", good: "administración", re: /\badministracion\b/g },
  { bad: "todavia", good: "todavía", re: /\btodavia\b/g },
  { bad: "aqui", good: "aquí", re: /\baqui\b/g },
  { bad: "ademas", good: "además", re: /\bademas\b/g },
  { bad: "despues", good: "después", re: /\bdespues\b/g },
];

/**
 * Accent words safe to scan across the WIDE file set (app + components + lib +
 * src), added by the copy audit 2026-08-04.
 *
 * Why a second list instead of widening ACCENT_WORDS. The words above are safe
 * in `app/**` and `components/**` but NOT outside them: `lib/` and
 * `src/modules/` legitimately use "accion", "jurisdiccion", "adopcion" and
 * "notificacion" as IDENTIFIERS — payload keys, situation slugs, icon names.
 * Widening the old list produced 44 hits of which most were symbols, not copy.
 * A fence that cries wolf teaches people to allowlist, which is worse than no
 * fence.
 *
 * The bar for THIS list is absolute: an adverb, a preposition or an inflected
 * verb/adjective form that cannot name a symbol in any language convention this
 * repo uses. Nouns do not qualify, however tempting — that is precisely how the
 * false positives above got in. If you want to add a noun, make the rule scan
 * string literals first.
 *
 * camelCase is safe by construction: `\bproximo\b` does not match
 * `proximoReintento`, because the following `R` is a word character.
 */
export const ACCENT_WORDS_WIDE: Array<{ bad: string; good: string; re: RegExp }> = [
  { bad: "proximamente", good: "próximamente", re: /\bproximamente\b/g },
  { bad: "proximo", good: "próximo", re: /\bproximo\b/g },
  { bad: "proxima", good: "próxima", re: /\bproxima\b/g },
  { bad: "Proximo", good: "Próximo", re: /\bProximo\b/g },
  { bad: "Proxima", good: "Próxima", re: /\bProxima\b/g },
  { bad: "ultimo", good: "último", re: /\bultimo\b/g },
  { bad: "ultima", good: "última", re: /\bultima\b/g },
  { bad: "Ultimo", good: "Último", re: /\bUltimo\b/g },
  { bad: "Ultima", good: "Última", re: /\bUltima\b/g },
  { bad: "Ultimos", good: "Últimos", re: /\bUltimos\b/g },
  { bad: "supero", good: "superó", re: /\bsupero\b/g },
  { bad: "tambien", good: "también", re: /\btambien\b/g },
  { bad: "segun", good: "según", re: /\bsegun\b/g },
  // Copy audit follow-up (2026-08-05): the surveillance module shipped
  // "informe epidemiologico final" to a govt operator's screen and "El codigo
  // de enfermedad no esta en el catalogo ENO." to their error toast. Adjective
  // forms with no unaccented reading, and English code never names a symbol
  // `epidemiologico`.
  { bad: "epidemiologico", good: "epidemiológico", re: /\bepidemiologico\b/g },
  { bad: "epidemiologica", good: "epidemiológica", re: /\bepidemiologica\b/g },
  { bad: "Epidemiologico", good: "Epidemiológico", re: /\bEpidemiologico\b/g },
  { bad: "Epidemiologica", good: "Epidemiológica", re: /\bEpidemiologica\b/g },
  { bad: "especifico", good: "específico", re: /\bespecifico\b/g },
  { bad: "Especifico", good: "Específico", re: /\bEspecifico\b/g },
  // "esta" CANNOT be fenced as a word: unaccented it is the demonstrative
  // ("esta mascota"), and it is everywhere. Only the PHRASE is decidable — a
  // demonstrative must be followed by a noun, so "esta" immediately before the
  // preposition "en" is always the verb "está". `\b` after "en" keeps
  // "esta entrada" / "esta enfermedad" out (the next char is a word char, so no
  // boundary). The feminine "especifica" is left out for the same reason: it is
  // a legitimate unaccented verb form ("él especifica").
  { bad: "esta en", good: "está en", re: /\besta en\b/g },
];

/**
 * Attributes whose VALUE is a symbol, never copy. Deliberately excludes the
 * attributes that ARE copy and must stay scanned: alt, title, placeholder,
 * aria-label, aria-description, label, subtitle, eyebrow.
 */
const NON_COPY_ATTRS =
  /\b(?:className|class|href|src|srcSet|action|formAction|id|htmlFor|key|name|type|method|rel|target|role|slug|as|to|form|pattern|autoComplete|data-[\w-]+)\s*=\s*(["'])(?:\\.|(?!\1).)*\1/g;

/**
 * Blanks non-copy attribute VALUES, preserving length so match offsets stay
 * exact.
 *
 * FIXED 2026-08-09. This used to be part of isCodeOnlyLine(), which returned
 * true — dropping the ENTIRE line — as soon as it saw className=, href= or
 * action=. In a Tailwind codebase the className lives on the same element as
 * the text it styles, so that guard blinded the rule to 58.673 of 181.257
 * non-empty .tsx lines (32,4%), biased precisely toward the lines that carry
 * copy. It shipped `<p className="…">Sin partes registradas todavia.</p>` on a
 * government screen (app/gob/disputas/[disputeToken]/page.tsx:157) while the
 * fence printed "✓ accents OK across 1264+1420 files".
 *
 * The narrower operation — blank the attribute value, keep the line — was
 * measured across 2740 files: exactly one new hit, the real one, and no false
 * positives.
 */
export function blankAttributeValues(line: string): string {
  return line.replace(NON_COPY_ATTRS, (m) => " ".repeat(m.length));
}

// Lines that carry no copy at all: TypeScript statements whose text, if any,
// lives in a string literal that the symbol/path filters already handle.
function isCodeOnlyLine(line: string): boolean {
  const t = line.trim();
  return /^(?:import|export\s+(?:type|interface|enum)|type|interface|enum)\s/.test(t);
}

// For accent rule: also skip matches that appear inside URL path segments
// (i.e., surrounded by / characters or preceded by /)
function isInsidePath(line: string, matchIndex: number, token: string): boolean {
  const before = line.slice(0, matchIndex);
  const after = line.slice(matchIndex + token.length);
  // Preceded by / — URL segment
  if (/[/]$/.test(before)) return true;
  // Followed by / — URL segment
  if (/^[/]/.test(after)) return true;
  // Inside a string that looks like a URL path: "/admin/auditoria"
  // Check if the nearest enclosing quote contains /
  const surroundingQuote = line.slice(Math.max(0, matchIndex - 50), matchIndex + token.length + 50);
  if (/["'`][^"'`]*\/[^"'`]*["'`]/.test(surroundingQuote)) return true;
  return false;
}

/**
 * Accent words that are NOUNS, admitted 2026-08-09 by the position filter below.
 *
 * The old docstring said "if you want to add a noun, make the rule scan string
 * literals first". That prescription was based on a wrong model of the false
 * positives. A survey of 68 candidate words across app+components+lib+src found
 * that the code hits are NOT `{descripcion}` JSX expressions. Every single one
 * of them is a SYMBOL in one of four shapes:
 *
 *   kebab slug     devolver-al-dueno, iniciar-sesion, en-transito
 *   object key     province: "provincia" · group: "medico" · layer: "situacion"
 *   member access  payload.telefono
 *   lone string    name="ubicacion" · route: "?sheet=sintoma" · id: "identificacion"
 *
 * And every copy hit is a SENTENCE — "Esta denuncia fue escalada…", "Solo quien
 * propuso la devolución…". That is the real discriminator, and it is decidable:
 * see isSymbolPosition(). A lowercase token that is the ENTIRE value of a string
 * literal is a symbol; the same token inside a phrase is copy.
 *
 * So the bar is no longer "adverbs only". It is: the word must survive
 * isSymbolPosition() on the current tree with zero hits, verified before adding.
 * These were all verified at 0 across 2740 files.
 *
 * The one class still excluded on purpose: words whose ACCENTED form is a
 * legitimate different word ("esta"/"está", "publico"/"público" as 1st-person
 * verb, "practica"/"práctica"). Those need the phrase, not the token.
 */
export const ACCENT_NOUNS: Array<{ bad: string; good: string; re: RegExp }> = [
  { bad: "tamano", good: "tamaño", re: /\btamano\b/g },
  { bad: "dueno", good: "dueño", re: /\bdueno\b/g },
  { bad: "duena", good: "dueña", re: /\bduena\b/g },
  { bad: "duenas", good: "dueñas", re: /\bduenas\b/g },
  { bad: "vacio", good: "vacío", re: /\bvacio\b/g },
  { bad: "vacia", good: "vacía", re: /\bvacia\b/g },
  { bad: "condicion", good: "condición", re: /\bcondicion\b/g },
  { bad: "direccion", good: "dirección", re: /\bdireccion\b/g },
  { bad: "confirmacion", good: "confirmación", re: /\bconfirmacion\b/g },
  { bad: "atencion", good: "atención", re: /\batencion\b/g },
  { bad: "vacunacion", good: "vacunación", re: /\bvacunacion\b/g },
  { bad: "castracion", good: "castración", re: /\bcastracion\b/g },
  { bad: "diagnostico", good: "diagnóstico", re: /\bdiagnostico\b/g },
  { bad: "electronico", good: "electrónico", re: /\belectronico\b/g },
  { bad: "electronica", good: "electrónica", re: /\belectronica\b/g },
  { bad: "categoria", good: "categoría", re: /\bcategoria\b/g },
  { bad: "proposito", good: "propósito", re: /\bproposito\b/g },
  { bad: "credito", good: "crédito", re: /\bcredito\b/g },
  { bad: "limite", good: "límite", re: /\blimite\b/g },
  { bad: "maximo", good: "máximo", re: /\bmaximo\b/g },
  { bad: "minimo", good: "mínimo", re: /\bminimo\b/g },
  { bad: "revision", good: "revisión", re: /\brevision\b/g },
  // Adjectives and adverbs — same verification, no reason to keep them in a
  // separate list now that the position filter carries the weight.
  { bad: "rapido", good: "rápido", re: /\brapido\b/g },
  { bad: "facil", good: "fácil", re: /\bfacil\b/g },
  { bad: "dificil", good: "difícil", re: /\bdificil\b/g },
  { bad: "unico", good: "único", re: /\bunico\b/g },
  { bad: "unica", good: "única", re: /\bunica\b/g },
  { bad: "util", good: "útil", re: /\butil\b/g },
  { bad: "ningun", good: "ningún", re: /\bningun\b/g },
  { bad: "algun", good: "algún", re: /\balgun\b/g },
  { bad: "estan", good: "están", re: /\bestan\b/g },
  // `aun` y `aún` son dos palabras distintas, no un error de acento:
  //   aún = todavía   ("aún no llegó")        → lleva tilde
  //   aun = incluso   ("aun así", "aun cuando") → NO lleva tilde
  // La regla escrita a secas marcaba como error toda ocurrencia de `aun`, así
  // que rechazaba copy correcto — encontrado 2026-08-18 cuando frenó la frase
  // "y aun así no aparece" en el not-found de denuncias. Una fence que exige
  // escribir mal es peor que no tenerla, sobre todo en un producto cuyo
  // argumento es no afirmar cosas falsas. El lookahead exime las dos
  // construcciones concesivas frecuentes y deja intacto el caso real
  // ("aun no llegó" → "aún no llegó").
  { bad: "aun", good: "aún", re: /\baun\b(?!\s+(?:así|asi|cuando))/g },
  { bad: "aca", good: "acá", re: /\baca\b/g },
  { bad: "alli", good: "allí", re: /\balli\b/g },
  { bad: "asi", good: "así", re: /\basi\b/g },
  { bad: "dias", good: "días", re: /\bdias\b/g },
  { bad: "cuantos", good: "cuántos", re: /\bcuantos\b/g },
];

// JS \w is [A-Za-z0-9_] — it does NOT include accented letters, so \b fires
// between "gestion" and "á". That made `\bgestion\b` match inside "gestionás",
// and would do the same to any word list entry whose word is a prefix of an
// already-correct accented form. Latent in the fence since it was written; found
// 2026-08-09 by the noun survey.
const SPANISH_ACCENTED = /[áéíóúüñÁÉÍÓÚÜÑ]/;

export function hasAccentedNeighbor(line: string, index: number, token: string): boolean {
  const before = line[index - 1] ?? "";
  const after = line[index + token.length] ?? "";
  return SPANISH_ACCENTED.test(before) || SPANISH_ACCENTED.test(after);
}

/**
 * True when the match sits in a position that names a SYMBOL rather than
 * rendering as copy. See the ACCENT_NOUNS docstring for the survey this encodes.
 */
export function isSymbolPosition(line: string, index: number, token: string): boolean {
  const before = line.slice(0, index);
  const after = line.slice(index + token.length);

  // 1. kebab-case slug: devolver-al-dueno, iniciar-sesion, en-transito.
  if (before.endsWith("-") || after.startsWith("-")) return true;

  // 2. member access: payload.telefono
  if (/\.\s*$/.test(before)) return true;

  // 3. object key / TS union member at the start of its line: `transito: {`
  //    or preceded by `{` / `,`. A copy string ending in ":" is always
  //    capitalized ("Ubicación:"), so lowercase-only keeps that out.
  if (token === token.toLowerCase() && /^\s*:/.test(after) && /(?:^\s*|[{,]\s*)$/.test(before)) {
    return true;
  }

  // 4. lone string literal: the token is the ENTIRE quoted value, or the value
  //    of a query/route fragment. Copy is a phrase — it has spaces. A single
  //    capitalized word IS plausible copy ("Descripcion" as a label), so the
  //    rule only fires on lowercase.
  const quoted = enclosingStringValue(line, index);
  if (quoted !== null && token === token.toLowerCase() && !/\s/.test(quoted)) return true;

  return false;
}

/** Value of the string literal enclosing `index`, or null when outside one. */
function enclosingStringValue(line: string, index: number): string | null {
  let quote: string | null = null;
  let start = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === null) {
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        start = i + 1;
      }
      continue;
    }
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === quote) {
      if (index >= start && index < i) return line.slice(start, i);
      quote = null;
      start = -1;
    }
  }
  return null;
}

// Allowlist for rule 3 — "relativePath:bad_word" pairs
// Add with justification comment when the word is legit code (not user copy).
export const ACCENT_ALLOWLIST = new Set<string>([
  // app/admin/jurisdicciones/page.tsx — "nivel pais" appears as part of a
  // template string rendered as UI text; fix it directly in source (see below).
  // (No allowlist entries — we fix all real JSX text hits.)
  // app/gob/reglas/page.tsx:26 — SOURCE_LABEL object constant value
  // "Override pais (AR)" — this IS user-visible copy; fix it.
  // (not allowlisted — fixing instead)
  // app/gob/decomisos/page.tsx:10 — comment line (// Columns: ... accion ...)
  // Code comment, not JSX text. The isCodeOnlyLine() check handles this via //
  // detection. No explicit entry needed.
  // app/admin/historial/page.tsx:192 — "No registraste acciones todavia."
  // "acciones" is the plural with correct accent already. "todavia" → "todavía"
  // but that word is NOT in the accent wordlist, so no false positive.
  // "accion" singular does not appear here. No entry needed.
  // app/org/[orgToken]/mascotas/[publicToken]/page.tsx — `accion:` is a
  // PetSituationTone key in the OP_TONE_CLASSES lookup (design-token class
  // map), not user-visible copy. The rendered label comes from PET_SITUATIONS
  // ("En adopción" / "En tránsito"), correctly accented.
  "app/org/[orgToken]/mascotas/[publicToken]/page.tsx:accion",
]);

// ---------------------------------------------------------------------------
// Rule 4 — No raw English UI words in JSX text
// ---------------------------------------------------------------------------
// Catches English words rendered as visible UI copy instead of their Spanish
// equivalents. Only flags tokens in JSX text position (same technique as Rule 2)
// to avoid false positives on code identifiers, imports, and prop names.
//
// Denylist is opt-in: only words explicitly added here are flagged.
// Borrowed/product vocabulary (Outreach, etc.) simply stays off the list.
//
// Detection patterns (case-insensitive via looksLikeJsxTextCI — a leak reads the
// same whether the code shipped "Dashboard", "dashboard", or "DASHBOARD"):
//   >Word<     direct JSX text child
//   {"Word"}   JSX expression string literal child
// PLUS two scope extensions (see scanRegistryLabels / metadata title pass): the
// operator breadcrumb/nav label registries and page metadata `title:` values,
// which are string VALUES (never JSX text) and so slip past looksLikeJsxTextCI.
//
// Word-boundary matching keeps the Spanish cognate "Exportación" clean while the
// bare English "Export" fails (there is no \b between "Export" and "ación").
//
// Allowlist: "relativePath:word" for any intentional use of a denylisted word.
export const ENGLISH_UI_WORDS: Array<{ word: string; suggestion: string; re: RegExp }> = [
  { word: "Enrollment", suggestion: "Inscripciones", re: /\bEnrollment\b/gi },
  // Operator-tier English leaks caught across ≥5 independent July-2026 reviews
  // (recorrido80 x2, staging x2, demo-validation). Spanish equivalents in the
  // suggestion; the check is denylist-only so borrowed product terms stay off it.
  { word: "Dashboard", suggestion: "Panel / Tablero", re: /\bDashboard\b/gi },
  { word: "backlog", suggestion: "Pendientes / Cola", re: /\bbacklog\b/gi },
  { word: "outbox", suggestion: "Bandeja de salida", re: /\boutbox\b/gi },
  { word: "oversight", suggestion: "Supervisión", re: /\boversight\b/gi },
  { word: "export", suggestion: "Exportar / Exportación", re: /\bexport\b/gi },
  { word: "fullscreen", suggestion: "Pantalla completa", re: /\bfullscreen\b/gi },
  { word: "hoarding", suggestion: "Acumulación", re: /\bhoarding\b/gi },
  { word: "medium", suggestion: "Media (severidad)", re: /\bmedium\b/gi },
  { word: "high", suggestion: "Alta (severidad)", re: /\bhigh\b/gi },
  { word: "low", suggestion: "Baja (severidad)", re: /\blow\b/gi },
  { word: "critical", suggestion: "Crítica (severidad)", re: /\bcritical\b/gi },
  // validacion-A 2026-07-23: "foster" and "dormant" leaked into rendered
  // Spanish copy as English parentheticals/adjectives ("En tránsito
  // (foster)", "mascotas dormant") across adopciones + censo. Neither word was
  // denylisted — added here for the JSX-text-child / bare-expression shapes
  // Rule 4 already covers. NOTE: the specific leaks found were `label:`/`sub=`
  // string VALUES (an object-literal property or a custom JSX attribute), a
  // shape Rule 4's looksLikeJsxTextCI does not scan at all (by design — it
  // only matches `>text<` children and `{"literal"}` expression children, to
  // avoid false-flagging identifiers/hrefs/classNames). Adding
  // lib/metrics/kpi-catalog.ts to REGISTRY_LABEL_FILES below closes the gap
  // for ITS `label:` values (arm B scans by key, not by JSX shape); the same
  // gap for arbitrary custom JSX attributes (`sub=`, `label=` as a prop on a
  // component) across app/components is NOT covered by any rule yet — a
  // wordlist entry alone cannot catch it. Flagged as a follow-up, not solved
  // by this change.
  { word: "foster", suggestion: "tránsito / hogar de tránsito", re: /\bfoster\b/gi },
  { word: "dormant", suggestion: "inactiva/s", re: /\bdormant\b/gi },
];

// Curated registries whose LABELS are English-checked as string values (arm B).
// operator-breadcrumbs is lib/ (outside STANDARD_FILES) and nav-presets stores
// its labels as object values (not JSX text), so both need the value-side scan.
const REGISTRY_LABEL_FILES = [
  "lib/ui/operator-breadcrumbs.ts",
  "components/layout/nav-presets.ts",
  // validacion-A 2026-07-23: kpi-catalog is lib/ (outside STANDARD_FILES) and
  // its ~70 `label:` values are read into JSX via `{KPI_CATALOG.x.label}`
  // (an identifier expression Rule 4 never resolves) — the exact shape that
  // let "En tránsito (foster)" ship undetected. Same rationale as the other
  // two entries: scan the label VALUE directly instead of relying on Rule 4
  // catching it at the render site.
  "lib/metrics/kpi-catalog.ts",
];

// Lines that should be excluded from English-word rule matching
// (same exclusion strategy as the screaming enum rule).
const ENGLISH_WORD_EXCLUSIONS = [
  /^\s*(?:const|let|var|type|interface|enum|import|export|\/\/|\/\*|\*)\s/,
  // className=, href=, aria-, data- attributes (not visible copy)
  /(?:className|href|aria-\w+|data-\w+|action|name|id|value|src|alt|placeholder)\s*=\s*["'`][^"'`]*$/,
];

// Allowlist for rule 4 — "relativePath:word" pairs
// Add with justification comment for each intentional borrowed term.
export const ENGLISH_UI_WORD_ALLOWLIST = new Set<string>([
  // (empty — no intentional denylisted words in the repo at time of writing)
]);

// ---------------------------------------------------------------------------
// Rule 6 — No snake_case internal token in JSX text
// ---------------------------------------------------------------------------
// Sibling of Rule 2 (SCREAMING_CASE), for the LOWERCASE payload/enum codes that
// leak verbatim into visible copy: `outbreak_signal`, `scan_event_purged`, cron
// codenames, and payload fragments like `pregnancy_status='in_progress'` rendered
// as text instead of going through a label map (mined across the July-2026
// reviews). Same precision philosophy as Rule 2 — flag ONLY when the token (or a
// key='value' payload fragment) is the ENTIRE JSX text node / quoted child, so an
// identifier, a `case "in_progress":`, or a snake_case substring inside a longer
// sentence (`"...(outbreak_signal) con estado..."`) is never touched.
//
// Baseline: current legit hits are grandfathered via SNAKE_CASE_ALLOWLIST
// ("relativePath:token"); anything new fails. Allowlist a hit ONLY when the raw
// token is intentional developer-facing copy (a formula string, a debug readout).
export const SNAKE_CASE_TOKEN = /\b[a-z]+_[a-z0-9_]+\b/g;

// A payload fragment shown literally as text: `key='in_progress'` / `key="value"`,
// the snake_case value being the giveaway. Matched only in JSX text position.
export const SNAKE_CASE_PAYLOAD_FRAGMENT = /\b[a-z][a-z0-9]*_?[a-z0-9_]*\s*=\s*["'][a-z0-9_]+["']/;

// Gap fix (qa-triage-2026-07-23, finding #9): Arm B used to check ONLY the
// `>fragment<` between-tags shape, so a fragment sitting inside a JSX STRING
// ATTRIBUTE value — `sub="mascotas con pregnancy_status='in_progress' (nacional)"`
// on app/admin/poblacion/AdminPoblacionScreen.tsx (the OpKpi `sub` prop) — was
// invisible to the rule, even though this file's own module comment names
// `pregnancy_status='in_progress'` as the CANONICAL motivating example. A
// caption/label/sub/title/description/definition JSX attribute is exactly
// where this class of leak lives — OpKpi's own `sub`/`label` props are
// string-literal attributes, not JSX children. Detects the fragment appearing
// inside a `attr="...frag..."` double-quoted string on the line.
function isPayloadFragmentInAttrString(line: string, frag: string): boolean {
  const escaped = frag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`=\\s*"[^"]*${escaped}[^"]*"`).test(line);
}

/** True when `frag` (a matched SNAKE_CASE_PAYLOAD_FRAGMENT) is rendered as
 * visible operator copy on `line` — either as JSX children (`>frag<`) or
 * inside a JSX string attribute value (`sub="...frag..."`). Exported for unit
 * testing (see __tests__/check-ui-invariants.test.ts). */
export function isPayloadFragmentRenderedAsCopy(line: string, frag: string): boolean {
  const escaped = frag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const asChildren = new RegExp(`>\\s*${escaped}\\s*<`);
  return asChildren.test(line) || isPayloadFragmentInAttrString(line, frag);
}

// Same line-type exclusions as the SCREAMING-enum rule (skip TS statements +
// attribute values) so identifiers and code never enter the scan.
const SNAKE_CASE_EXCLUSIONS = JSX_TEXT_EXCLUSIONS;

// Allowlist for rule 6 — "relativePath:token" pairs (token = the snake_case
// literal, or "payload-fragment" for a grandfathered key='value' text node).
export const SNAKE_CASE_ALLOWLIST = new Set<string>([
  // All four grandfathered hits render the token DELIBERATELY as a technical
  // reference inside a <code>/<span class="font-mono"> element — a real DB table
  // name, event code, rule flag, or CSV column shown verbatim in a transparency /
  // developer-facing explanation, not a leaked UI label. Keep new ones out.
  // components/panorama/PanoramaShell.tsx — <code>ar_localities</code> (the padrón
  // source table, in the data-provenance note).
  "components/panorama/PanoramaShell.tsx:ar_localities",
  // app/org/[orgToken]/mascotas/[publicToken]/transfer/page.tsx — <code>
  // custody_transferred</code>, the append-only event the transfer emits.
  "app/org/[orgToken]/mascotas/[publicToken]/transfer/page.tsx:custody_transferred",
  // app/gob/reglas/.../nueva/PppWeightThresholdForm.tsx — <span font-mono>
  // ppp_breed_list</span>, the rule flag name in the threshold explainer.
  "app/gob/reglas/[country]/[province]/[locality]/nueva/PppWeightThresholdForm.tsx:ppp_breed_list",
  // app/(public)/transparencia/page.tsx — <code>codigo_iso</code>, the CSV column
  // name in the open-data column glossary.
  "app/(public)/transparencia/page.tsx:codigo_iso",
]);

// ---------------------------------------------------------------------------
// Rule 5 — Raw <button> growth guard in app/admin + app/gob
// ---------------------------------------------------------------------------
// Operator-tier surfaces must migrate raw <button className=...> to OpButton.
// We cannot block all 138 legacy buttons in one PR — migration is incremental,
// module-by-module. This guard captures the BASELINE count and fails only if
// the count INCREASES (new raw buttons added). As modules are migrated the
// baseline is ratcheted DOWN by editing this constant.
//
// Baseline set on 2026-06-24 (chore/operator-button-primitive):
//   app/admin/**  — 66 raw <button tags
//   app/gob/**    — 72 raw <button tags
//   Total         — 138
//
// Ratcheted on 2026-06-24 (chore/operator-button-migration) — 91 migrated:
//   Remaining 47 are honest exceptions:
//   - Text-link style buttons (hover:underline, no bg): AddPartyForm, DeleteRuleButton,
//     CreateGovtForm, AssignLocalityForm, DecomisoForm, DeactivateAdminForm,
//     DeactivateGovtForm, RevokeLocalityRowActions, RevokeOrgActions, RevokeUserActions,
//     ProposeUserActions (internal ActionButton helper)
//   - Tab/chip toggles (dynamic selected-state className): DecomisoForm, AddPartyForm,
//     ResolveDisputeForm
//   - Transparent layout logout buttons: app/admin/layout.tsx, app/gob/layout.tsx
//   - Outline-danger style (OpButton danger is filled, not outlined): ReviewActions,
//     OfferingReviewActions, ModerationActions, cola/ReviewActions
//   - Icon-only/non-standard buttons: EventLedgerRow (disclosure toggle), LocalityRuleDrilldown
//     (autocomplete dropdown item), MpfExportButton (blue-outline loading custom style),
//     DecomisoForm (× remove, list selector), AlertRowActions (filter tab chips),
//     PppAttestationRegistriesForm, acerca/integracion-miarg, ModerationActions (dynamic class)
//   - Internal ActionButton helper components (TriageActions, InvestigationActions)
//
// To ratchet down after migrating a module: grep for "<button" in the migrated
// directory, verify the new count, and lower the constant accordingly.
// TIGHTENED 2026-08-09 from 47 to the real count. The constant had not been
// lowered as the migration progressed, so 22 fresh raw <button> could land in
// app/admin + app/gob without turning the fence red — while it printed
// "✓ 25/47 remaining (22 migrated)" as if that slack were progress. A ratchet
// with slack is not a ratchet. The check now fails in BOTH directions: growth
// is a regression, and a drop means the constant is stale and must come down.
export const RAW_BUTTON_BASELINE = 25;

// Files to scan for raw button growth (operator tier only).
// Exported so the test can assert the baseline against the REAL count instead
// of against a number typed into the test — which is how 47 outlived 25.
export const RAW_BUTTON_FILES = globSync("{app/admin,app/gob}/**/*.tsx");

// Counts the number of <button JSX opening tag occurrences across a file set.
// We match any line containing the literal substring "<button" (case-sensitive,
// since JSX tags are lowercase). This is intentionally broad — any raw <button
// in these directories counts, regardless of className.
export function countRawButtons(files: string[]): number {
  let total = 0;
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (line.includes("<button")) total += 1;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// File globbing
// ---------------------------------------------------------------------------

const EXCLUDE_PATH_PREFIXES_DEFAULT = ["node_modules/"];

// Touch-target rule: scan components/ INCLUDING components/ui/ + app/
const TOUCH_TARGET_FILES = globSync("{app,components}/**/*.tsx").filter((f) => {
  const p = f.replaceAll("\\", "/");
  return !EXCLUDE_PATH_PREFIXES_DEFAULT.some(
    (prefix) => p.startsWith(prefix) || p.includes(`/${prefix}`),
  );
});

// Screaming enum rule: exclude components/ui/ (same as token linter)
const EXCLUDE_PATH_PREFIXES_NOUI = [...EXCLUDE_PATH_PREFIXES_DEFAULT, "components/ui/"];
const STANDARD_FILES = globSync("{app,components}/**/*.{ts,tsx}").filter((f) => {
  const p = f.replaceAll("\\", "/");
  return !EXCLUDE_PATH_PREFIXES_NOUI.some(
    (prefix) => p.startsWith(prefix) || p.includes(`/${prefix}`),
  );
});

// Accent rule gets its OWN, WIDER file set (copy audit 2026-08-04).
//
// Rule 3 used to ride STANDARD_FILES, which never looks at `src/**` or `lib/**`
// — so es-AR copy living outside app/components was unguarded. That is not a
// hypothetical: user-facing Spanish lives in `src/modules/**` use cases and
// error messages, and `lib/**` holds label catalogues and formatters. The
// unaccented "proximamente" that shipped on a GOVERNMENT surface sat outside
// the old glob.
//
// Deliberately WIDER than the enum rule and deliberately INCLUDING
// components/ui/: a missing accent is wrong wherever it renders, and unlike the
// screaming-enum heuristic it has no reason to skip primitives. The word list
// is conservative (see ACCENT_WORDS) precisely so widening the scope is safe.
const ACCENT_FILES = globSync("{app,components,lib,packages,src}/**/*.{ts,tsx}").filter((f) => {
  const p = f.replaceAll("\\", "/");
  return !EXCLUDE_PATH_PREFIXES_DEFAULT.some(
    (prefix) => p.startsWith(prefix) || p.includes(`/${prefix}`),
  );
});

// ---------------------------------------------------------------------------
// Main scan — only runs when invoked directly (not when imported by tests)
// ---------------------------------------------------------------------------

function normalizeRelPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function runScan(): void {
  let hits = 0;

  // --- Rule 1: Touch target ---
  for (const file of TOUCH_TARGET_FILES) {
    const relPath = normalizeRelPath(file);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      // Only flag lines that have className in them or continuation template
      // literals — prevents flagging utility code that mentions h-9 in comments.
      if (!line.includes("className") && !line.includes("`") && !line.includes('"')) return;
      for (const match of line.matchAll(TOUCH_TARGET_TOKENS)) {
        const token = match[1] as string;
        const key = `${relPath}:${token}`;
        if (TOUCH_TARGET_ALLOWLIST.has(key)) continue;
        console.error(
          `${file}:${i + 1}:${(match.index ?? 0) + 1}: touch-target "${token}" is 36px — use ${token.replace("9", "11")} (44px) for interactive elements`,
        );
        hits += 1;
      }
    });
  }

  // --- Rule 2: Screaming enum in JSX text ---
  for (const file of STANDARD_FILES) {
    const relPath = normalizeRelPath(file);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      // Quick bail: if line has no uppercase-underscore pattern, skip
      if (!/[A-Z][A-Z0-9]*_[A-Z0-9]/.test(line)) return;
      // Skip excluded line types
      if (JSX_TEXT_EXCLUSIONS.some((re) => re.test(line))) return;
      for (const match of line.matchAll(SCREAMING_ENUM)) {
        const token = match[0];
        if (!looksLikeJsxText(line, token)) continue;
        const key = `${relPath}:${token}`;
        if (SCREAMING_ENUM_ALLOWLIST.has(key)) continue;
        console.error(
          `${file}:${i + 1}:${(match.index ?? 0) + 1}: raw enum "${token}" rendered as JSX text — map through a label function`,
        );
        hits += 1;
      }
    });
  }

  // --- Rule 4: Raw English UI words in JSX text ---
  for (const file of STANDARD_FILES) {
    const relPath = normalizeRelPath(file);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (ENGLISH_WORD_EXCLUSIONS.some((re) => re.test(line))) return;
      for (const { word, suggestion, re } of ENGLISH_UI_WORDS) {
        re.lastIndex = 0;
        for (const match of line.matchAll(re)) {
          if (!looksLikeJsxTextCI(line, word)) continue;
          const key = `${relPath}:${word}`;
          if (ENGLISH_UI_WORD_ALLOWLIST.has(key)) continue;
          console.error(
            `${file}:${i + 1}:${(match.index ?? 0) + 1}: raw English UI word "${word}" in JSX text — use "${suggestion}" instead`,
          );
          hits += 1;
        }
      }
    });
  }

  // --- Rule 4 (scope extension): English words in registry LABELS + metadata
  // titles. These are string VALUES, not JSX text, so the value side is scanned
  // with the same denylist (word-boundary). Arm B: the operator breadcrumb / nav
  // label registries. Arm C: page `metadata.title` (and any `title:` copy) across
  // the app + component tiers. ---
  const metadataScanFiles = new Set<string>([...REGISTRY_LABEL_FILES]);
  for (const file of STANDARD_FILES) metadataScanFiles.add(normalizeRelPath(file));
  for (const relPath of metadataScanFiles) {
    let content: string;
    try {
      content = readFileSync(relPath, "utf8");
    } catch {
      continue; // registry file path drift — skip rather than crash CI.
    }
    const isRegistryLabelFile = REGISTRY_LABEL_FILES.includes(relPath);
    content.split(/\r?\n/).forEach((line, i) => {
      // Arm B scans `label:` values in the curated registry files; Arm C scans
      // `title:` values (page metadata + any title copy) everywhere. Key-scoped
      // extraction keeps route/href/matchPrefix strings out of the check.
      const value = isRegistryLabelFile ? valueForKey(line, "label") : valueForKey(line, "title");
      if (value === null) return;
      for (const { word, suggestion, re } of ENGLISH_UI_WORDS) {
        re.lastIndex = 0;
        if (!re.test(value)) continue;
        const key = `${relPath}:${word}`;
        if (ENGLISH_UI_WORD_ALLOWLIST.has(key)) continue;
        console.error(
          `${relPath}:${i + 1}: raw English word "${word}" in ${
            isRegistryLabelFile ? "nav/breadcrumb label" : "metadata title"
          } "${value}" — use "${suggestion}" instead`,
        );
        hits += 1;
      }
    });
  }

  // --- Rule 3: Missing es-AR accents ---
  // Two passes with different reach: the original word list keeps its original
  // app+components scope (those words double as identifiers in lib/ and src/),
  // while ACCENT_WORDS_WIDE — adverbs and verb forms only — sweeps lib/ and
  // src/ too. See the comment on ACCENT_WORDS_WIDE for why they cannot be one
  // list.
  // stripComments (2026-08-09): the pass used to read the file RAW, so a code
  // comment explaining a past fix — "antes decía tamano" — was itself reported
  // as a regression. Documenting why a word was corrected cannot be what
  // reinstates the failure. Same consolidation the species and copy-contract
  // fences already had. Offsets and line count are preserved by the stripper,
  // so reported positions stay exact.
  for (const [files, words] of [
    [STANDARD_FILES, ACCENT_WORDS],
    [ACCENT_FILES, ACCENT_WORDS_WIDE],
    [ACCENT_FILES, ACCENT_NOUNS],
  ] as const) {
    for (const file of files) {
      const relPath = normalizeRelPath(file);
      const lines = stripComments(readFileSync(file, "utf8")).split(/\r?\n/);
      lines.forEach((rawLine, i) => {
        if (isCodeOnlyLine(rawLine)) return;
        const line = blankAttributeValues(rawLine);
        for (const { bad, good, re } of words) {
          re.lastIndex = 0;
          for (const match of line.matchAll(re)) {
            const key = `${relPath}:${bad}`;
            if (ACCENT_ALLOWLIST.has(key)) continue;
            const at = match.index ?? 0;
            // Already-correct accented form: \b fires between "gestion" and "á".
            if (hasAccentedNeighbor(line, at, bad)) continue;
            // Symbol, not copy: slug, object key, member access, lone string.
            if (isSymbolPosition(line, at, bad)) continue;
            // Skip matches inside URL path segments
            if (isInsidePath(line, at, bad)) continue;
            console.error(
              `${file}:${i + 1}:${at + 1}: missing accent "${bad}" → "${good}" in Spanish copy`,
            );
            hits += 1;
          }
        }
      });
    }
  }

  // --- Rule 6: snake_case internal token in JSX text ---
  for (const file of STANDARD_FILES) {
    const relPath = normalizeRelPath(file);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      // Quick bail + skip TS statements / attribute values.
      if (!line.includes("_")) return;
      if (SNAKE_CASE_EXCLUSIONS.some((re) => re.test(line))) return;

      // Arm A — bare token as the ENTIRE JSX text node / quoted child.
      for (const match of line.matchAll(SNAKE_CASE_TOKEN)) {
        const token = match[0];
        if (!looksLikeJsxText(line, token)) continue;
        const key = `${relPath}:${token}`;
        if (SNAKE_CASE_ALLOWLIST.has(key)) continue;
        console.error(
          `${file}:${i + 1}:${(match.index ?? 0) + 1}: raw snake_case token "${token}" rendered as JSX text — map through a label function`,
        );
        hits += 1;
      }

      // Arm B — a key='value' payload fragment shown literally as copy, either
      // between tags (`>frag<`) or inside a JSX string attribute
      // (`sub="...frag..."` — the shape that missed the AdminPoblacionScreen
      // leak, qa-triage-2026-07-23 finding #9).
      const fragMatch = line.match(SNAKE_CASE_PAYLOAD_FRAGMENT);
      if (fragMatch) {
        const frag = fragMatch[0];
        if (
          isPayloadFragmentRenderedAsCopy(line, frag) &&
          !SNAKE_CASE_ALLOWLIST.has(`${relPath}:payload-fragment`)
        ) {
          console.error(
            `${file}:${i + 1}: raw payload fragment "${frag}" rendered as JSX text — show a localized status label, not the internal key=value`,
          );
          hits += 1;
        }
      }
    });
  }

  // --- Rule 5: Raw <button> growth guard ---
  const rawButtonCount = countRawButtons(RAW_BUTTON_FILES);
  if (rawButtonCount > RAW_BUTTON_BASELINE) {
    console.error(
      `app/admin + app/gob: raw <button count grew from baseline ${RAW_BUTTON_BASELINE} to ${rawButtonCount}. Use OpButton instead of raw <button in operator-tier surfaces. If this is a legitimate new button, update RAW_BUTTON_BASELINE in scripts/check-ui-invariants.ts and add a migration task for the module.`,
    );
    hits += 1;
  } else if (rawButtonCount < RAW_BUTTON_BASELINE) {
    console.error(
      `app/admin + app/gob: raw <button count DROPPED from baseline ${RAW_BUTTON_BASELINE} to ${rawButtonCount}. Lower RAW_BUTTON_BASELINE to ${rawButtonCount} in scripts/check-ui-invariants.ts — a baseline left above the real count is free room for ${RAW_BUTTON_BASELINE - rawButtonCount} new raw buttons.`,
    );
    hits += 1;
  } else {
    // Log progress toward zero so the ratchet is visible in CI output.
    console.log(`✓ Raw button ratchet: ${rawButtonCount} remaining, none new.`);
  }

  if (hits > 0) {
    console.error(`\n✗ ${hits} UI invariant violation(s).`);
    process.exit(1);
  }
  console.log(
    `✓ UI invariants clean — touch targets, enum text, english copy, accents OK across ${TOUCH_TARGET_FILES.length}+${STANDARD_FILES.length} files.`,
  );
}

// Guard: only execute scan when this file is run directly.
// When imported by tests, the exports (regexes/helpers) are available without
// triggering the filesystem scan.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-ui-invariants.ts") ||
    process.argv[1].endsWith("check-ui-invariants.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}

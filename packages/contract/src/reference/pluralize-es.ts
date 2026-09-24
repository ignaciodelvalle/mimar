// Spanish count agreement — the ONE place it lives.
//
// Dozens of surfaces inlined `${n} evento${n === 1 ? "" : "s"}`-shaped
// ternaries — each one a chance to pick the wrong suffix ("señals",
// "animals") or drift in wording. scripts/check-pluralize-es.ts bans new
// ad-hoc ternaries. It lives in @dim/contract (not lib/utils/format.ts, which
// re-exports it) so the citizen app and the contract package itself can use
// the same function: the package is pure and may not import from the web app.

/**
 * Pluralize a Spanish noun by count: returns `singular` when `n === 1`, else
 * the plural form.
 *
 * Default plural (when `plural` is omitted) follows the regular rules:
 *   - ends in "z"  → "-ces"  ("vez" → "veces")
 *   - ends in a vowel (incl. accented) → "+s" ("evento" → "eventos")
 *   - otherwise → "+es" ("señal" → "señales", "mes" → "meses")
 *
 * Pass `plural` explicitly for irregulars the rules cannot derive — accent
 * shifts ("camión" → "camiones"), invariants ("lunes" → "lunes"), or
 * multi-word phrases ("regla provincial" → "reglas provinciales").
 */
export function pluralizeEs(n: number, singular: string, plural?: string): string {
  if (n === 1) return singular;
  if (plural !== undefined) return plural;
  if (/z$/i.test(singular)) return `${singular.slice(0, -1)}ces`;
  if (/[aeiouáéíóú]$/i.test(singular)) return `${singular}s`;
  return `${singular}es`;
}

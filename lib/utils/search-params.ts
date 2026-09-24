// Collapsing Next.js `searchParams` values to a single string.
//
// In the App Router a searchParam is `string | string[] | undefined` at
// RUNTIME: Next hands back an ARRAY the moment a key repeats in the query
// string (`?chip=a&chip=b`). Page files routinely declare the prop as
// `Promise<{ chip?: string }>` — TypeScript is then perfectly happy with
// `sp.chip?.trim()`, and the page 500s with `sp.chip.trim is not a function`
// as soon as somebody pastes a link that duplicates a key. It fails CLOSED
// (nothing is filtered, nothing leaks) but the user sees a raw error screen.
//
// `?.` and `?? ""` do NOT protect against this: an array is neither null nor
// undefined, and `[] ?? x` is `[]`.
//
// Convention: FIRST value wins. That matches the two hand-rolled `pick`
// closures this replaces (lib/infra/lost-listing.ts, lib/infra/adoption-
// listing.ts) and the way a human reads `?q=perro&q=gato` — the first one is
// what they typed, the rest is link-copying noise.

/** The runtime type of a single Next.js App Router search param. */
export type RawSearchParam = string | string[] | undefined;

/**
 * Collapses a possibly-repeated search param to its first value.
 *
 * Returns `undefined` for an absent param AND for an empty array, so callers
 * can keep treating "missing" as one case.
 */
export function firstSearchParam(value: RawSearchParam): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * `firstSearchParam` + `.trim()`, collapsing whitespace-only values to
 * `undefined`. The overwhelmingly common shape at call sites:
 * `const q = trimmedSearchParam(sp.q) ?? ""`.
 */
export function trimmedSearchParam(value: RawSearchParam): string | undefined {
  const first = firstSearchParam(value);
  if (first === undefined) return undefined;
  const trimmed = first.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

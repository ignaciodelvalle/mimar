// The DIM public-token shape, in one place.
//
// `DIM-XXXX-XXXX` — the credential token that resolves to a pet's public page.
// Invariant #1 ("the pet is the credential") makes this shape load-bearing, so
// it had drifted into five private copies (omnibox server + client, decomiso
// lookup, denuncia public lookup, Atender access) — all now import from here.
//
// This module holds NO dependencies on purpose: the omnibox needs the shape on
// both sides of the wire, and the server module that used to own it imports the
// database — so a client importing from there would drag `db` into the browser
// bundle. Keep it dependency-free or the duplication comes back.

/** `DIM-XXXX-XXXX`, case-insensitive. Anchored: a full-string match, not a scan. */
export const DIM_TOKEN_PATTERN = /^DIM-[A-Z0-9]{4}-[A-Z0-9]{4}$/i;

/** True when `value` is exactly a DIM public token (surrounding space ignored). */
export function isDimToken(value: string): boolean {
  return DIM_TOKEN_PATTERN.test(value.trim());
}

/**
 * Trim + uppercase, ASCII letters ONLY — the one input normaliser for a typed
 * or pasted DIM code.
 *
 * WHY NOT `toUpperCase()`. It is a Unicode case mapping: the Turkish dotless
 * `ı` becomes `I`, the long `ſ` becomes `S`, and `ﬀ` becomes two letters. A
 * normaliser built on it turns a lookalike string nobody was issued into a
 * real token, so a URL that is visibly NOT a pet's code resolves to that pet —
 * and, at the edge (`middleware.ts`), would be 308-redirected onto it. Every
 * token this system issues is plain ASCII (lib/infra/publicToken.ts), so the
 * only case folding that can ever be legitimate is `a-z` → `A-Z`; anything else
 * is left as typed and fails the shape check downstream.
 */
export function normalizeDimTokenInput(raw: string): string {
  return raw.trim().replace(/[a-z]/g, (c) => c.toUpperCase());
}

/** The canonical, issued shape: uppercase only, no surrounding space. */
const CANONICAL_DIM_TOKEN = /^DIM-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/**
 * The canonical spelling of a DIM code, or `null` when the input is not one.
 *
 * `null` means "do not canonicalise": the caller answers the input as typed
 * (which for `/p/{token}` is a 404). It is deliberately NOT "the uppercased
 * garbage" — a redirect is a claim that the destination is the same resource,
 * and only a string of the token's own shape can be the same resource.
 *
 * `[A-Z0-9]` and not the 31-character issuing alphabet, on purpose: seeded and
 * demo tokens (`DIM-PAMP-0001`) carry `0` and `1`, and DIM_TOKEN_PATTERN above
 * already made the same call for the same reason.
 */
export function canonicalDimToken(raw: string): string | null {
  const normalized = normalizeDimTokenInput(raw);
  return CANONICAL_DIM_TOKEN.test(normalized) ? normalized : null;
}

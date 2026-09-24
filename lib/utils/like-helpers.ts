/**
 * SQL LIKE / ILIKE input sanitization.
 *
 * PostgreSQL LIKE patterns treat `%` and `_` as wildcards; a user-supplied
 * substring must have those characters escaped so they match literally.
 * The escape character `\` is chosen (standard SQL convention).
 *
 * Usage with Drizzle:
 *   ilike(column, likeContains(userInput))
 *   // → ILIKE '%some\_value%'
 */
export function escapeLike(raw: string): string {
  // Escape backslash first, then the two wildcard characters.
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Wraps a pre-escaped value in `%...%` for a contains-style ILIKE search. */
export function likeContains(raw: string): string {
  return `%${escapeLike(raw)}%`;
}

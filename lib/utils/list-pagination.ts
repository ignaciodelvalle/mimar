// Shared "fetch N+1, cap at N, flag truncation" list-pagination stopgap.
//
// This is the pattern adopciones/page.tsx pioneered (UX 3.6 (d)): rather than
// a bare `.limit(N)` that silently drops rows past the cap with zero signal,
// query for N+1 rows and use this helper to cap the rendered set at N while
// exposing whether more rows exist. #815 audit findings #1/#2/#5/#7/#8/#15
// extended this same pattern to mascotas, transferencias (both directions),
// voluntarios (pool + propuestas), miembros, and servicios — this helper
// centralizes the cap/truncate arithmetic so it isn't hand-rolled six times.
//
// This is a stopgap, not real pagination: callers still fetch up to
// `pageSize + 1` rows per request. Real keyset cursor pagination
// (lib/utils/keyset-pagination.ts) is the follow-up for routes that need to
// actually page through a result set rather than just bound what renders.

export type CappedPage<T> = {
  /** At most `pageSize` rows. */
  rows: T[];
  /** True when the input had more than `pageSize` rows (i.e. more exist). */
  truncated: boolean;
};

/**
 * Caps `rows` at `pageSize`, flagging whether the input exceeded it.
 *
 * Callers are expected to fetch `pageSize + 1` rows (or more) before calling
 * this — `capRows` itself does not query anything, it only slices and flags.
 */
export function capRows<T>(rows: T[], pageSize: number): CappedPage<T> {
  const truncated = rows.length > pageSize;
  return {
    rows: truncated ? rows.slice(0, pageSize) : rows,
    truncated,
  };
}

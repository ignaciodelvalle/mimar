// PANO_PROVINCE_BOOST parser — pure helper for scripts/seed-panorama.ts.
//
// Format: comma-separated "Provincia:multiplier" entries, e.g.
//
//   PANO_PROVINCE_BOOST="Buenos Aires:3"
//   PANO_PROVINCE_BOOST="Buenos Aires:3,Santa Fe:1.5"
//
// The multiplier scales the per-province pet allocation AFTER the
// population-weighted split (see seedPets in seed-panorama.ts), ONLY for the
// listed provinces. Unknown province names FAIL FAST: a typo that silently
// no-ops would look exactly like "the boost didn't work" and cost a full
// seed run to discover.
//
// Kept in its own module (db-free, env-free, side-effect-free) so it can be
// unit-tested without importing seed-panorama.ts, whose module body runs env
// guards and opens a DB connection at import time. Mirrors the
// seed-history-utils.ts pattern (pure helpers + colocated test).

export class ProvinceBoostParseError extends Error {}

/**
 * Parses the PANO_PROVINCE_BOOST env value into a province → multiplier map.
 *
 * - `undefined` / empty / whitespace-only input → empty map (no boost).
 * - Entries are trimmed; empty entries (trailing commas) are tolerated.
 * - The LAST colon splits province from multiplier, so province names that
 *   ever carry a colon still parse.
 * - Throws ProvinceBoostParseError on: malformed entries, unknown province
 *   names (validated against `knownProvinces`), non-positive or non-numeric
 *   multipliers, and duplicated provinces.
 */
export function parseProvinceBoost(
  raw: string | undefined,
  knownProvinces: readonly string[],
): Map<string, number> {
  const boosts = new Map<string, number>();
  if (!raw || raw.trim() === "") return boosts;

  const known = new Set(knownProvinces);

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue; // tolerate trailing/double commas

    const sep = trimmed.lastIndexOf(":");
    if (sep === -1) {
      throw new ProvinceBoostParseError(
        `PANO_PROVINCE_BOOST: entry "${trimmed}" is not in "Provincia:multiplier" form.`,
      );
    }

    const province = trimmed.slice(0, sep).trim();
    const multiplierRaw = trimmed.slice(sep + 1).trim();

    if (!known.has(province)) {
      throw new ProvinceBoostParseError(
        `PANO_PROVINCE_BOOST: unknown province "${province}". ` +
          `Valid names: ${[...knownProvinces].join(", ")}.`,
      );
    }

    const multiplier = Number(multiplierRaw);
    if (multiplierRaw === "" || !Number.isFinite(multiplier) || multiplier <= 0) {
      throw new ProvinceBoostParseError(
        `PANO_PROVINCE_BOOST: multiplier for "${province}" must be a positive number ` +
          `(got "${multiplierRaw}").`,
      );
    }

    if (boosts.has(province)) {
      throw new ProvinceBoostParseError(
        `PANO_PROVINCE_BOOST: province "${province}" is listed more than once.`,
      );
    }

    boosts.set(province, multiplier);
  }

  return boosts;
}

/**
 * Applies a parsed boost to a base per-province allocation. Kept pure so the
 * seed's real allocation, its --dry-run preview, and the unit test all share
 * the exact same arithmetic (Math.round, floor of 1).
 */
export function boostedProvinceCount(
  baseCount: number,
  provinceName: string,
  boosts: ReadonlyMap<string, number>,
): number {
  const multiplier = boosts.get(provinceName) ?? 1;
  if (multiplier === 1) return baseCount;
  return Math.max(1, Math.round(baseCount * multiplier));
}

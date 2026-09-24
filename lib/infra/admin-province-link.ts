// Pure helper: maps a province name to a drill-down URL for the admin panorama page.
//
// /admin/panorama accepts ?province=<ISO code> and narrows the map + KPIs to
// that province. We resolve the code via provinceByName so the link works even
// when the province name comes from a DB text column.
//
// Returns null when the province name cannot be resolved (e.g. suppressed or
// unknown), so callers can fall back to plain text instead of a dead link.

import { PROVINCES, provinceByName } from "@/lib/reference/ar-provincias";

/**
 * Resolve a province display name to the URL of the admin panorama page
 * filtered to that province.
 *
 * @param provinceName - Province name as stored in the DB (e.g. "Buenos Aires").
 * @returns  Absolute-path URL string, or null when the name is unresolvable.
 */
export function adminProvinceHref(provinceName: string | null | undefined): string | null {
  if (!provinceName) return null;
  const province = provinceByName(provinceName);
  if (!province) return null;
  return `/admin/panorama?province=${encodeURIComponent(province.code)}`;
}

/**
 * Govt-portal twin of {@link adminProvinceHref}: resolves a province display
 * name to the /gob/panorama drill URL. /gob/panorama accepts the same ?province=
 * <code> param and applies its own govt-scope guard, so the link is safe for a
 * bounded operator. Returns null when the name is unresolvable (plain-text fallback).
 */
export function govtProvinceHref(provinceName: string | null | undefined): string | null {
  if (!provinceName) return null;
  const province = provinceByName(provinceName);
  if (!province) return null;
  return `/gob/panorama?province=${encodeURIComponent(province.code)}`;
}

/**
 * All known province names from the static registry, sorted alphabetically.
 * Useful for building options lists.
 */
export const PROVINCE_NAMES: readonly string[] = [...PROVINCES]
  .map((p) => p.name)
  .sort((a, b) => a.localeCompare(b, "es-AR"));

// IP-area geolocation for credential scans — Task #45 (PO decision, engram obs #733).
//
// PRIVACY CONTRACT (AGENTS.md §Privacidad → Scan events):
//   - Derives a COARSE area (city precision max) from the platform-provided
//     geo headers that Vercel's edge attaches to every request.
//   - The raw IP address is NEVER read, stored, or hashed here. Only the
//     pre-resolved city/region/country strings are used.
//   - The result is attached to scanner-role credential_scanned payloads,
//     which are hard-anonymized (recorded_by_user_id = NULL) and purged at
//     90 days (lib/infra/scan-retention.ts).
//
// Locally (supabase/next dev) the headers are absent → returns null. That is
// the expected floor outside Vercel; the scan event is still recorded.

/** Coarse IP-derived area. City precision max — never street-level. */
export type ScanIpArea = {
  city: string | null;
  region: string | null;
  country: string | null;
};

// Vercel geo headers (values are URI-encoded, e.g. "Buenos%20Aires").
// https://vercel.com/docs/edge-network/headers/request-headers
const CITY_HEADER = "x-vercel-ip-city";
const REGION_HEADER = "x-vercel-ip-country-region";
const COUNTRY_HEADER = "x-vercel-ip-country";

/** Max length guard so a spoofed header cannot bloat the event payload. */
const MAX_FIELD_LENGTH = 120;

function decodeGeoHeader(value: string | null): string | null {
  if (!value) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    decoded = value; // malformed encoding — keep the raw label
  }
  const trimmed = decoded.trim().slice(0, MAX_FIELD_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Reads the coarse IP-derived area from request headers.
 *
 * Returns null when no geo header is present (local dev, non-Vercel hosts),
 * so callers can store an explicit `scan_ip_area: null`.
 */
export function ipAreaFromHeaders(h: { get(name: string): string | null }): ScanIpArea | null {
  const city = decodeGeoHeader(h.get(CITY_HEADER));
  const region = decodeGeoHeader(h.get(REGION_HEADER));
  const country = decodeGeoHeader(h.get(COUNTRY_HEADER));
  if (!city && !region && !country) return null;
  return { city, region, country };
}

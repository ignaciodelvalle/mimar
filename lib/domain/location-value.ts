// Canonical location value for the location domain (P1 — capture contract).
//
// parseLocationFromFormData replaces ~14 duplicated formData.get blocks
// across action files. Each site keeps its own canonicalization / validation
// calls unchanged — only the raw field reads are replaced.
//
// Wire names expected by the standard LocationFields component:
//   provinceCode        — ISO code (e.g. "AR-C")
//   provinceName        — display name (e.g. "CABA")
//   localityName        — locality display name
//   localityNameIndecId — INDEC locality ID
//   locationLat         — WGS-84 latitude, decimal string
//   locationLng         — WGS-84 longitude, decimal string
//   locationAddress     — free-text address label

export type LocationValue = {
  /** Display name from the `provinceName` wire field. */
  province: string | null;
  /** ISO code from the `provinceCode` wire field (e.g. "AR-C"). */
  provinceCode: string | null;
  /** Locality display name from the `localityName` wire field. */
  locality: string | null;
  /** INDEC locality ID from the `localityNameIndecId` wire field. */
  localityIndecId: string | null;
  lat: number | null;
  lng: number | null;
  /** Free-text address from the `locationAddress` wire field. */
  address: string | null;
};

function parseString(value: unknown): string | null {
  return String(value ?? "").trim() || null;
}

function parseCoord(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a {@link LocationValue} from a standard {@link FormData} payload.
 *
 * Semantics per field:
 * - Strings: `String(fd.get(field) ?? "").trim() || null`
 * - Coordinates: `Number.parseFloat(raw)` -> `null` when empty or NaN
 */
export function parseLocationFromFormData(fd: FormData): LocationValue {
  const latRaw = String(fd.get("locationLat") ?? "").trim();
  const lngRaw = String(fd.get("locationLng") ?? "").trim();

  return {
    province: parseString(fd.get("provinceName")),
    provinceCode: parseString(fd.get("provinceCode")),
    locality: parseString(fd.get("localityName")),
    localityIndecId: parseString(fd.get("localityNameIndecId")),
    lat: parseCoord(latRaw || null),
    lng: parseCoord(lngRaw || null),
    address: parseString(fd.get("locationAddress")),
  };
}

/**
 * Parse a {@link LocationValue} from a plain object.
 *
 * Accepts both key vocabularies:
 * - Standard wire names: `provinceCode`, `provinceName`, `localityName`,
 *   `localityNameIndecId`, `locationLat`, `locationLng`, `locationAddress`
 * - AssignLocalityForm names: `province` (-> province display name),
 *   `locality` (-> locality display name)
 */
export function parseLocationFromObject(o: Record<string, unknown>): LocationValue {
  // Accept both key vocabularies for province display name.
  const province = parseString(o.provinceName ?? o.province);
  // Accept both key vocabularies for locality display name.
  const locality = parseString(o.localityName ?? o.locality);

  const latRaw = String(o.locationLat ?? "").trim();
  const lngRaw = String(o.locationLng ?? "").trim();

  return {
    province,
    provinceCode: parseString(o.provinceCode),
    locality,
    localityIndecId: parseString(o.localityNameIndecId),
    lat: parseCoord(latRaw || null),
    lng: parseCoord(lngRaw || null),
    address: parseString(o.locationAddress),
  };
}

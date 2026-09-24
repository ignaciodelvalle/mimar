/**
 * Geographic join normalizer for multi-level choropleth drill-down.
 *
 * This module solves the "feature ↔ datum" matching problem at each geographic
 * level, where code formats differ:
 *
 *  - Province:   ISO 3166-2:AR codes, e.g. "AR-C", "AR-B"  (ar-provinces.geojson)
 *  - Department: INDEC 5-digit codes, e.g. "02001", "06007" (ar-departments.geojson)
 *                First 2 digits = INDEC province code.
 *                CABA = "02"; Buenos Aires = "06"; etc.
 *  - Barrio:     CABA-specific slugs, e.g. "agronomia", "palermo" (caba-barrios.geojson)
 *
 * The join is explicit and auditable: any datum that does not match a GeoJSON
 * feature is captured in `orphanData` (not silently dropped). Any feature that
 * does not match a datum is flagged as `missingData` so it can be rendered in
 * the "no data" color. This was a real bug in v1 — the join silently dropped
 * unmatched data.
 *
 * Normalizers are per-level so tests can exercise each independently.
 */

// ---------------------------------------------------------------------------
// GeoJSON level
// ---------------------------------------------------------------------------

export type GeoLevel = "province" | "department" | "barrio";

// ---------------------------------------------------------------------------
// Normalizers — one per level
// ---------------------------------------------------------------------------

/**
 * Province codes in the GeoJSON are "AR-X". Data codes may arrive as "AR-X"
 * (ISO standard) or as bare INDEC province codes ("02", "06", etc.).
 *
 * This normalizer canonicalizes both to uppercase "AR-X" form for matching.
 */
export function normalizeProvinceCode(raw: string): string {
  const upper = raw.trim().toUpperCase();
  // Already ISO: "AR-C", "AR-B", "AR-X"
  if (/^AR-[A-Z]$/.test(upper)) return upper;
  // INDEC 2-digit → look up the ISO code
  const iso = INDEC_PROV_TO_ISO[upper.replace(/^0/, "").padStart(2, "0")];
  return iso ?? upper;
}

/**
 * Department codes in both GeoJSON and data are INDEC 5-digit strings.
 * Some sources zero-pad; others don't. Normalizes to 5-digit zero-padded.
 */
export function normalizeDepartmentCode(raw: string): string {
  const trimmed = raw.trim();
  // Pure numeric: zero-pad to 5
  if (/^\d+$/.test(trimmed)) return trimmed.padStart(5, "0");
  return trimmed;
}

/**
 * CABA barrio codes in the GeoJSON are lowercase slugs ("agronomia", "la boca",
 * "velez sarsfield"). Data codes may arrive with accents, mixed case, dots, or
 * padded whitespace. This is the CANONICAL barrio normalizer for the whole
 * codebase: strip accents → lowercase → drop dots → collapse whitespace → trim.
 *
 * It is the single source of truth so every surface that joins a locality/barrio
 * name to caba-barrios.geojson (MapChoropleth's hierarchical join, the govt
 * dashboards' `fetchCasesPerSubregion`, and the Panorama locality choropleth
 * fill) computes the SAME slug. Previously `lib/analytics/govt-dashboards.ts`
 * carried a divergent copy (it stripped dots + collapsed whitespace; this one
 * did not) — that copy now delegates here. Idempotent on an already-normalized
 * slug, so it is safe to apply to both sides of a join.
 */
export function normalizeBarioCode(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// INDEC province code → ISO 3166-2:AR mapping
// ---------------------------------------------------------------------------

/**
 * Maps the 2-digit INDEC province code to the ISO 3166-2:AR code used in the
 * ar-provinces.geojson. This mapping is stable — it is defined by INDEC and
 * does not change.
 *
 * Source: INDEC Diccionario de Jurisdicciones Provinciales (2023 edition).
 */
export const INDEC_PROV_TO_ISO: Readonly<Record<string, string>> = {
  "02": "AR-C", // Ciudad Autónoma de Buenos Aires
  "06": "AR-B", // Buenos Aires
  "10": "AR-K", // Catamarca
  "14": "AR-X", // Córdoba
  "18": "AR-W", // Corrientes
  "22": "AR-H", // Chaco
  "26": "AR-U", // Chubut
  "30": "AR-E", // Entre Ríos
  "34": "AR-P", // Formosa
  "38": "AR-Y", // Jujuy
  "42": "AR-L", // La Pampa
  "46": "AR-F", // La Rioja
  "50": "AR-M", // Mendoza
  "54": "AR-N", // Misiones
  "58": "AR-Q", // Neuquén
  "62": "AR-R", // Río Negro
  "66": "AR-A", // Salta
  "70": "AR-J", // San Juan
  "74": "AR-D", // San Luis
  "78": "AR-Z", // Santa Cruz
  "82": "AR-S", // Santa Fe
  "86": "AR-G", // Santiago del Estero
  "90": "AR-T", // Tucumán
  "94": "AR-V", // Tierra del Fuego
} as const;

/** Reverse mapping: ISO → INDEC 2-digit province code. */
export const ISO_TO_INDEC_PROV: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(INDEC_PROV_TO_ISO).map(([k, v]) => [v, k]),
);

// ---------------------------------------------------------------------------
// Join result types
// ---------------------------------------------------------------------------

/** A GeoJSON feature enriched with a datum value (or flagged missing). */
export type JoinedFeature = {
  /** The feature's normalized code. */
  code: string;
  /** Original GeoJSON properties. */
  properties: Record<string, unknown>;
  /** Matched datum value; undefined if no datum matched. */
  value?: number;
  /** Matched datum label; undefined if no datum matched. */
  label?: string;
  /** True when no datum was found for this feature (render as no-data). */
  missingData: boolean;
  /** True when the datum was suppressed (< k-anonymity threshold). */
  suppressed: boolean;
};

/** Data that had no matching GeoJSON feature. */
export type OrphanDatum = {
  code: string;
  value: number;
  label?: string;
};

export type JoinReport = {
  /** Features with enriched data (or flagged missing/suppressed). */
  features: JoinedFeature[];
  /** Data records that didn't match any feature. */
  orphanData: OrphanDatum[];
};

// ---------------------------------------------------------------------------
// Core join function
// ---------------------------------------------------------------------------

export type RawDatum = {
  code: string;
  value: number;
  label?: string;
  suppressed?: boolean;
};

export type GeoFeatureProps = {
  code?: string;
  [key: string]: unknown;
};

/**
 * Joins an array of data records against GeoJSON feature properties, producing
 * a `JoinReport` that makes both unmatched features and unmatched data explicit.
 *
 * @param features   - Array of GeoJSON Feature objects (from a FeatureCollection).
 * @param data       - Domain data records to join against the features.
 * @param level      - Geographic level determines the code normalizer.
 * @param codeKey    - Property key on `feature.properties` that holds the code.
 *                     Defaults to "code" (correct for all three GeoJSON files in /public/geo/).
 */
export function joinChoroplethData(
  features: GeoJSON.Feature[],
  data: RawDatum[],
  level: GeoLevel,
  codeKey = "code",
): JoinReport {
  const normalize = normalizerForLevel(level);

  // Build a lookup from normalized data code → datum
  const dataMap = new Map<string, RawDatum>();
  const usedDataCodes = new Set<string>();

  for (const datum of data) {
    const normalizedCode = normalize(datum.code);
    // Last-wins for duplicate codes (defensive; shouldn't happen in practice)
    dataMap.set(normalizedCode, datum);
  }

  // Process each GeoJSON feature
  const joined: JoinedFeature[] = [];

  for (const feature of features) {
    const props = (feature.properties ?? {}) as GeoFeatureProps;
    const rawCode = String(props[codeKey] ?? "");
    const normalizedCode = normalize(rawCode);

    const datum = dataMap.get(normalizedCode);

    if (datum !== undefined) {
      usedDataCodes.add(normalizedCode);
      joined.push({
        code: normalizedCode,
        properties: props as Record<string, unknown>,
        value: datum.value,
        label: datum.label,
        missingData: false,
        suppressed: datum.suppressed ?? false,
      });
    } else {
      joined.push({
        code: normalizedCode,
        properties: props as Record<string, unknown>,
        missingData: true,
        suppressed: false,
      });
    }
  }

  // Collect orphan data (data records with no matching feature)
  const orphanData: OrphanDatum[] = [];
  for (const [normalizedCode, datum] of dataMap.entries()) {
    if (!usedDataCodes.has(normalizedCode)) {
      orphanData.push({
        code: datum.code, // original code for human-readable reporting
        value: datum.value,
        label: datum.label,
      });
    }
  }

  return { features: joined, orphanData };
}

// ---------------------------------------------------------------------------
// Normalizer selector
// ---------------------------------------------------------------------------

export function normalizerForLevel(level: GeoLevel): (code: string) => string {
  switch (level) {
    case "province":
      return normalizeProvinceCode;
    case "department":
      return normalizeDepartmentCode;
    case "barrio":
      return normalizeBarioCode;
  }
}

// ---------------------------------------------------------------------------
// Province → departments filtering helper
// ---------------------------------------------------------------------------

/**
 * Given a province ISO code (e.g. "AR-B"), returns the INDEC 2-digit prefix
 * used to filter departments in ar-departments.geojson.
 *
 * Department codes are 5-digit INDEC: first 2 digits = province INDEC code.
 * Returns null for unknown provinces.
 */
export function provinceDepartmentPrefix(provinceIso: string): string | null {
  const upperIso = provinceIso.trim().toUpperCase();
  return ISO_TO_INDEC_PROV[upperIso] ?? null;
}

/**
 * Returns true if a department code (5-digit INDEC) belongs to the province
 * identified by its ISO code.
 */
export function departmentBelongsToProvince(deptCode: string, provinceIso: string): boolean {
  const prefix = provinceDepartmentPrefix(provinceIso);
  if (!prefix) return false;
  const normalized = normalizeDepartmentCode(deptCode);
  return normalized.startsWith(prefix);
}

// ---------------------------------------------------------------------------
// CABA special case: province "AR-C" drills to barrios (not departments)
// ---------------------------------------------------------------------------

/**
 * CABA (AR-C) is a single department in the INDEC scheme (code "02").
 * The drill-down from CABA province goes directly to barrios, not departments.
 */
export function isCABA(provinceIso: string): boolean {
  return provinceIso.trim().toUpperCase() === "AR-C";
}

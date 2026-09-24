/**
 * Tests for lib/geo-join.ts — per-level code normalizer and choropleth join.
 *
 * This covers the real prior bug: the join silently dropped data records that
 * didn't match any GeoJSON feature (e.g., a department code with 4 digits
 * instead of 5, or a CABA barrio with an accent vs. a slug).
 *
 * Test coverage:
 *  1. Province normalizer — ISO, bare INDEC, case variants
 *  2. Department normalizer — zero-padding, numeric strings
 *  3. Barrio normalizer — accents, mixed case
 *  4. joinChoroplethData — per level:
 *     a. Matched features get value/label
 *     b. Features with no data are flagged missingData=true
 *     c. Data with no feature land in orphanData (not silently dropped)
 *     d. Suppressed flag propagates
 */

import {
  departmentBelongsToProvince,
  isCABA,
  joinChoroplethData,
  normalizeBarioCode,
  normalizeDepartmentCode,
  normalizeProvinceCode,
  provinceDepartmentPrefix,
} from "@/lib/infra/geo-join";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Province normalizer
// ---------------------------------------------------------------------------

describe("normalizeProvinceCode", () => {
  it("passes through valid ISO codes unchanged", () => {
    expect(normalizeProvinceCode("AR-C")).toBe("AR-C");
    expect(normalizeProvinceCode("AR-B")).toBe("AR-B");
    expect(normalizeProvinceCode("AR-S")).toBe("AR-S");
  });

  it("uppercases lowercase ISO codes", () => {
    expect(normalizeProvinceCode("ar-c")).toBe("AR-C");
    expect(normalizeProvinceCode("ar-b")).toBe("AR-B");
  });

  it("converts INDEC 2-digit province code to ISO", () => {
    expect(normalizeProvinceCode("02")).toBe("AR-C"); // CABA
    expect(normalizeProvinceCode("06")).toBe("AR-B"); // Buenos Aires
    expect(normalizeProvinceCode("82")).toBe("AR-S"); // Santa Fe
    expect(normalizeProvinceCode("14")).toBe("AR-X"); // Córdoba
  });

  it("handles zero-padded INDEC codes", () => {
    expect(normalizeProvinceCode("2")).toBe("AR-C");
    expect(normalizeProvinceCode("6")).toBe("AR-B");
  });

  it("trims whitespace", () => {
    expect(normalizeProvinceCode(" AR-C ")).toBe("AR-C");
    expect(normalizeProvinceCode("  02  ")).toBe("AR-C");
  });

  it("returns the input for unknown codes (does not throw)", () => {
    const result = normalizeProvinceCode("XX-Z");
    expect(typeof result).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Department normalizer
// ---------------------------------------------------------------------------

describe("normalizeDepartmentCode", () => {
  it("pads short numeric codes to 5 digits", () => {
    expect(normalizeDepartmentCode("6007")).toBe("06007");
    expect(normalizeDepartmentCode("7")).toBe("00007");
    expect(normalizeDepartmentCode("14056")).toBe("14056");
  });

  it("passes through already-padded 5-digit codes", () => {
    expect(normalizeDepartmentCode("06007")).toBe("06007");
    expect(normalizeDepartmentCode("82049")).toBe("82049");
  });

  it("trims whitespace", () => {
    expect(normalizeDepartmentCode(" 06007 ")).toBe("06007");
  });

  it("preserves non-numeric codes as-is (graceful degradation)", () => {
    const result = normalizeDepartmentCode("UNKNOWN");
    expect(result).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// Barrio normalizer
// ---------------------------------------------------------------------------

describe("normalizeBarioCode", () => {
  it("lowercases codes", () => {
    expect(normalizeBarioCode("Palermo")).toBe("palermo");
    expect(normalizeBarioCode("AGRONOMIA")).toBe("agronomia");
  });

  it("strips accents to match GeoJSON slugs", () => {
    expect(normalizeBarioCode("Agronomía")).toBe("agronomia");
    expect(normalizeBarioCode("Vélez Sársfield")).toBe("velez sarsfield");
    expect(normalizeBarioCode("Núñez")).toBe("nunez");
  });

  it("trims whitespace", () => {
    expect(normalizeBarioCode(" palermo ")).toBe("palermo");
  });

  it("handles already-clean slugs", () => {
    expect(normalizeBarioCode("agronomia")).toBe("agronomia");
    expect(normalizeBarioCode("villa-lugano")).toBe("villa-lugano");
  });
});

// ---------------------------------------------------------------------------
// provinceDepartmentPrefix / departmentBelongsToProvince
// ---------------------------------------------------------------------------

describe("provinceDepartmentPrefix", () => {
  it("returns the INDEC 2-digit prefix for a known ISO code", () => {
    expect(provinceDepartmentPrefix("AR-B")).toBe("06");
    expect(provinceDepartmentPrefix("AR-C")).toBe("02");
    expect(provinceDepartmentPrefix("AR-X")).toBe("14");
  });

  it("returns null for unknown province codes", () => {
    expect(provinceDepartmentPrefix("AR-ZZ")).toBeNull();
  });
});

describe("departmentBelongsToProvince", () => {
  it("correctly identifies Buenos Aires departments (prefix 06)", () => {
    expect(departmentBelongsToProvince("06007", "AR-B")).toBe(true);
    expect(departmentBelongsToProvince("06014", "AR-B")).toBe(true);
    expect(departmentBelongsToProvince("14056", "AR-B")).toBe(false);
  });

  it("correctly identifies CABA departments (prefix 02)", () => {
    expect(departmentBelongsToProvince("02001", "AR-C")).toBe(true);
    expect(departmentBelongsToProvince("06007", "AR-C")).toBe(false);
  });

  it("normalizes dept code before prefix check", () => {
    expect(departmentBelongsToProvince("6007", "AR-B")).toBe(true); // zero-padded
  });
});

describe("isCABA", () => {
  it("identifies CABA province", () => {
    expect(isCABA("AR-C")).toBe(true);
    expect(isCABA("ar-c")).toBe(true);
  });

  it("does not match other provinces", () => {
    expect(isCABA("AR-B")).toBe(false);
    expect(isCABA("AR-X")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// joinChoroplethData — province level
// ---------------------------------------------------------------------------

describe("joinChoroplethData — province level", () => {
  const features: GeoJSON.Feature[] = [
    {
      type: "Feature",
      properties: { code: "AR-C", name: "CABA" },
      geometry: null as unknown as GeoJSON.Geometry,
    },
    {
      type: "Feature",
      properties: { code: "AR-B", name: "Buenos Aires" },
      geometry: null as unknown as GeoJSON.Geometry,
    },
    {
      type: "Feature",
      properties: { code: "AR-X", name: "Córdoba" },
      geometry: null as unknown as GeoJSON.Geometry,
    },
  ];

  it("matches data to features by normalized province code", () => {
    const data = [
      { code: "AR-C", value: 150, label: "CABA" },
      { code: "AR-B", value: 320 },
    ];
    const { features: joined } = joinChoroplethData(features, data, "province");

    const caba = joined.find((f) => f.code === "AR-C");
    expect(caba?.value).toBe(150);
    expect(caba?.missingData).toBe(false);

    const ba = joined.find((f) => f.code === "AR-B");
    expect(ba?.value).toBe(320);
  });

  it("flags features with no matching data as missingData=true", () => {
    const data = [{ code: "AR-C", value: 10 }];
    const { features: joined } = joinChoroplethData(features, data, "province");

    const cordoba = joined.find((f) => f.code === "AR-X");
    expect(cordoba?.missingData).toBe(true);
    expect(cordoba?.value).toBeUndefined();
  });

  it("captures data with no matching feature in orphanData — not silently dropped", () => {
    const data = [
      { code: "AR-C", value: 10 },
      { code: "AR-ZZ", value: 999, label: "Invented province" }, // no matching feature
    ];
    const { orphanData } = joinChoroplethData(features, data, "province");

    expect(orphanData).toHaveLength(1);
    expect(orphanData[0].code).toBe("AR-ZZ");
    expect(orphanData[0].value).toBe(999);
  });

  it("propagates the suppressed flag from datum", () => {
    const data = [{ code: "AR-C", value: 3, suppressed: true }];
    const { features: joined } = joinChoroplethData(features, data, "province");

    const caba = joined.find((f) => f.code === "AR-C");
    expect(caba?.suppressed).toBe(true);
  });

  it("handles lowercase ISO codes in data (normalizer applied)", () => {
    const data = [{ code: "ar-c", value: 77 }];
    const { features: joined } = joinChoroplethData(features, data, "province");

    const caba = joined.find((f) => f.code === "AR-C");
    expect(caba?.value).toBe(77);
    expect(caba?.missingData).toBe(false);
  });

  it("handles INDEC 2-digit codes in data", () => {
    const data = [{ code: "02", value: 88 }]; // INDEC code for CABA
    const { features: joined } = joinChoroplethData(features, data, "province");

    const caba = joined.find((f) => f.code === "AR-C");
    expect(caba?.value).toBe(88);
  });

  it("returns an empty orphanData array when all data matches", () => {
    const data = features.map((f, i) => ({
      code: (f.properties as { code: string }).code,
      value: i + 1,
    }));
    const { orphanData } = joinChoroplethData(features, data, "province");
    expect(orphanData).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// joinChoroplethData — department level
// ---------------------------------------------------------------------------

describe("joinChoroplethData — department level", () => {
  const g = null as unknown as GeoJSON.Geometry;
  const features: GeoJSON.Feature[] = [
    { type: "Feature", properties: { code: "06007", name: "Adolfo Alsina" }, geometry: g },
    { type: "Feature", properties: { code: "06014", name: "Adolfo González Chaves" }, geometry: g },
    { type: "Feature", properties: { code: "14056", name: "Capital" }, geometry: g },
  ];

  it("matches 5-digit department codes", () => {
    const data = [{ code: "06007", value: 42 }];
    const { features: joined } = joinChoroplethData(features, data, "department");
    const dept = joined.find((f) => f.code === "06007");
    expect(dept?.value).toBe(42);
    expect(dept?.missingData).toBe(false);
  });

  it("normalizes 4-digit codes by zero-padding before matching", () => {
    // Data arrives without leading zero — should still match feature "06007"
    const data = [{ code: "6007", value: 55 }];
    const { features: joined } = joinChoroplethData(features, data, "department");
    const dept = joined.find((f) => f.code === "06007");
    expect(dept?.value).toBe(55);
  });

  it("puts unmatched department data into orphanData", () => {
    const data = [{ code: "99999", value: 1 }]; // non-existent dept
    const { orphanData } = joinChoroplethData(features, data, "department");
    expect(orphanData).toHaveLength(1);
    expect(orphanData[0].code).toBe("99999");
  });

  it("flags departments with no data as missingData", () => {
    const data = [{ code: "06007", value: 1 }];
    const { features: joined } = joinChoroplethData(features, data, "department");
    const unmatched = joined.filter((f) => f.missingData);
    expect(unmatched).toHaveLength(2); // 06014 and 14056
  });
});

// ---------------------------------------------------------------------------
// joinChoroplethData — barrio level
// ---------------------------------------------------------------------------

describe("joinChoroplethData — barrio level", () => {
  const g = null as unknown as GeoJSON.Geometry;
  const features: GeoJSON.Feature[] = [
    { type: "Feature", properties: { code: "agronomia", name: "Agronomía" }, geometry: g },
    { type: "Feature", properties: { code: "palermo", name: "Palermo" }, geometry: g },
    { type: "Feature", properties: { code: "nunez", name: "Núñez" }, geometry: g },
  ];

  it("matches exact slug codes", () => {
    const data = [{ code: "palermo", value: 99 }];
    const { features: joined } = joinChoroplethData(features, data, "barrio");
    const b = joined.find((f) => f.code === "palermo");
    expect(b?.value).toBe(99);
  });

  it("matches accented data codes to unaccented GeoJSON slugs", () => {
    const data = [{ code: "Agronomía", value: 30 }]; // accented display name
    const { features: joined } = joinChoroplethData(features, data, "barrio");
    const b = joined.find((f) => f.code === "agronomia");
    expect(b?.value).toBe(30);
  });

  it("matches uppercase data codes to lowercase GeoJSON slugs", () => {
    const data = [{ code: "PALERMO", value: 77 }];
    const { features: joined } = joinChoroplethData(features, data, "barrio");
    const b = joined.find((f) => f.code === "palermo");
    expect(b?.value).toBe(77);
  });

  it("puts unmatched barrio data into orphanData", () => {
    const data = [{ code: "belgrano", value: 5 }]; // not in features
    const { orphanData } = joinChoroplethData(features, data, "barrio");
    expect(orphanData).toHaveLength(1);
    expect(orphanData[0].code).toBe("belgrano");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("joinChoroplethData — edge cases", () => {
  const g = null as unknown as GeoJSON.Geometry;
  it("handles empty data array — all features are missingData", () => {
    const features: GeoJSON.Feature[] = [
      { type: "Feature", properties: { code: "AR-C" }, geometry: g },
    ];
    const { features: joined, orphanData } = joinChoroplethData(features, [], "province");
    expect(joined[0].missingData).toBe(true);
    expect(orphanData).toHaveLength(0);
  });

  it("handles empty features array — all data is orphaned", () => {
    const { features: joined, orphanData } = joinChoroplethData(
      [],
      [{ code: "AR-C", value: 1 }],
      "province",
    );
    expect(joined).toHaveLength(0);
    expect(orphanData).toHaveLength(1);
  });

  it("handles features with null properties gracefully", () => {
    const features: GeoJSON.Feature[] = [{ type: "Feature", properties: null, geometry: g }];
    // Should not throw — the feature has code="" after normalization
    expect(() => joinChoroplethData(features, [], "province")).not.toThrow();
  });

  it("last-write-wins for duplicate data codes", () => {
    const features: GeoJSON.Feature[] = [
      { type: "Feature", properties: { code: "AR-C" }, geometry: g },
    ];
    const data = [
      { code: "AR-C", value: 10 },
      { code: "AR-C", value: 20 }, // duplicate — last wins
    ];
    const { features: joined } = joinChoroplethData(features, data, "province");
    expect(joined[0].value).toBe(20);
  });
});

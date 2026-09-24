// Tests for the typed PROVINCES list + alias-tolerant resolvers. These are
// pure functions — no DB needed, runs fast under vitest run.

import { describe, expect, it } from "vitest";

import {
  PROVINCES,
  type Province,
  provinceByCode,
  provinceByName,
} from "@/lib/reference/ar-provincias";

describe("PROVINCES const", () => {
  it("has 24 entries (23 provinces + CABA)", () => {
    expect(PROVINCES).toHaveLength(24);
  });

  it("every entry has a unique ISO 3166-2:AR code", () => {
    const codes = PROVINCES.map((p) => p.code);
    expect(new Set(codes).size).toBe(24);
    for (const code of codes) {
      expect(code).toMatch(/^AR-[A-Z]$/);
    }
  });

  it("every entry has a unique slug", () => {
    const slugs = PROVINCES.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(24);
  });

  it("includes CABA with code AR-C and Buenos Aires with code AR-B", () => {
    const caba = PROVINCES.find((p) => p.code === "AR-C");
    const bsAs = PROVINCES.find((p) => p.code === "AR-B");
    expect(caba?.name).toBe("CABA");
    expect(bsAs?.name).toBe("Buenos Aires");
  });
});

describe("provinceByCode", () => {
  it("returns the matching province", () => {
    expect(provinceByCode("AR-C")?.name).toBe("CABA");
    expect(provinceByCode("AR-X")?.name).toBe("Córdoba");
    expect(provinceByCode("AR-T")?.name).toBe("Tucumán");
  });

  it("returns null for unknown codes", () => {
    expect(provinceByCode("AR-ZZ")).toBeNull();
    expect(provinceByCode("XX-X")).toBeNull();
    expect(provinceByCode("")).toBeNull();
    expect(provinceByCode(null)).toBeNull();
    expect(provinceByCode(undefined)).toBeNull();
  });
});

describe("provinceByName — CABA aliases", () => {
  const expectCaba = (input: string) => {
    const p: Province | null = provinceByName(input);
    expect(p?.code).toBe("AR-C");
  };

  it("matches the canonical 'CABA'", () => expectCaba("CABA"));
  it("matches 'C.A.B.A.' (with dots)", () => expectCaba("C.A.B.A."));
  it("matches 'Ciudad Autónoma de Buenos Aires'", () =>
    expectCaba("Ciudad Autónoma de Buenos Aires"));
  it("matches 'Ciudad Autonoma de Buenos Aires' (no accent)", () =>
    expectCaba("Ciudad Autonoma de Buenos Aires"));
  it("matches 'Ciudad de Buenos Aires'", () => expectCaba("Ciudad de Buenos Aires"));
  it("matches 'Capital Federal'", () => expectCaba("Capital Federal"));
  it("matches 'capital federal' (lowercase)", () => expectCaba("capital federal"));
  it("matches 'capital'", () => expectCaba("capital"));
  it("matches 'caba' with surrounding whitespace", () => expectCaba("  caba  "));
});

describe("provinceByName — Buenos Aires (provincia) aliases", () => {
  it("matches 'Bs As' (common postal abbreviation)", () => {
    expect(provinceByName("Bs As")?.code).toBe("AR-B");
  });
  it("matches 'Bs. As.' (with dots)", () => {
    expect(provinceByName("Bs. As.")?.code).toBe("AR-B");
  });
  it("matches 'Bs Aires'", () => {
    expect(provinceByName("Bs Aires")?.code).toBe("AR-B");
  });
  it("matches 'Provincia de Buenos Aires' (legal phrasing)", () => {
    expect(provinceByName("Provincia de Buenos Aires")?.code).toBe("AR-B");
  });
});

describe("provinceByName — accent/typo tolerance", () => {
  it("matches 'Cordoba' without accent", () => {
    expect(provinceByName("Cordoba")?.code).toBe("AR-X");
  });
  it("matches 'cordoba' lowercase no accent", () => {
    expect(provinceByName("cordoba")?.code).toBe("AR-X");
  });
  it("matches 'Tucuman' without accent", () => {
    expect(provinceByName("Tucuman")?.code).toBe("AR-T");
  });
  it("matches 'Rio Negro' without accent", () => {
    expect(provinceByName("Rio Negro")?.code).toBe("AR-R");
  });
  it("matches 'Entre Rios' without accent", () => {
    expect(provinceByName("Entre Rios")?.code).toBe("AR-E");
  });
  it("matches 'NEUQUEN' uppercase no accent", () => {
    expect(provinceByName("NEUQUEN")?.code).toBe("AR-Q");
  });
  it("matches by slug", () => {
    expect(provinceByName("santiago-del-estero")?.code).toBe("AR-G");
  });
});

describe("provinceByName — null and unknown", () => {
  it("returns null for null / undefined / empty", () => {
    expect(provinceByName(null)).toBeNull();
    expect(provinceByName(undefined)).toBeNull();
    expect(provinceByName("")).toBeNull();
    expect(provinceByName("   ")).toBeNull();
  });
  it("returns null for unknown names", () => {
    expect(provinceByName("Patagonia")).toBeNull();
    expect(provinceByName("Pampa Húmeda")).toBeNull();
    expect(provinceByName("España")).toBeNull();
  });
});

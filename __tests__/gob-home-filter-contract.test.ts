// Contract guard for the /gob home jurisdiction filter.
//
// The home previously wrote province=slug while every sub-page reads
// province=ISO (provinceByCode), so scope was silently dropped on the first
// drill-down. The fix standardizes the home on the JurisdictionSwitcher contract
// (province = ISO 3166-2 code). These tests pin the round-trip: the province
// codes the home offers MUST resolve back to the same province a sub-page reads,
// and MUST NOT be slugs.

import { describe, expect, it } from "vitest";

import { GOB_ALL_PROVINCES, PROVINCE_ISO_MAP } from "@/lib/analytics/govt-dashboards";
import { provinceByCode } from "@/lib/reference/ar-provincias";

describe("/gob home filter — province param round-trips through the sub-page resolver", () => {
  it("every admin option code resolves back to the same province name", () => {
    for (const opt of GOB_ALL_PROVINCES) {
      const resolved = provinceByCode(opt.code);
      expect(resolved, `code ${opt.code} should resolve`).not.toBeNull();
      expect(resolved?.name).toBe(opt.name);
    }
  });

  it("govt-derived option codes (PROVINCE_ISO_MAP) round-trip too", () => {
    for (const [name, code] of Object.entries(PROVINCE_ISO_MAP)) {
      const resolved = provinceByCode(code);
      expect(resolved, `code ${code} for ${name} should resolve`).not.toBeNull();
      expect(resolved?.name).toBe(name);
    }
  });

  it("option codes are ISO codes, not slugs (the exact bug that reset scope)", () => {
    for (const opt of GOB_ALL_PROVINCES) {
      // ISO codes look like "AR-B"; slugs look like "buenos-aires".
      expect(opt.code).toMatch(/^AR-[A-Z]$/);
      // A slug would fail provinceByCode → the sub-page would drop it.
      expect(provinceByCode(opt.code)).not.toBeNull();
    }
  });
});

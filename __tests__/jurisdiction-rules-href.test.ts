// AC4 unit tests — buildJurisdictionRulesHref resolver.
//
// The /gob/reglas admin-lens drill-down must produce a rules href whose
// [locality] segment carries the REAL locality name, never the "_" sentinel,
// so an admin can reach (and create) a locality-level rule from the UI. These
// tests pin the segment encoding and the "_" fallback for null scopes.

import { describe, expect, it } from "vitest";

import { buildJurisdictionRulesHref } from "@/lib/domain/jurisdiction-rules-href";

describe("buildJurisdictionRulesHref", () => {
  it("country-only → both province and locality segments are the '_' sentinel", () => {
    expect(buildJurisdictionRulesHref({ country: "AR" })).toBe("/gob/reglas/AR/_/_");
  });

  it("province scope → locality segment is '_', province is the real name", () => {
    expect(buildJurisdictionRulesHref({ country: "AR", province: "Buenos Aires" })).toBe(
      "/gob/reglas/AR/Buenos%20Aires/_",
    );
  });

  it("locality scope → the locality segment is the REAL name, not '_' (AC4)", () => {
    const href = buildJurisdictionRulesHref({
      country: "AR",
      province: "Buenos Aires",
      locality: "La Plata",
    });
    expect(href).toBe("/gob/reglas/AR/Buenos%20Aires/La%20Plata");

    // The load-bearing AC4 guarantee: the locality segment is NOT the sentinel.
    // Path shape: ["", "gob", "reglas", country, province, locality].
    const segments = href.split("/");
    const localitySegment = segments[5];
    expect(localitySegment).toBe("La%20Plata");
    expect(localitySegment).not.toBe("_");
  });

  it("encodes special characters in the locality segment", () => {
    const href = buildJurisdictionRulesHref({
      country: "AR",
      province: "Córdoba",
      locality: "Villa Carlos Paz",
    });
    expect(href).toBe("/gob/reglas/AR/C%C3%B3rdoba/Villa%20Carlos%20Paz");
  });

  it("treats null and empty-string province/locality as the '_' sentinel", () => {
    expect(buildJurisdictionRulesHref({ country: "AR", province: null, locality: null })).toBe(
      "/gob/reglas/AR/_/_",
    );
    expect(buildJurisdictionRulesHref({ country: "AR", province: "", locality: "" })).toBe(
      "/gob/reglas/AR/_/_",
    );
  });
});

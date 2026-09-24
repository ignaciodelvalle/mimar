// programa-hub-redirect — F9 fusion (2026-08-01). Pure function, no mocking
// needed: verifies the old /gob/analytics route (and the /gob/analitica typo
// alias) redirect into the Programa hub preserving every query param, with
// `vista` always set to the given tab.
//
// Same contract, same shape, same test list as the five hub-redirect builders
// that preceded it (padron/casos/denuncias/directorio/operativos) — the
// param-preservation guarantee is the whole reason a bookmarked old-route URL
// is allowed to keep working.

import { describe, expect, it } from "vitest";

import { buildProgramaHubRedirectUrl } from "./programa-hub-redirect";

describe("buildProgramaHubRedirectUrl", () => {
  it("sets vista=analitica with no other params", () => {
    expect(buildProgramaHubRedirectUrl({}, "analitica")).toBe("/gob/programa?vista=analitica");
  });

  it("sets vista=resumen with no other params", () => {
    expect(buildProgramaHubRedirectUrl({}, "resumen")).toBe("/gob/programa?vista=resumen");
  });

  it("preserves every incoming param (period/from/to/province/locality)", () => {
    const url = buildProgramaHubRedirectUrl(
      {
        period: "trailing12m",
        from: "2026-01-01",
        to: "2026-06-30",
        province: "Santa Fe",
        locality: "Rosario",
      },
      "analitica",
    );
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.get("period")).toBe("trailing12m");
    expect(params.get("from")).toBe("2026-01-01");
    expect(params.get("to")).toBe("2026-06-30");
    expect(params.get("province")).toBe("Santa Fe");
    expect(params.get("locality")).toBe("Rosario");
    expect(params.get("vista")).toBe("analitica");
  });

  it("vista always wins, even if a stale vista param was already on the old URL", () => {
    const url = buildProgramaHubRedirectUrl({ vista: "resumen" }, "analitica");
    expect(new URL(url, "http://localhost").searchParams.get("vista")).toBe("analitica");
  });

  it("ignores undefined-valued params and forwards array-valued (repeated) params", () => {
    const url = buildProgramaHubRedirectUrl({ from: undefined, to: ["a", "b"] }, "analitica");
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.has("from")).toBe(false);
    expect(params.getAll("to")).toEqual(["a", "b"]);
  });
});

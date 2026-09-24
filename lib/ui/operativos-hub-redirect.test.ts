// operativos-hub-redirect — F2 fusion (2026-07-22). Pure function, no mocking
// needed: verifies the old /gob/campanas and /gob/outreach routes redirect
// into the Operativos hub preserving every query param, with `vista` always
// set to the given tab.

import { describe, expect, it } from "vitest";

import { buildOperativosHubRedirectUrl } from "./operativos-hub-redirect";

describe("buildOperativosHubRedirectUrl", () => {
  it("sets vista=campanas with no other params", () => {
    expect(buildOperativosHubRedirectUrl({}, "campanas")).toBe("/gob/operativos?vista=campanas");
  });

  it("sets vista=alcance with no other params", () => {
    expect(buildOperativosHubRedirectUrl({}, "alcance")).toBe("/gob/operativos?vista=alcance");
  });

  it("preserves every incoming campañas param (period/from/to/province/locality/kind)", () => {
    const url = buildOperativosHubRedirectUrl(
      {
        period: "custom",
        from: "2026-01-01",
        to: "2026-03-31",
        province: "Buenos Aires",
        locality: "La Plata",
        kind: "vaccination",
      },
      "campanas",
    );
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.get("period")).toBe("custom");
    expect(params.get("from")).toBe("2026-01-01");
    expect(params.get("to")).toBe("2026-03-31");
    expect(params.get("province")).toBe("Buenos Aires");
    expect(params.get("locality")).toBe("La Plata");
    expect(params.get("kind")).toBe("vaccination");
    expect(params.get("vista")).toBe("campanas");
  });

  it("vista always wins, even if a stale vista param was already on the old URL", () => {
    const url = buildOperativosHubRedirectUrl({ vista: "campanas" }, "alcance");
    expect(new URL(url, "http://localhost").searchParams.get("vista")).toBe("alcance");
  });

  it("ignores undefined-valued params and forwards array-valued (repeated) params", () => {
    const url = buildOperativosHubRedirectUrl({ kind: undefined, status: ["a", "b"] }, "alcance");
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.has("kind")).toBe(false);
    expect(params.getAll("status")).toEqual(["a", "b"]);
  });
});

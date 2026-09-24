// padron-hub-redirect — F8 fusion (2026-07-22). Pure function, no mocking
// needed: verifies the old /gob/poblacion, /gob/censo routes (and their
// /admin/* twins) redirect into the Padrón hub preserving every query param,
// with `vista` always set to the given tab and the portal base honored
// (portal-follows-viewer — an admin old route must never bounce into gob).

import { describe, expect, it } from "vitest";

import { buildPadronHubRedirectUrl } from "./padron-hub-redirect";

describe("buildPadronHubRedirectUrl", () => {
  it("defaults to the /gob portal base", () => {
    expect(buildPadronHubRedirectUrl({}, "poblacion")).toBe("/gob/padron?vista=poblacion");
  });

  it("sets vista=censo with no other params", () => {
    expect(buildPadronHubRedirectUrl({}, "censo")).toBe("/gob/padron?vista=censo");
  });

  it("honors the /admin portal base — an admin old route never bounces into gob chrome", () => {
    expect(buildPadronHubRedirectUrl({}, "poblacion", "/admin")).toBe(
      "/admin/padron?vista=poblacion",
    );
    expect(buildPadronHubRedirectUrl({}, "censo", "/admin")).toBe("/admin/padron?vista=censo");
  });

  it("preserves every incoming param (period/from/to/province/locality/species)", () => {
    const url = buildPadronHubRedirectUrl(
      {
        period: "trailing12m",
        province: "Santa Fe",
        locality: "Rosario",
        species: "dog",
      },
      "poblacion",
    );
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.get("period")).toBe("trailing12m");
    expect(params.get("province")).toBe("Santa Fe");
    expect(params.get("locality")).toBe("Rosario");
    expect(params.get("species")).toBe("dog");
    expect(params.get("vista")).toBe("poblacion");
  });

  it("vista always wins, even if a stale vista param was already on the old URL", () => {
    const url = buildPadronHubRedirectUrl({ vista: "poblacion" }, "censo");
    expect(new URL(url, "http://localhost").searchParams.get("vista")).toBe("censo");
  });

  it("ignores undefined-valued params and forwards array-valued (repeated) params", () => {
    const url = buildPadronHubRedirectUrl({ from: undefined, to: ["a", "b"] }, "censo");
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.has("from")).toBe(false);
    expect(params.getAll("to")).toEqual(["a", "b"]);
  });
});

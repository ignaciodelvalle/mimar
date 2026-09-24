// casos-hub-redirect — F6 fusion (2026-07-22). Pure function, no mocking
// needed: verifies the old /gob/disputas route redirects into the Casos hub
// preserving every query param, with `expediente` always set to the given tab.

import { describe, expect, it } from "vitest";

import { buildCasosHubRedirectUrl } from "./casos-hub-redirect";

describe("buildCasosHubRedirectUrl", () => {
  it("sets expediente=disputas with no other params", () => {
    expect(buildCasosHubRedirectUrl({}, "disputas")).toBe("/gob/casos?expediente=disputas");
  });

  it("sets expediente=casos with no other params", () => {
    expect(buildCasosHubRedirectUrl({}, "casos")).toBe("/gob/casos?expediente=casos");
  });

  it("preserves the disputas queue's own status param", () => {
    const url = buildCasosHubRedirectUrl({ status: "closed" }, "disputas");
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.get("status")).toBe("closed");
    expect(params.get("expediente")).toBe("disputas");
  });

  it("expediente always wins, even if a stale expediente param was already on the old URL", () => {
    const url = buildCasosHubRedirectUrl({ expediente: "casos" }, "disputas");
    expect(new URL(url, "http://localhost").searchParams.get("expediente")).toBe("disputas");
  });

  it("ignores undefined-valued params and forwards array-valued (repeated) params", () => {
    const url = buildCasosHubRedirectUrl({ kind: undefined, status: ["open", "closed"] }, "casos");
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.has("kind")).toBe(false);
    expect(params.getAll("status")).toEqual(["open", "closed"]);
  });
});

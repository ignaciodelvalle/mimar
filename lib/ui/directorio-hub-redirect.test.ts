// directorio-hub-redirect — F3+F7 fusion (2026-07-22). Pure function, no
// mocking needed: verifies the old /gob/organizaciones, /gob/usuarios,
// /gob/servicios, /gob/rupga routes (and their /admin/* dual-portal twins)
// redirect into the Directorio hub preserving every query param, with
// `registro` always set to the given register and the portal base honored
// (portal-follows-viewer — an admin old route must never bounce into gob).

import { describe, expect, it } from "vitest";

import { buildDirectorioHubRedirectUrl } from "./directorio-hub-redirect";

describe("buildDirectorioHubRedirectUrl", () => {
  it("defaults to the /gob portal base", () => {
    expect(buildDirectorioHubRedirectUrl({}, "organizaciones")).toBe(
      "/gob/directorio?registro=organizaciones",
    );
  });

  it("sets registro=usuarios with no other params", () => {
    expect(buildDirectorioHubRedirectUrl({}, "usuarios")).toBe("/gob/directorio?registro=usuarios");
  });

  it("sets registro=servicios with no other params", () => {
    expect(buildDirectorioHubRedirectUrl({}, "servicios")).toBe(
      "/gob/directorio?registro=servicios",
    );
  });

  it("sets registro=credenciales with no other params", () => {
    expect(buildDirectorioHubRedirectUrl({}, "credenciales")).toBe(
      "/gob/directorio?registro=credenciales",
    );
  });

  it("honors the /admin portal base — an admin old route never bounces into gob chrome", () => {
    expect(buildDirectorioHubRedirectUrl({}, "usuarios", "/admin")).toBe(
      "/admin/directorio?registro=usuarios",
    );
    expect(buildDirectorioHubRedirectUrl({}, "organizaciones", "/admin")).toBe(
      "/admin/directorio?registro=organizaciones",
    );
    expect(buildDirectorioHubRedirectUrl({}, "servicios", "/admin")).toBe(
      "/admin/directorio?registro=servicios",
    );
  });

  it("preserves every incoming param (q/verified/orgType/role/status)", () => {
    const url = buildDirectorioHubRedirectUrl(
      { q: "sur", verified: "verified", orgType: "shelter" },
      "organizaciones",
    );
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.get("q")).toBe("sur");
    expect(params.get("verified")).toBe("verified");
    expect(params.get("orgType")).toBe("shelter");
    expect(params.get("registro")).toBe("organizaciones");
  });

  it("registro always wins, even if a stale registro param was already on the old URL", () => {
    const url = buildDirectorioHubRedirectUrl({ registro: "usuarios" }, "servicios");
    expect(new URL(url, "http://localhost").searchParams.get("registro")).toBe("servicios");
  });

  it("ignores undefined-valued params and forwards array-valued (repeated) params", () => {
    const url = buildDirectorioHubRedirectUrl(
      { role: undefined, status: ["a", "b"] },
      "credenciales",
    );
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.has("role")).toBe(false);
    expect(params.getAll("status")).toEqual(["a", "b"]);
  });
});

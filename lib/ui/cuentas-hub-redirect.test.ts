// cuentas-hub-redirect — privileged-accounts fusion (2026-08-02). Pure
// function, no mocking needed: verifies the old /admin/govts and
// /admin/admins routes redirect into the Cuentas privilegiadas hub
// preserving every query param, with `registro` always set to the given tab.

import { describe, expect, it } from "vitest";

import { buildCuentasHubRedirectUrl } from "./cuentas-hub-redirect";

describe("buildCuentasHubRedirectUrl", () => {
  it("sets registro=govts with no other params", () => {
    expect(buildCuentasHubRedirectUrl({}, "govts")).toBe("/admin/cuentas?registro=govts");
  });

  it("sets registro=admins with no other params", () => {
    expect(buildCuentasHubRedirectUrl({}, "admins")).toBe("/admin/cuentas?registro=admins");
  });

  it("preserves the govts roster's own q/status/test params", () => {
    const url = buildCuentasHubRedirectUrl({ q: "maría", status: "dead", test: "1" }, "govts");
    const params = new URL(url, "http://localhost").searchParams;
    expect(url.startsWith("/admin/cuentas?")).toBe(true);
    expect(params.get("q")).toBe("maría");
    expect(params.get("status")).toBe("dead");
    expect(params.get("test")).toBe("1");
    expect(params.get("registro")).toBe("govts");
  });

  it("registro always wins, even if a stale registro param was already on the old URL", () => {
    const url = buildCuentasHubRedirectUrl({ registro: "govts" }, "admins");
    expect(new URL(url, "http://localhost").searchParams.get("registro")).toBe("admins");
  });

  it("ignores undefined-valued params and forwards array-valued (repeated) params", () => {
    const url = buildCuentasHubRedirectUrl({ q: undefined, status: ["active", "dead"] }, "govts");
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.has("q")).toBe(false);
    expect(params.getAll("status")).toEqual(["active", "dead"]);
  });
});

// auditoria-hub-redirect — audit-trail fusion (2026-08-02). Pure function, no
// mocking needed: verifies the old /admin/historial route redirects into the
// Auditoría hub preserving every query param, with `vista` always set to the
// given tab. /gob/historial (jurisdiction-scoped) is NOT part of the fusion
// and never goes through this helper.

import { describe, expect, it } from "vitest";

import { buildAuditoriaHubRedirectUrl } from "./auditoria-hub-redirect";

describe("buildAuditoriaHubRedirectUrl", () => {
  it("sets vista=actividad with no other params", () => {
    expect(buildAuditoriaHubRedirectUrl({}, "actividad")).toBe("/admin/auditoria?vista=actividad");
  });

  it("sets vista=sensibles with no other params", () => {
    expect(buildAuditoriaHubRedirectUrl({}, "sensibles")).toBe("/admin/auditoria?vista=sensibles");
  });

  it("preserves the historial filter surface (action/actor/period/from/to/cursor)", () => {
    const url = buildAuditoriaHubRedirectUrl(
      {
        action: "request_approved,request_rejected",
        actor: "9a0e8f7a-1111-4222-8333-444455556666",
        period: "90d",
        from: "2026-01-01",
        to: "2026-02-01",
        cursor: "MjAyNi0wMS0wMXxhYmM",
      },
      "actividad",
    );
    const params = new URL(url, "http://localhost").searchParams;
    expect(url.startsWith("/admin/auditoria?")).toBe(true);
    expect(params.get("action")).toBe("request_approved,request_rejected");
    expect(params.get("actor")).toBe("9a0e8f7a-1111-4222-8333-444455556666");
    expect(params.get("period")).toBe("90d");
    expect(params.get("from")).toBe("2026-01-01");
    expect(params.get("to")).toBe("2026-02-01");
    expect(params.get("cursor")).toBe("MjAyNi0wMS0wMXxhYmM");
    expect(params.get("vista")).toBe("actividad");
  });

  it("vista always wins, even if a stale vista param was already on the old URL", () => {
    const url = buildAuditoriaHubRedirectUrl({ vista: "sensibles" }, "actividad");
    expect(new URL(url, "http://localhost").searchParams.get("vista")).toBe("actividad");
  });

  it("ignores undefined-valued params and forwards array-valued (repeated) params", () => {
    const url = buildAuditoriaHubRedirectUrl(
      { actor: undefined, action: ["request_approved", "request_rejected"] },
      "actividad",
    );
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.has("actor")).toBe(false);
    expect(params.getAll("action")).toEqual(["request_approved", "request_rejected"]);
  });

  it("never targets the gob portal (govt historial is out of the fusion)", () => {
    expect(buildAuditoriaHubRedirectUrl({}, "actividad").startsWith("/admin/")).toBe(true);
  });
});

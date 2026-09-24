// denuncias-hub-redirect — F1 fusion (2026-07-22). Pure function, no mocking
// needed: verifies the old /gob/moderacion and /gob/maltrato routes redirect
// into the Denuncias hub preserving every query param, with `etapa` always
// set to the given stage.

import { describe, expect, it } from "vitest";

import { buildDenunciasHubRedirectUrl } from "./denuncias-hub-redirect";

describe("buildDenunciasHubRedirectUrl", () => {
  it("sets etapa=moderacion with no other params", () => {
    expect(buildDenunciasHubRedirectUrl({}, "moderacion")).toBe("/gob/denuncias?etapa=moderacion");
  });

  it("sets etapa=triage with no other params", () => {
    expect(buildDenunciasHubRedirectUrl({}, "triage")).toBe("/gob/denuncias?etapa=triage");
  });

  it("preserves every incoming moderación param (status/kind/severity/cursor)", () => {
    const url = buildDenunciasHubRedirectUrl(
      { status: "resolved", kind: "abandono", severity: "high", cursor: "abc123" },
      "moderacion",
    );
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.get("status")).toBe("resolved");
    expect(params.get("kind")).toBe("abandono");
    expect(params.get("severity")).toBe("high");
    expect(params.get("cursor")).toBe("abc123");
    expect(params.get("etapa")).toBe("moderacion");
  });

  it("preserves every incoming triage param, including the inspector deep-link params (caso/mascota/panel) and the queue tab", () => {
    const url = buildDenunciasHubRedirectUrl(
      {
        queue: "mine",
        kind: "negligencia",
        severity: "critical",
        status: "in_progress",
        province: "buenos-aires",
        locality: "la-plata",
        cursor: "xyz789",
        caso: "DEN-0001-0001",
        mascota: "tok-abc",
        panel: "acciones",
      },
      "triage",
    );
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.get("queue")).toBe("mine");
    expect(params.get("kind")).toBe("negligencia");
    expect(params.get("severity")).toBe("critical");
    expect(params.get("status")).toBe("in_progress");
    expect(params.get("province")).toBe("buenos-aires");
    expect(params.get("locality")).toBe("la-plata");
    expect(params.get("cursor")).toBe("xyz789");
    expect(params.get("caso")).toBe("DEN-0001-0001");
    expect(params.get("mascota")).toBe("tok-abc");
    expect(params.get("panel")).toBe("acciones");
    expect(params.get("etapa")).toBe("triage");
  });

  it("etapa always wins, even if a stale etapa param was already on the old URL", () => {
    const url = buildDenunciasHubRedirectUrl({ etapa: "triage" }, "moderacion");
    expect(new URL(url, "http://localhost").searchParams.get("etapa")).toBe("moderacion");
  });

  it("ignores undefined-valued params and forwards array-valued (repeated) params", () => {
    const url = buildDenunciasHubRedirectUrl({ kind: undefined, status: ["a", "b"] }, "triage");
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.has("kind")).toBe(false);
    expect(params.getAll("status")).toEqual(["a", "b"]);
  });
});

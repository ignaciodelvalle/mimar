// @vitest-environment jsdom
//
// /gob/maltrato — F1 fusion (2026-07-22): this route now only redirects into
// the Denuncias hub's "triage" stage, preserving every query param —
// including the master-detail inspector's deep-link params (?caso=/&mascota=/
// &panel=) and the ?queue= workqueue tab. Regression guard: a bookmarked/
// shared old-route URL must land on the exact same slice of data under
// /gob/denuncias.

import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

import GobMaltratoRedirectPage from "./page";

describe("/gob/maltrato — redirects into the Denuncias hub (F1 fusion)", () => {
  it("redirects to /gob/denuncias?etapa=triage with no other params", async () => {
    await GobMaltratoRedirectPage({ searchParams: Promise.resolve({}) });
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/gob/denuncias?etapa=triage");
  });

  it("preserves the ?queue= workqueue tab and domain filters, sets etapa=triage", async () => {
    await GobMaltratoRedirectPage({
      searchParams: Promise.resolve({
        queue: "mine",
        kind: "negligencia",
        severity: "critical",
        status: "in_progress",
        province: "buenos-aires",
        locality: "la-plata",
        cursor: "xyz789",
      }),
    });
    const url = new URL(redirectMock.mock.calls.at(-1)?.[0] as string, "http://localhost");
    expect(url.pathname).toBe("/gob/denuncias");
    expect(url.searchParams.get("queue")).toBe("mine");
    expect(url.searchParams.get("kind")).toBe("negligencia");
    expect(url.searchParams.get("severity")).toBe("critical");
    expect(url.searchParams.get("status")).toBe("in_progress");
    expect(url.searchParams.get("province")).toBe("buenos-aires");
    expect(url.searchParams.get("locality")).toBe("la-plata");
    expect(url.searchParams.get("cursor")).toBe("xyz789");
    expect(url.searchParams.get("etapa")).toBe("triage");
  });

  it("preserves the master-detail inspector's deep-link params (?caso=/&mascota=/&panel=)", async () => {
    await GobMaltratoRedirectPage({
      searchParams: Promise.resolve({
        caso: "DEN-0001-0001",
        mascota: "tok-abc",
        panel: "acciones",
      }),
    });
    const url = new URL(redirectMock.mock.calls.at(-1)?.[0] as string, "http://localhost");
    expect(url.pathname).toBe("/gob/denuncias");
    expect(url.searchParams.get("caso")).toBe("DEN-0001-0001");
    expect(url.searchParams.get("mascota")).toBe("tok-abc");
    expect(url.searchParams.get("panel")).toBe("acciones");
    expect(url.searchParams.get("etapa")).toBe("triage");
  });
});

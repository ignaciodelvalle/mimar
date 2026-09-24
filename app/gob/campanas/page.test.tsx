// @vitest-environment jsdom
//
// /gob/campanas — F2 fusion (2026-07-22): this route now only redirects into
// the Operativos hub's "campanas" tab, preserving every query param.
// Regression guard: a bookmarked/shared old-route URL must land on the exact
// same slice of data under /gob/operativos.

import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

import GobCampanasRedirectPage from "./page";

describe("/gob/campanas — redirects into the Operativos hub (F2 fusion)", () => {
  it("redirects to /gob/operativos?vista=campanas with no other params", async () => {
    await GobCampanasRedirectPage({ searchParams: Promise.resolve({}) });
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/gob/operativos?vista=campanas");
  });

  it("preserves period/from/to/province/locality/kind and sets vista=campanas", async () => {
    await GobCampanasRedirectPage({
      searchParams: Promise.resolve({
        period: "custom",
        from: "2026-01-01",
        to: "2026-03-31",
        province: "Buenos Aires",
        locality: "La Plata",
        kind: "vaccination",
      }),
    });
    const url = new URL(redirectMock.mock.calls.at(-1)?.[0] as string, "http://localhost");
    expect(url.pathname).toBe("/gob/operativos");
    expect(url.searchParams.get("period")).toBe("custom");
    expect(url.searchParams.get("from")).toBe("2026-01-01");
    expect(url.searchParams.get("to")).toBe("2026-03-31");
    expect(url.searchParams.get("province")).toBe("Buenos Aires");
    expect(url.searchParams.get("locality")).toBe("La Plata");
    expect(url.searchParams.get("kind")).toBe("vaccination");
    expect(url.searchParams.get("vista")).toBe("campanas");
  });
});

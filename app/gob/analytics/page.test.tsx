// @vitest-environment jsdom
//
// /gob/analytics — F9 fusion (2026-08-01): this route now only redirects into
// the Programa hub's "analitica" vista, preserving every query param.
//
// WHY THIS GUARD EXISTS. The fold was opened by an external QA finding: two
// nav destinations shared one noun. The briefing alerts said "Ver en Programa
// →" and landed on /gob/programa; four KPI tiles on the jurisdiction panel
// landed on /gob/analytics, whose h1 read "Analítica". A funcionario following
// two paths that sound alike and arriving at two different screens stops
// trusting the navigation. The PO chose the fold, consistent with the five
// fusions before it.
//
// Regression guard: a bookmarked/shared old-route URL must land on the exact
// same slice of data under /gob/programa. The former render-level assertions
// moved to ./AnalyticsScreen.tsx; the page-level render coverage now lives in
// ../programa/page.test.tsx, so no coverage was lost.

import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

import GobAnalyticsRedirectPage from "./page";

describe("/gob/analytics — redirects into the Programa hub (F9 fusion)", () => {
  it("redirects to /gob/programa?vista=analitica with no other params", async () => {
    await GobAnalyticsRedirectPage({ searchParams: Promise.resolve({}) });
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/gob/programa?vista=analitica");
  });

  it("preserves period/from/to/province/locality and sets vista=analitica", async () => {
    await GobAnalyticsRedirectPage({
      searchParams: Promise.resolve({
        period: "trailing12m",
        from: "2026-01-01",
        to: "2026-06-30",
        province: "Santa Fe",
        locality: "Rosario",
      }),
    });
    const url = new URL(redirectMock.mock.calls.at(-1)?.[0] as string, "http://localhost");
    expect(url.pathname).toBe("/gob/programa");
    expect(url.searchParams.get("period")).toBe("trailing12m");
    expect(url.searchParams.get("from")).toBe("2026-01-01");
    expect(url.searchParams.get("to")).toBe("2026-06-30");
    expect(url.searchParams.get("province")).toBe("Santa Fe");
    expect(url.searchParams.get("locality")).toBe("Rosario");
    expect(url.searchParams.get("vista")).toBe("analitica");
  });
});

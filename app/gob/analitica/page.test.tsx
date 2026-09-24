// @vitest-environment jsdom
//
// /gob/analitica — bug fix (qa-triage-2026-07-23, finding #11): this typo of
// /gob/analytics used to 404. Regression guard: it redirects, preserving every
// query param.
//
// WHAT THESE TESTS USED TO ASSERT, AND WHY IT NO LONGER HOLDS. Until F9
// (2026-08-01) they pinned the target to "/gob/analytics". That was true when
// written and is false now: /gob/analytics is itself a redirect into
// /gob/programa?vista=analitica, so the old assertions would have kept passing
// while quietly certifying a two-hop chain — a green test over a worse
// experience. They now pin the FINAL destination, which is the only thing a
// visitor of a typo'd URL actually cares about, and the only shape that fails
// if someone reintroduces the chain.

import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

import GobAnaliticaRedirectPage from "./page";

describe("/gob/analitica — redirects into the Programa hub (typo fix + F9 fusion)", () => {
  it("redirects straight to /gob/programa?vista=analitica when no params are given", async () => {
    await GobAnaliticaRedirectPage({ searchParams: Promise.resolve({}) });
    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/gob/programa?vista=analitica");
  });

  it("never chains through /gob/analytics — one hop, not two", async () => {
    await GobAnaliticaRedirectPage({ searchParams: Promise.resolve({ period: "12m" }) });
    const target = redirectMock.mock.calls.at(-1)?.[0] as string;
    expect(target).not.toContain("/gob/analytics");
  });

  it("preserves every original search param", async () => {
    await GobAnaliticaRedirectPage({
      searchParams: Promise.resolve({
        period: "12m",
        province: "AR-C",
      }),
    });
    const url = new URL(redirectMock.mock.calls.at(-1)?.[0] as string, "http://localhost");
    expect(url.pathname).toBe("/gob/programa");
    expect(url.searchParams.get("period")).toBe("12m");
    expect(url.searchParams.get("province")).toBe("AR-C");
    expect(url.searchParams.get("vista")).toBe("analitica");
  });

  it("preserves repeated array-valued params", async () => {
    await GobAnaliticaRedirectPage({
      searchParams: Promise.resolve({ tag: ["a", "b"] }),
    });
    const url = new URL(redirectMock.mock.calls.at(-1)?.[0] as string, "http://localhost");
    expect(url.searchParams.getAll("tag")).toEqual(["a", "b"]);
  });
});

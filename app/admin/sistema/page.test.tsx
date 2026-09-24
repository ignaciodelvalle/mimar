// @vitest-environment jsdom
//
// /admin/sistema — streamed-shell structure test (platform-budget T3.1).
//
// The load-bearing move (same as app/admin/panorama/page.tsx): the default
// export must be SYNCHRONOUS and return <Suspense> whose fallback is the
// dashboard skeleton — that is what flushes the shell before any DB call, on
// hard reload AND client nav. Against the pre-T3 page (async default export
// awaiting a 7-fetcher Promise.all) every assertion here fails.
import "@testing-library/jest-dom/vitest";

import { Suspense, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import AdminSistemaPage from "./page";

describe("/admin/sistema — streamed shell", () => {
  it("default export is synchronous (an async export would hold the shell for the DB)", () => {
    expect(AdminSistemaPage.constructor.name).not.toBe("AsyncFunction");
  });

  it("returns a Suspense boundary immediately — an element, not a promise", () => {
    const el = AdminSistemaPage();
    expect(isValidElement(el)).toBe(true);
    expect(el.type).toBe(Suspense);
  });

  it("the Suspense fallback is the dashboard skeleton (aria-busy, no data claims)", () => {
    const el = AdminSistemaPage();
    const html = renderToStaticMarkup(el.props.fallback);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Cargando…");
  });
});

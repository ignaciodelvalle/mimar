// @vitest-environment jsdom
//
// /admin/inteligencia — streamed-shell structure test (platform-budget T3.2).
//
// The default export must be SYNCHRONOUS and return <Suspense> with the
// dashboard skeleton fallback, so the shell flushes before any DB call. The
// pre-T3 page (async default export racing ONE 10 s deadline over four
// fetchers) fails every assertion here. Panel-level degradation behavior is
// covered in ./inteligencia-panels.test.tsx.
import "@testing-library/jest-dom/vitest";

import { Suspense, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import AdminInteligenciaPage from "./page";

describe("/admin/inteligencia — streamed shell", () => {
  it("default export is synchronous", () => {
    expect(AdminInteligenciaPage.constructor.name).not.toBe("AsyncFunction");
  });

  it("returns a Suspense boundary immediately", () => {
    const el = AdminInteligenciaPage({ searchParams: Promise.resolve({}) });
    expect(isValidElement(el)).toBe(true);
    expect(el.type).toBe(Suspense);
  });

  it("the Suspense fallback is the dashboard skeleton (aria-busy)", () => {
    const el = AdminInteligenciaPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(el.props.fallback);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Cargando…");
  });
});

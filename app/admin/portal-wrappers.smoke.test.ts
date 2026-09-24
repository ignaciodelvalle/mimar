// Smoke tests for the thin /admin/* wrapper routes (portal-follows-viewer,
// 2026-07-02): each wrapper re-exports the /gob page's default export (and
// `dynamic` where the source page declares it) verbatim, so chrome comes
// from the /admin segment's own layout while the implementation stays
// single-sourced. This locks in that every wrapper actually re-exports a
// renderable component (not undefined from a typo'd import path) and that
// the `dynamic` re-export matches the source page.

import { describe, expect, it } from "vitest";

describe("/admin/* portal wrappers re-export a real component", () => {
  it.each([
    ["cola/page", () => import("./cola/page")],
    ["cola/[publicToken]/page", () => import("./cola/[publicToken]/page")],
    ["usuarios/page", () => import("./usuarios/page")],
    ["organizaciones/page", () => import("./organizaciones/page")],
    ["servicios/page", () => import("./servicios/page")],
    ["servicios/[offeringToken]/page", () => import("./servicios/[offeringToken]/page")],
    ["reglas/page", () => import("./reglas/page")],
    [
      "reglas/[country]/[province]/[locality]/page",
      () => import("./reglas/[country]/[province]/[locality]/page"),
    ],
    [
      "reglas/[country]/[province]/[locality]/nueva/page",
      () => import("./reglas/[country]/[province]/[locality]/nueva/page"),
    ],
    [
      "reglas/[country]/[province]/[locality]/editar/[ruleId]/page",
      () => import("./reglas/[country]/[province]/[locality]/editar/[ruleId]/page"),
    ],
  ])("%s exports a default component function", async (_name, load) => {
    const mod = await load();
    expect(typeof mod.default).toBe("function");
  });

  it.each([
    ["reglas/page", () => import("./reglas/page")],
    [
      "reglas/[country]/[province]/[locality]/page",
      () => import("./reglas/[country]/[province]/[locality]/page"),
    ],
    [
      "reglas/[country]/[province]/[locality]/nueva/page",
      () => import("./reglas/[country]/[province]/[locality]/nueva/page"),
    ],
    [
      "reglas/[country]/[province]/[locality]/editar/[ruleId]/page",
      () => import("./reglas/[country]/[province]/[locality]/editar/[ruleId]/page"),
    ],
  ])('%s re-exports dynamic = "force-dynamic"', async (_name, load) => {
    const mod = (await load()) as { dynamic?: string };
    expect(mod.dynamic).toBe("force-dynamic");
  });
});

describe("/admin/* loading.tsx passthroughs re-export a real component", () => {
  it.each([
    ["cola/loading", () => import("./cola/loading")],
    ["usuarios/loading", () => import("./usuarios/loading")],
  ])("%s exports a default component function", async (_name, load) => {
    const mod = await load();
    expect(typeof mod.default).toBe("function");
  });
});

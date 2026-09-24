// @vitest-environment jsdom
//
// /admin/admins/new — render smoke test (opfilterbar-sweep2-2026-07-21, item
// 5a). Pins the shell fix: this was wrapped in
// `<main className="px-6 py-8"><div className="max-w-2xl mx-auto space-y-6">`
// instead of the canonical operator shell `<div className="space-y-6">`.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/infra/auth-guards", () => ({
  requireAdminOrRedirect: vi.fn(async () => ({
    user: { id: "admin-1", email: "admin@dim.test" },
    profile: { id: "admin-1", role: "admin" },
  })),
}));

import NewAdminPage from "./page";

describe("/admin/admins/new — render smoke test", () => {
  it("uses the canonical space-y-6 shell, not a centered <main>/mx-auto wrapper", async () => {
    const node = await NewAdminPage();
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Crear cuenta administrador");
    expect(html).not.toContain("<main");
    expect(html).not.toContain("mx-auto");
  });
});

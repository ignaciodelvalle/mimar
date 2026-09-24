// Unit tests for operator breadcrumb derivation — admin fresh-sweep A4
// (localized segment labels instead of raw "Govts"/"New"/"Admins").

import { describe, expect, it } from "vitest";

import { deriveOperatorCrumbs } from "@/lib/ui/operator-breadcrumbs";

const labels = (pathname: string, portal: "gob" | "admin") =>
  deriveOperatorCrumbs(pathname, portal).map((c) => c.label);

describe("deriveOperatorCrumbs — localized segment labels (A4)", () => {
  it("localizes non-nav segments: /admin/govts/new → Briefing · Gobiernos · Nueva cuenta", () => {
    expect(labels("/admin/govts/new", "admin")).toEqual(["Briefing", "Gobiernos", "Nueva cuenta"]);
  });

  it("localizes /admin/admins → Briefing · Administradores", () => {
    expect(labels("/admin/admins", "admin")).toEqual(["Briefing", "Administradores"]);
  });

  it("uses 'Detalle' for a dynamic id segment, never the raw id", () => {
    expect(labels("/admin/admins/a1b2c3d4-e5f6-7890-abcd-ef1234567890", "admin")).toEqual([
      "Briefing",
      "Administradores",
      "Detalle",
    ]);
  });

  it("still resolves nav-preset sections (e.g. /admin/sistema)", () => {
    const out = labels("/admin/sistema", "admin");
    expect(out[0]).toBe("Briefing");
    expect(out).toHaveLength(2);
  });
});

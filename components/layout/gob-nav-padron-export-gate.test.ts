// FIX-25 #2 (PO, 2026-09-25) — the "Exportar padrón sanitario" rail entry was
// offered to a govt official with NO jurisdiction, whom the export page then
// turned away. The rail now asks the page's own predicate. Both states, plus
// the single-source pin: the page, its action and the layout all read
// canExportPadronSanitario, and none restates the rule.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canExportPadronSanitario } from "@/app/gob/analytics/export/export-access";

import { GOB_NAV_SECTIONS, GOB_PADRON_EXPORT_HREF, gobNavSectionsFor } from "./nav-presets";

const ONE_JURISDICTION = [{ province: "Buenos Aires", locality: "La Plata" }];

function railHrefs(role: string, jurisdictions: ReadonlyArray<unknown>): string[] {
  return gobNavSectionsFor({
    canExportPadronSanitario: canExportPadronSanitario(role, jurisdictions),
  }).flatMap((s) => s.items.map((i) => i.href));
}

describe("canExportPadronSanitario — who the export page admits", () => {
  it("admin: yes, with no assignments (universal scope)", () => {
    expect(canExportPadronSanitario("admin", [])).toBe(true);
  });
  it("govt with a jurisdiction: yes", () => {
    expect(canExportPadronSanitario("govt", ONE_JURISDICTION)).toBe(true);
  });
  it("govt with NO jurisdiction: no", () => {
    expect(canExportPadronSanitario("govt", [])).toBe(false);
  });
  it("national: no (the page's guard refuses the role)", () => {
    expect(canExportPadronSanitario("national", [])).toBe(false);
  });
});

describe("gobNavSectionsFor — the rail shows the export only to who may use it", () => {
  it("govt official with NO jurisdiction: the entry is hidden", () => {
    expect(railHrefs("govt", [])).not.toContain(GOB_PADRON_EXPORT_HREF);
  });

  it("govt official with a jurisdiction: the entry is shown", () => {
    expect(railHrefs("govt", ONE_JURISDICTION)).toContain(GOB_PADRON_EXPORT_HREF);
  });

  it("hiding the entry drops nothing else", () => {
    const all = GOB_NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href));
    expect(railHrefs("govt", [])).toEqual(all.filter((h) => h !== GOB_PADRON_EXPORT_HREF));
  });

  it("the catalogue itself still lists the entry (manifest fence + breadcrumbs read it)", () => {
    const all = GOB_NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href));
    expect(all).toContain(GOB_PADRON_EXPORT_HREF);
  });
});

describe("single source of truth — every reader asks the same predicate", () => {
  const root = path.resolve(__dirname, "../..");
  const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

  it.each([
    "app/gob/analytics/export/page.tsx",
    "app/gob/analytics/export/actions.ts",
    "app/gob/layout.tsx",
  ])("%s calls canExportPadronSanitario and restates no rule", (rel) => {
    const src = read(rel);
    expect(src).toContain("canExportPadronSanitario(profile.role, jurisdictions)");
    expect(src).not.toMatch(/role === "govt" && jurisdictions\.length/);
  });
});

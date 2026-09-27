// FIX-25 #2 (PO, 2026-09-25) — the "Exportar padrón sanitario" rail entry was
// offered to a govt official with NO jurisdiction, whom the export page then
// turned away. The rail now asks the page's own predicate. Both states, plus
// the single-source pin: the page, its action and the layout all read
// canExportPadronSanitario, and none restates the rule.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canExportPadronSanitario } from "@/app/gob/analytics/export/export-access";

import {
  GOB_ADMINISTRACION_HREF,
  GOB_NAV_SECTIONS,
  GOB_PADRON_EXPORT_HREF,
  gobNavSectionsFor,
} from "./nav-presets";

const ONE_JURISDICTION = [{ province: "Buenos Aires", locality: "La Plata" }];

// Pinned `administersProvince: true` so these cases isolate the export gate;
// the administration gate has its own block below.
function railHrefs(role: string, jurisdictions: ReadonlyArray<unknown>): string[] {
  return gobNavSectionsFor({
    canExportPadronSanitario: canExportPadronSanitario(role, jurisdictions),
    administersProvince: true,
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

// jurisdiction-admin Phase 6: the province administration entry is shown only
// to a govt with a LIVE appointment — the one viewer its page admits.
describe("gobNavSectionsFor — the rail shows Administración only to a jurisdiction admin", () => {
  const hrefs = (administersProvince: boolean) =>
    gobNavSectionsFor({ canExportPadronSanitario: true, administersProvince }).flatMap((s) =>
      s.items.map((i) => i.href),
    );

  it("a jurisdiction admin sees it", () => {
    expect(hrefs(true)).toContain(GOB_ADMINISTRACION_HREF);
  });

  it("anyone else does not, and nothing else is dropped", () => {
    expect(hrefs(false)).not.toContain(GOB_ADMINISTRACION_HREF);
    expect(hrefs(false)).toEqual(hrefs(true).filter((h) => h !== GOB_ADMINISTRACION_HREF));
  });

  it("the layout asks the authority loader, the same one the page's guard asks", () => {
    const src = readFileSync(path.resolve(__dirname, "../../app/gob/layout.tsx"), "utf8");
    // Only a govt costs the query, and only a live appointment answers yes.
    expect(src.replace(/\s+/g, " ")).toContain(
      'administersProvince: profile.role === "govt" && (await loadAdminAuthority(db, profile.id)).kind === "jurisdiction",',
    );
  });
});

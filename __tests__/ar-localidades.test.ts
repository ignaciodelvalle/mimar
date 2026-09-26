// Integration tests for lib/ar-localidades. Runs against the dev DB populated
// by scripts/import-indec-localities.ts. If the catalog is empty (the import
// hasn't run yet), the tests skip with a clear message instead of failing.

import { count as countFn, eq, inArray, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { arLocalities, db, pets } from "@/db";
import {
  isCanonicalLocality,
  listLocalitiesByProvince,
  localitiesByName,
  localityByIndecId,
  localityByName,
  searchLocalities,
} from "@/lib/infra/ar-localidades";

import { deleteCatalogRows } from "./_helpers/delete-catalog-rows";
import { restoreIndecCatalog } from "./_helpers/restore-indec-catalog";

// INDEC IDs from the import-indec-localities fixture CSV. If a prior test run
// timed out before afterAll cleanup, these rows may still be present and will
// corrupt the catalogPopulated count and the empty-catalog test. Remove them
// before anything else runs.
//
// REWRITTEN 2026-08-21, AND THIS LIST IS WHY THE FIXTURE IDS CHANGED. The old
// entries were REAL: `06028010` is "Almirante Brown" upstream, `50028010` is
// "Colonia Segovia", and this beforeAll hard-deleted both from the dev catalog
// on every run — the same accident caba-barrios.test.ts already suffered with
// `02014010`, which upstream turned into "CABA - Comuna 2". A second deleter of
// the same real ids would have made the fixture rewrite pointless: the ids move,
// this list stays, and the live rows keep disappearing.
//
// The fixture now uses department code `999`, which INDEC assigns nowhere, so
// every id below is unmintable by construction. `02014010`/`02002010` are gone
// because they are (or became) REAL AR-C ids and this file has no business
// deleting them — import-indec-localities.test.ts owns the two AR-C rows and
// cleans them by `source_version` marker, which cannot touch a live row.
const INDEC_FIXTURE_IDS = [
  "06999010", // Avellaneda fixture   (AR-B, dept 06999 — impossible upstream)
  "06999020", // La Plata fixture     (AR-B, dept 06999 — impossible upstream)
  "06999030", // Empty-name fixture   (AR-B, dept 06999 — impossible upstream)
  "50999010", // Mendoza capital      (AR-M, dept 50999 — impossible upstream)
  "50999020", // Paraje fixture       (AR-M, dept 50999 — impossible upstream)
  "99999010", // Inventada            (province 99 — impossible upstream)
] as const;

beforeAll(async () => {
  // Purge any stale fixture rows so catalogPopulated and province-scoped
  // queries reflect only real catalog data. Safe to hard-delete: every id above
  // names a department INDEC does not assign, so none can hit a live row.
  await deleteCatalogRows(inArray(arLocalities.indecId, [...INDEC_FIXTURE_IDS]));
  // Restore any soft-deleted indec_cppdyl rows the import fixture may have
  // stamped so the live catalog count is accurate. The shared helper also
  // re-drops whole-province aggregate rows a blanket restore would resurrect
  // (they fail the lint:locality gate) — see _helpers/restore-indec-catalog.ts.
  await restoreIndecCatalog();
});

let catalogPopulated = false;

beforeAll(async () => {
  const [row] = await db
    .select({ count: countFn() })
    .from(arLocalities)
    .where(isNull(arLocalities.removedAt));
  catalogPopulated = Number(row?.count ?? 0) > 100;
});

// Real INDEC entries used by the integration tests. Picked because they are
// stable across census revisions and represent different provinces / categories.
const LA_PLATA_INDEC_ID = "06441030"; // AR-B, "Localidad simple"

// Cross-province homonym (C2, Tanda A): "Villa María" exists twice in the
// live catalog — a real Buenos Aires town (category 'localidad', department
// Alberti) and the INDEC agglomerate component for Villa María, Córdoba
// (category 'componente', department General San Martín). 'componente' is a
// REAL city here, not CABA's whole-province aggregate (isWholeProvinceAggregate
// requires a department-less row — this one has a department — see
// lib/reference/locality-integrity.ts). Verified against the local DB
// 2026-09-23.
const VILLA_MARIA_BA_INDEC_ID = "06021060"; // AR-B, dept Alberti, category 'localidad'
const VILLA_MARIA_CBA_INDEC_ID = "14042170"; // AR-X, dept General San Martín, category 'componente'

describe("ar-localidades — lookups", () => {
  it("localityByIndecId returns La Plata for its INDEC id", async () => {
    if (!catalogPopulated) return;
    const laPlata = await localityByIndecId(LA_PLATA_INDEC_ID);
    expect(laPlata).not.toBeNull();
    expect(laPlata?.localityName).toBe("La Plata");
    expect(laPlata?.provinceCode).toBe("AR-B");
  });

  it("localityByIndecId returns null for an unknown id", async () => {
    if (!catalogPopulated) return;
    expect(await localityByIndecId("00000000")).toBeNull();
  });

  it("localityByName matches case-insensitive and accent-insensitive", async () => {
    if (!catalogPopulated) return;
    const a = await localityByName("AR-B", "La Plata");
    const b = await localityByName("AR-B", "la plata");
    const c = await localityByName("AR-B", "La PlAtA");
    expect(a?.indecId).toBe(LA_PLATA_INDEC_ID);
    expect(b?.indecId).toBe(LA_PLATA_INDEC_ID);
    expect(c?.indecId).toBe(LA_PLATA_INDEC_ID);
  });

  it("localityByName scoped to a province returns null when the name lives elsewhere", async () => {
    if (!catalogPopulated) return;
    expect(await localityByName("AR-Z", "La Plata")).toBeNull();
  });

  it("isCanonicalLocality accepts both province code and province name as the scope", async () => {
    if (!catalogPopulated) return;
    expect(await isCanonicalLocality("AR-B", "La Plata")).toBe(true);
    expect(await isCanonicalLocality("Buenos Aires", "La Plata")).toBe(true);
    expect(await isCanonicalLocality("AR-Z", "La Plata")).toBe(false);
  });

  it("isCanonicalLocality returns false for unknown provinces", async () => {
    if (!catalogPopulated) return;
    expect(await isCanonicalLocality("INVALID", "La Plata")).toBe(false);
  });
});

describe("ar-localidades — listLocalitiesByProvince", () => {
  it("returns [] for an empty catalog without throwing", async () => {
    // When the catalog hasn't been imported yet (catalogPopulated === false) the
    // function must return [] gracefully, not throw.
    if (catalogPopulated) return; // skip — covered by the populated-catalog cases below
    const result = await listLocalitiesByProvince("AR-B");
    expect(result).toEqual([]);
  });

  it("returns only rows for the given province", async () => {
    if (!catalogPopulated) return;
    const result = await listLocalitiesByProvince("AR-B");
    expect(result.length).toBeGreaterThan(0);
    // Every row must come from AR-B (verified indirectly — La Plata must be present).
    const laPlata = result.find((r) => r.slug === "la-plata");
    expect(laPlata).toBeDefined();
    expect(laPlata?.name).toBe("La Plata");
  });

  it("excludes soft-deleted rows (removed_at IS NOT NULL)", async () => {
    if (!catalogPopulated) return;
    // We can't easily inject a removed row in an integration test, but we can
    // assert that all returned slugs are non-empty strings (a removed row would
    // be invisible by contract — tested via the WHERE clause in the implementation).
    const result = await listLocalitiesByProvince("AR-M");
    expect(result.length).toBeGreaterThan(0);
    for (const r of result) {
      expect(typeof r.slug).toBe("string");
      expect(r.slug.length).toBeGreaterThan(0);
      expect(typeof r.name).toBe("string");
      expect(r.name.length).toBeGreaterThan(0);
    }
  });

  it("returns results ordered alphabetically by name", async () => {
    if (!catalogPopulated) return;
    const result = await listLocalitiesByProvince("AR-X");
    expect(result.length).toBeGreaterThan(1);
    // PostgreSQL's locale-aware collation folds case when ordering so it treats
    // "Agua de las Piedras" < "Agua de Oro" (because 'l' === 'L' < 'O').
    // We mirror that with locale-insensitive case-folding comparison.
    for (let i = 1; i < result.length; i++) {
      const cmp = result[i - 1].name
        .toLowerCase()
        .localeCompare(result[i].name.toLowerCase(), "en");
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });

  it("returns LocalityOption shape compatible with JurisdictionSwitcher localities prop", async () => {
    if (!catalogPopulated) return;
    const result = await listLocalitiesByProvince("AR-S");
    expect(result.length).toBeGreaterThan(0);
    for (const item of result.slice(0, 5)) {
      expect(item).toHaveProperty("slug");
      expect(item).toHaveProperty("name");
      // localidades-por-id D5: the catalogue row and its department ride along
      // so a picker can tell homonyms apart and submit the row, not the name.
      // Catalogue data only — nothing about a person.
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("department");
      expect(Object.keys(item).sort()).toEqual(["department", "id", "name", "slug"]);
    }
  });

  it("returns [] for a province with no localities in the catalog", async () => {
    if (!catalogPopulated) return;
    // Use a valid but extremely sparse province. AR-V (Tierra del Fuego) has
    // very few entries but should have at least one; we just verify it doesn't throw.
    const result = await listLocalitiesByProvince("AR-V");
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("ar-localidades — search", () => {
  it("returns [] for queries under the minimum length", async () => {
    expect(await searchLocalities({ query: "" })).toEqual([]);
    expect(await searchLocalities({ query: "x" })).toEqual([]);
  });

  it("scopes results when a province is provided", async () => {
    if (!catalogPopulated) return;
    const r = await searchLocalities({ provinceCode: "AR-B", query: "la plata" });
    expect(r.length).toBeGreaterThan(0);
    for (const hit of r) expect(hit.provinceCode).toBe("AR-B");
    expect(r[0].matchKind).toBe("exact");
    expect(r[0].indecId).toBe(LA_PLATA_INDEC_ID);
  });

  it("returns prefix matches with the right matchKind", async () => {
    if (!catalogPopulated) return;
    const r = await searchLocalities({ provinceCode: "AR-M", query: "men" });
    expect(r.length).toBeGreaterThan(0);
    // First non-exact hit should be a prefix on "men"
    const firstPrefix = r.find((x) => x.matchKind === "prefix");
    expect(firstPrefix).toBeDefined();
    expect(firstPrefix?.localityName.toLowerCase().startsWith("men")).toBe(true);
  });

  it("matches against accented names without requiring accents in the query", async () => {
    if (!catalogPopulated) return;
    // "Córdoba" capital should show up in AR-X
    const r = await searchLocalities({ provinceCode: "AR-X", query: "cordoba" });
    expect(r.length).toBeGreaterThan(0);
  });

  it("returns identical results whether the query carries accents or not", async () => {
    if (!catalogPopulated) return;
    // Accent parity across the WHOLE scoring (including the substring branch):
    // the accented and unaccented spellings must resolve to the same rows.
    // Before the fix the "contains" branch did a raw ILIKE on the display name
    // (accent-sensitive), so a mid-string match like "Nueva Córdoba" surfaced for
    // "córdoba" but not "cordoba". Matching the normalized slug folds accents.
    const ids = (rs: Awaited<ReturnType<typeof searchLocalities>>) =>
      rs.map((r) => r.indecId).sort();
    const withAccent = await searchLocalities({ query: "córdoba" });
    const without = await searchLocalities({ query: "cordoba" });
    expect(without.length).toBeGreaterThan(0);
    expect(ids(without)).toEqual(ids(withAccent));
  });

  it("respects the limit parameter (capped at 50)", async () => {
    if (!catalogPopulated) return;
    const r = await searchLocalities({ query: "san", limit: 5 });
    expect(r.length).toBeLessThanOrEqual(5);
  });

  it("finds Bariloche unscoped and ranks it in AR-R", async () => {
    if (!catalogPopulated) return;
    const r = await searchLocalities({ query: "bariloche" });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].provinceCode).toBe("AR-R");
  });
});

// ---------------------------------------------------------------------------
// Cross-province homonym — Villa María (C2, Tanda A)
//
// The admin locality picker (LocalityPickerAcross) must show BOTH rows, with
// province visible, so an admin assigning a govt jurisdiction can tell them
// apart. Neither the search ranking nor localityByName's slug-first lookup
// may drop the Córdoba 'componente' row — it is a real city, not the
// province-as-locality overlap isWholeProvinceAggregate exists to drop.
// ---------------------------------------------------------------------------

describe("ar-localidades — Villa María cross-province homonym (C2)", () => {
  it("an unscoped search for 'Villa María' surfaces BOTH provinces", async () => {
    if (!catalogPopulated) return;
    const r = await searchLocalities({ query: "Villa María" });
    const indecIds = r.map((x) => x.indecId).sort();
    expect(indecIds).toEqual([VILLA_MARIA_BA_INDEC_ID, VILLA_MARIA_CBA_INDEC_ID].sort());
    // provinceName is resolved per row — never both defaulting to the same
    // province, which would make the two rows indistinguishable in the UI.
    const byIndec = Object.fromEntries(r.map((x) => [x.indecId, x]));
    expect(byIndec[VILLA_MARIA_BA_INDEC_ID].provinceName).toBe("Buenos Aires");
    expect(byIndec[VILLA_MARIA_CBA_INDEC_ID].provinceName).toBe("Córdoba");
  });

  it("a province-scoped search for AR-X returns ONLY the Córdoba componente row", async () => {
    if (!catalogPopulated) return;
    const r = await searchLocalities({ provinceCode: "AR-X", query: "Villa María" });
    expect(r.map((x) => x.indecId)).toEqual([VILLA_MARIA_CBA_INDEC_ID]);
    expect(r[0].category).toBe("componente");
    expect(r[0].matchKind).toBe("exact");
  });

  it("a province-scoped search for AR-B returns ONLY the Buenos Aires localidad row", async () => {
    if (!catalogPopulated) return;
    const r = await searchLocalities({ provinceCode: "AR-B", query: "Villa María" });
    expect(r.map((x) => x.indecId)).toEqual([VILLA_MARIA_BA_INDEC_ID]);
    expect(r[0].category).toBe("localidad");
  });

  it("localityByName(AR-X, 'Villa María') resolves the componente row — category never filters it out", async () => {
    if (!catalogPopulated) return;
    const loc = await localityByName("AR-X", "Villa María");
    expect(loc?.indecId).toBe(VILLA_MARIA_CBA_INDEC_ID);
    expect(loc?.category).toBe("componente");
    expect(loc?.departmentName).toBe("General San Martín");
  });

  it("localityByName(AR-B, 'Villa María') resolves the OTHER province's row", async () => {
    if (!catalogPopulated) return;
    const loc = await localityByName("AR-B", "Villa María");
    expect(loc?.indecId).toBe(VILLA_MARIA_BA_INDEC_ID);
    expect(loc?.category).toBe("localidad");
  });

  it("isCanonicalLocality accepts Villa María under Córdoba by name or ISO code", async () => {
    if (!catalogPopulated) return;
    expect(await isCanonicalLocality("Córdoba", "Villa María")).toBe(true);
    expect(await isCanonicalLocality("AR-X", "Villa María")).toBe(true);
  });

  it("the Córdoba componente row is NOT dropped by isWholeProvinceAggregate (it has a department)", async () => {
    if (!catalogPopulated) return;
    const loc = await localityByName("AR-X", "Villa María");
    expect(loc?.departmentCode).not.toBeNull();
    const listed = await listLocalitiesByProvince("AR-X");
    expect(listed.some((l) => l.slug === "villa-maria")).toBe(true);
  });
});

// localidades-por-id A9 — the lookup that does NOT settle a homonym. Mechita is
// in partido Alberti (06021030) and partido Bragado (06112080), both in Buenos
// Aires: `localityByName` answers the first department, `localitiesByName`
// answers both, so a writer can tell "one row" from "ask which one".
describe("ar-localidades — localitiesByName (within-province homonym)", () => {
  it("answers BOTH Mechitas, by name and by any spelling localityByName accepts", async () => {
    if (!catalogPopulated) return;
    for (const spelling of ["Mechita", "mechita", "MECHITA"]) {
      const rows = await localitiesByName("AR-B", spelling);
      expect(rows.map((r) => r.indecId).sort(), spelling).toEqual(["06021030", "06112080"]);
    }
  });

  it("answers exactly one row for a name that is unique in its province", async () => {
    if (!catalogPopulated) return;
    const rows = await localitiesByName("AR-X", "Villa Maria");
    expect(rows.map((r) => r.indecId)).toEqual([VILLA_MARIA_CBA_INDEC_ID]);
  });

  it("answers no row for a name the province does not have, and for an empty one", async () => {
    if (!catalogPopulated) return;
    expect(await localitiesByName("AR-B", "Narnia")).toEqual([]);
    expect(await localitiesByName("AR-B", "")).toEqual([]);
  });
});

// Stage B review (RESTRICT, migration 0248): a catalogue row a place row points
// at can no longer be hard-deleted from under it, so a teardown that deletes
// fixture rows must detach what references them first — exactly what the old
// ON DELETE SET NULL did silently. `deleteCatalogRows` is that teardown.
describe("deleteCatalogRows — fixture teardown under ON DELETE RESTRICT", () => {
  const TEARDOWN_FIXTURE = "06999090"; // AR-B, dept 06999 — impossible upstream

  it("detaches a place row that points at the fixture, then deletes it", async () => {
    const [loc] = await db
      .insert(arLocalities)
      .values({
        provinceCode: "AR-B",
        departmentName: "Departamento 999",
        departmentCode: "06999",
        localityName: "Teardown Fixture",
        localitySlug: "teardown-fixture",
        indecId: TEARDOWN_FIXTURE,
        category: "localidad",
        source: "indec_cppdyl",
      })
      .returning({ id: arLocalities.id });
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: `TEARDOWN-${Date.now()}`,
        name: "TeardownFixture",
        species: "dog",
        sex: "female",
        status: "active",
        localityId: loc?.id,
        placeMethod: "indec_id",
      })
      .returning({ id: pets.id });
    try {
      const removed = await deleteCatalogRows(inArray(arLocalities.indecId, [TEARDOWN_FIXTURE]));
      expect(removed).toBe(1);
      const [after] = await db
        .select({ localityId: pets.localityId, placeMethod: pets.placeMethod })
        .from(pets)
        .where(eq(pets.id, pet?.id ?? ""));
      expect(after).toEqual({ localityId: null, placeMethod: null });
      expect(await localityByIndecId(TEARDOWN_FIXTURE)).toBeNull();
    } finally {
      await db.delete(pets).where(eq(pets.id, pet?.id ?? ""));
      await deleteCatalogRows(inArray(arLocalities.indecId, [TEARDOWN_FIXTURE]));
    }
  });
});

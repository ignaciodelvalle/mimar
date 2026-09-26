// The per-unit point layers attribute by catalogue id (localidades-por-id D6,
// flag `panorama`).
//
// On the name path a denuncia in Alberti's Mechita and one in Bragado's are
// the same (province, "Mechita") group, folded into whichever department MIN()
// picks. On the id path each report is grouped by its own catalogue row and
// folds into its OWN department; a report whose place never resolved is
// counted in the province's "Sin localidad" cell — never guessed, never
// dropped. Only the `panorama` flag is steered here (mocked); every other
// consumer keeps the name path.
//
// Real rows (the loaders read through the analytics connection), measured as
// a before/after delta under a govt scope narrowed to "Mechita", and removed
// in afterAll.

import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const flag = vi.hoisted(() => ({ panorama: "name" as "name" | "id" }));
vi.mock("@/lib/place/flags", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/place/flags")>();
  return {
    ...real,
    readPlaceFlag: async (consumer: string) => (consumer === "panorama" ? flag.panorama : "name"),
  };
});

import { arLocalities, db, welfareReports } from "@/db";
import type { DashboardActor, DashboardJurisdiction } from "@/lib/metrics";

import { dbNow } from "../../../../../__tests__/_helpers/db-now";
import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";
import { SIN_LOCALIDAD } from "../place-attribution";
import { loadDenunciaCentroids, loadDenunciasByUnit, loadUnitHistory } from "../repository";
import { provinceRepresentativeCentroid } from "../repository-scope";

const GOVT: DashboardActor = { role: "govt" };
const MECHITA: DashboardJurisdiction[] = [{ province: "Buenos Aires", locality: "Mechita" }];
const MECHITA_ALBERTI = "06021030";
const MECHITA_BRAGADO = "06112080";
const PER_PLACE = 5;

const rowByIndec = new Map<
  string,
  { id: string; departmentCode: string | null; latitude: string | null; longitude: string | null }
>();
const reportIds: string[] = [];
let since = new Date(0);

type Cells = Awaited<ReturnType<typeof loadDenunciasByUnit>>["cells"];

/** Visible count per fold unit (department code, or the cell label when none). */
function byUnit(cells: Cells): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cells) {
    const unit = c.departmentCode ?? `label:${c.locality ?? ""}`;
    m.set(unit, (m.get(unit) ?? 0) + (typeof c.count === "number" ? c.count : 0));
  }
  return m;
}

function delta(before: Map<string, number>, after: Map<string, number>): Map<string, number> {
  const d = new Map<string, number>();
  for (const [k, v] of after) {
    const diff = v - (before.get(k) ?? 0);
    if (diff !== 0) d.set(k, diff);
  }
  return d;
}

async function insertReports(localityId: string | null, tag: string): Promise<void> {
  for (let i = 0; i < PER_PLACE; i++) {
    const [r] = await db
      .insert(welfareReports)
      .values({
        referenceCode: `DEN-UB${tag}-${String(Date.now() + i).slice(-4)}${i}`,
        kind: "neglect",
        severity: "medium",
        description: "by-unit attribution fixture",
        subjectKind: "unowned_animal",
        subjectDescription: "stray test",
        status: "in_progress",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "Mechita",
        localityId,
      })
      .returning({ id: welfareReports.id });
    if (r) reportIds.push(r.id);
  }
}

beforeAll(async () => {
  const rows = await db
    .select({
      id: arLocalities.id,
      indecId: arLocalities.indecId,
      departmentCode: arLocalities.departmentCode,
      latitude: arLocalities.latitude,
      longitude: arLocalities.longitude,
    })
    .from(arLocalities)
    .where(inArray(arLocalities.indecId, [MECHITA_ALBERTI, MECHITA_BRAGADO]));
  for (const r of rows) if (r.indecId) rowByIndec.set(r.indecId, r);
  expect(rowByIndec.size, "both Mechita catalogue rows must exist").toBe(2);
  const alberti = rowByIndec.get(MECHITA_ALBERTI);
  const bragado = rowByIndec.get(MECHITA_BRAGADO);
  expect(alberti?.departmentCode).toBeTruthy();
  expect(alberti?.departmentCode).not.toBe(bragado?.departmentCode);
  since = new Date((await dbNow()).getTime() - 60 * 60 * 1000);
});

afterAll(async () => {
  if (reportIds.length === 0) return;
  await withMutationOverride(async (tx) => {
    await tx.delete(welfareReports).where(inArray(welfareReports.id, reportIds));
  });
});

describe("denuncias by unit — attribution path", () => {
  it("id path: each homonym folds into its own department; unresolved lands in 'Sin localidad'", async () => {
    flag.panorama = "id";
    const before = byUnit((await loadDenunciasByUnit("locality", GOVT, MECHITA, since)).cells);

    const alberti = rowByIndec.get(MECHITA_ALBERTI);
    const bragado = rowByIndec.get(MECHITA_BRAGADO);
    await insertReports(alberti?.id ?? null, "A");
    await insertReports(bragado?.id ?? null, "B");
    await insertReports(null, "U");

    flag.panorama = "id";
    const idAfter = await loadDenunciasByUnit("locality", GOVT, MECHITA, since);
    const d = delta(before, byUnit(idAfter.cells));
    expect(d.get(alberti?.departmentCode as string)).toBe(PER_PLACE);
    expect(d.get(bragado?.departmentCode as string)).toBe(PER_PLACE);
    expect(d.get(`label:${SIN_LOCALIDAD}`)).toBe(PER_PLACE);

    // The name path, over the same rows: every Mechita is ONE group, folded
    // into a single department — the confusion the id path removes.
    flag.panorama = "name";
    const nameCells = (await loadDenunciasByUnit("locality", GOVT, MECHITA, since)).cells;
    const mechitaUnits = nameCells.filter(
      (c) =>
        c.departmentCode === alberti?.departmentCode ||
        c.departmentCode === bragado?.departmentCode,
    );
    expect(mechitaUnits).toHaveLength(1);
    expect(nameCells.some((c) => c.locality === SIN_LOCALIDAD)).toBe(false);
    // Sanity: the fixture rows are really there.
    const stored = await db
      .select({ id: welfareReports.id })
      .from(welfareReports)
      .where(inArray(welfareReports.id, reportIds));
    expect(stored).toHaveLength(PER_PLACE * 3);
  }, 60_000);

  // Runs after the case above, over the same fixture reports.
  it("denuncia points: each homonym plots on its own row; unresolved on the province point", async () => {
    const alberti = rowByIndec.get(MECHITA_ALBERTI);
    const bragado = rowByIndec.get(MECHITA_BRAGADO);
    const at = (r: { centroidLat: string | null; centroidLng: string | null }) =>
      `${Number(r.centroidLat).toFixed(4)},${Number(r.centroidLng).toFixed(4)}`;
    const spot = (lat: string | null | undefined, lng: string | null | undefined) =>
      `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
    const province = provinceRepresentativeCentroid("Buenos Aires");

    flag.panorama = "id";
    const idRows = (await loadDenunciaCentroids(GOVT, MECHITA, since)).rows.map(at);
    const count = (s: string) => idRows.filter((r) => r === s).length;
    expect(count(spot(alberti?.latitude, alberti?.longitude))).toBeGreaterThanOrEqual(PER_PLACE);
    expect(count(spot(bragado?.latitude, bragado?.longitude))).toBeGreaterThanOrEqual(PER_PLACE);
    expect(count(spot(province.centroidLat, province.centroidLng))).toBeGreaterThanOrEqual(
      PER_PLACE,
    );

    flag.panorama = "name";
    const nameRows = (await loadDenunciaCentroids(GOVT, MECHITA, since)).rows.map(at);
    // One (province, name) centroid for every Mechita report — the confusion.
    expect(new Set(nameRows).size).toBe(1);
  }, 60_000);

  // The cell a person clicks resolves the SAME way the map grouped it.
  it("unit history on the id path: a department click counts its own rows; 'Sin localidad' the unresolved", async () => {
    const alberti = rowByIndec.get(MECHITA_ALBERTI);
    const bragado = rowByIndec.get(MECHITA_BRAGADO);
    const [dept] = await db
      .select({ name: arLocalities.departmentName })
      .from(arLocalities)
      .where(inArray(arLocalities.indecId, [MECHITA_BRAGADO]));
    const until = new Date(since.getTime() + 2 * 60 * 60 * 1000);
    const total = async (
      mode: "name" | "id",
      locality: string,
      departmentCode: string | null,
    ): Promise<number> => {
      const r = await loadUnitHistory({
        layer: "denuncias",
        province: "Buenos Aires",
        locality,
        departmentCode,
        mode,
        since,
        until,
        actor: { role: "admin" },
        jurisdictions: [],
      });
      return r.suppressed ? 0 : Object.values(r.byType).reduce((a, b) => a + b, 0);
    };
    const bragadoCell = () => total("id", dept?.name ?? "", bragado?.departmentCode ?? null);
    const albertiCell = () => total("id", "Alberti", alberti?.departmentCode ?? null);
    const sinLocalidad = () => total("id", SIN_LOCALIDAD, null);

    const before = [await bragadoCell(), await albertiCell(), await sinLocalidad()];
    await insertReports(bragado?.id ?? null, "HB");
    await insertReports(null, "HU");
    const after = [await bragadoCell(), await albertiCell(), await sinLocalidad()];

    expect((after[0] ?? 0) - (before[0] ?? 0)).toBe(PER_PLACE);
    expect((after[1] ?? 0) - (before[1] ?? 0)).toBe(0);
    expect((after[2] ?? 0) - (before[2] ?? 0)).toBe(PER_PLACE);
  }, 60_000);
});

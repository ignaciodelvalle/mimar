// Integration tests for aggregateRowsByDepartment / aggregateRowsByBarrio
// (lib/analytics/subregion-aggregate.ts) — the locality→department/barrio
// fold shared by /gob/perdidas and /gob/vigilancia (fetchCasesPerSubregion).
//
// Flagged by a fresh review as having NO dedicated test, only transitive
// coverage via fetchCasesPerSubregion. A normalization bug here would
// misattribute counts between departments — a wrong-number bug, not a crash.
//
// This is a DB-integration test: locality→department resolution reads the
// real INDEC ar_localities catalog (scripts/import-indec-localities.ts), the
// same catalog __tests__/ar-localidades.test.ts exercises. It does not seed
// fixture rows into ar_localities — it queries a handful of REAL, stable
// department/locality pairs at test time (never hardcoded INDEC codes) and
// feeds them in-memory rows via the module's own `rows` parameter, which is
// the actual boundary under test. Guarded with `catalogPopulated` exactly
// like ar-localidades.test.ts so a fresh/unimported dev DB skips instead of
// failing.

import { count as countFn, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { arLocalities, db } from "@/db";
import { WHOLE_PROVINCE_SENTINEL } from "@/lib/domain/jurisdiction-canonical";
import { aggregateRowsByDepartment } from "./subregion-aggregate";

let catalogPopulated = false;

beforeAll(async () => {
  const [row] = await db
    .select({ count: countFn() })
    .from(arLocalities)
    .where(isNull(arLocalities.removedAt));
  catalogPopulated = Number(row?.count ?? 0) > 100;
});

describe("aggregateRowsByDepartment — department attribution & summation (real ar_localities)", () => {
  const PROVINCE = "AR-B"; // Buenos Aires

  it("sums multiple localities that share a department under that department's code", async () => {
    if (!catalogPopulated) return;

    // Real, stable pair: "25 de Mayo" and "Ernestina" both resolve to the
    // "25 de Mayo" department (code 06854) in Buenos Aires.
    const rows = [
      { locality: "25 de Mayo", value: 3 },
      { locality: "Ernestina", value: 4 },
    ];

    const { cells: out } = await aggregateRowsByDepartment(PROVINCE, rows);
    const dept = out.find((r) => r.name === "25 de Mayo");
    expect(dept).toBeDefined();
    expect(dept?.count).toBe(7); // 3 + 4, never misattributed elsewhere
    expect(dept?.suppressed).toBeFalsy();
  });

  it("attributes different localities to their own distinct departments (no cross-bleed)", async () => {
    if (!catalogPopulated) return;

    // "25 de Mayo" → department "25 de Mayo" (06854); "9 de Julio" locality →
    // department "9 de Julio" (06588). Different departments, must not merge.
    const rows = [
      { locality: "25 de Mayo", value: 6 },
      { locality: "9 de Julio", value: 8 },
    ];

    const { cells: out } = await aggregateRowsByDepartment(PROVINCE, rows);
    const deptA = out.find((r) => r.name === "25 de Mayo");
    const deptB = out.find((r) => r.name === "9 de Julio");
    expect(deptA?.count).toBe(6);
    expect(deptB?.count).toBe(8);
    // Every OTHER department in the province (no matching input row) stays at
    // the honest zero — the full-set contract (not a filtered/sparse list).
    const untouched = out.find((r) => r.name === "Adolfo Alsina");
    expect(untouched?.count).toBe(0);
    expect(untouched?.suppressed).toBeFalsy();
  });

  it("returns the FULL department set for the province, not just departments with data", async () => {
    if (!catalogPopulated) return;
    const { cells: out } = await aggregateRowsByDepartment(PROVINCE, []);
    // Buenos Aires has well over 100 partidos/departments.
    expect(out.length).toBeGreaterThan(100);
    for (const r of out) {
      expect(r.count).toBe(0);
    }
  });
});

describe("aggregateRowsByDepartment — k-anonymity suppression (k=5)", () => {
  const PROVINCE = "AR-B";

  it("suppresses a department whose folded count is below k=5: value:0, suppressed:true", async () => {
    if (!catalogPopulated) return;
    // Single row, value 3 → below the k=5 floor.
    const { cells: out } = await aggregateRowsByDepartment(PROVINCE, [
      { locality: "25 de Mayo", value: 3 },
    ]);
    const dept = out.find((r) => r.name === "25 de Mayo");
    expect(dept).toBeDefined();
    expect(dept?.suppressed).toBe(true);
    expect(dept?.count).toBe(0); // real small count (3) is NEVER leaked
  });

  it("passes a department at/above k=5 through with its real value, suppressed:false", async () => {
    if (!catalogPopulated) return;
    const { cells: out } = await aggregateRowsByDepartment(PROVINCE, [
      { locality: "25 de Mayo", value: 5 },
    ]);
    const dept = out.find((r) => r.name === "25 de Mayo");
    expect(dept).toBeDefined();
    expect(dept?.count).toBe(5);
    expect(dept?.suppressed).toBeFalsy();
  });

  it("summed count crossing the k=5 floor from multiple sub-k localities is no longer suppressed", async () => {
    if (!catalogPopulated) return;
    // Neither row alone would clear k=5, but together (3 + 4 = 7) they resolve
    // to the SAME department and must clear the floor once folded.
    const { cells: out } = await aggregateRowsByDepartment(PROVINCE, [
      { locality: "25 de Mayo", value: 3 },
      { locality: "Ernestina", value: 4 },
    ]);
    const dept = out.find((r) => r.name === "25 de Mayo");
    expect(dept?.count).toBe(7);
    expect(dept?.suppressed).toBeFalsy();
  });
});

describe("aggregateRowsByBarrio (CABA, via aggregateRowsByDepartment('AR-C', ...))", () => {
  const CABA = "AR-C";

  it("attributes rows to the correct barrio and sums correctly", async () => {
    if (!catalogPopulated) return;
    const { cells: out } = await aggregateRowsByDepartment(CABA, [
      { locality: "Palermo", value: 2 },
      { locality: "Palermo", value: 3 },
      { locality: "Recoleta", value: 9 },
    ]);
    const palermo = out.find((r) => r.name === "Palermo");
    const recoleta = out.find((r) => r.name === "Recoleta");
    expect(palermo?.count).toBe(5); // 2 + 3, folded into ONE barrio
    expect(palermo?.suppressed).toBeFalsy();
    expect(recoleta?.count).toBe(9);
    expect(recoleta?.suppressed).toBeFalsy();
    // A third, untouched barrio stays an honest zero.
    const untouched = out.find((r) => r.name === "Belgrano");
    expect(untouched?.count).toBe(0);
  });

  it("suppresses a below-k=5 barrio count; a lone at/above-k=5 sibling is ALSO complementarily suppressed", async () => {
    if (!catalogPopulated) return;
    // Only Palermo and Recoleta carry non-zero counts; the other ~46 CABA
    // barrios are honest zeros. Palermo (4) is primary-suppressed (k=5), and it
    // is the ONLY suppressed cell in the (single-group) CABA set, with exactly
    // one non-zero visible sibling (Recoleta). Per the differencing-attack
    // defense (redactSmallSubregionCells now runs complementarySuppress, mirroring
    // Panorama's repository pipeline): if CABA's province-map total is published
    // unsuppressed elsewhere, Palermo's exact count would be recoverable as
    // `total − Recoleta − 0s`, so Recoleta must be suppressed TOO — not because
    // Recoleta itself is small, but because it is the sole cell that could expose
    // Palermo by subtraction.
    const { cells: out } = await aggregateRowsByDepartment(CABA, [
      { locality: "Palermo", value: 4 }, // below k=5
      { locality: "Recoleta", value: 5 }, // at k=5, but the lone complement here
    ]);
    const palermo = out.find((r) => r.name === "Palermo");
    const recoleta = out.find((r) => r.name === "Recoleta");
    expect(palermo?.suppressed).toBe(true);
    expect(palermo?.count).toBe(0);
    expect(recoleta?.suppressed).toBe(true);
    expect(recoleta?.count).toBe(0);
  });

  it("returns the full barrio set for CABA, excluding the province catch-all row", async () => {
    if (!catalogPopulated) return;
    const { cells: out } = await aggregateRowsByDepartment(CABA, []);
    expect(out.length).toBeGreaterThan(40); // CABA has 48 official barrios
    expect(out.find((r) => r.name === "Ciudad Autónoma de Buenos Aires")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L1·2 of the locality plan (2026-09-08): the cases that HURT, written by hand.
//
// Deliberately NOT a parity test across folds. Two of the folds are the same
// function and one imports another, so a parity test would go green and read
// as "no drift" — exactly the false green this repo forbids. What protects the
// numbers is pressing each fold with the inputs real data actually carries:
// a locality outside the catalog, the same barrio spelled with and without
// accents, a null locality, and the whole-province sentinel. Values are kept
// >= k=5 so k-anonymity never masks what is being asserted, except in the
// describe that is ABOUT suppression.
//
// Every one of these used to fall through a bare `continue` (L1·1). Now each
// must land in exactly one place: a cell, or the `sinUbicacion` residual.
// ---------------------------------------------------------------------------

const sum = (cells: { count: number }[]) => cells.reduce((s, r) => s + r.count, 0);

describe("aggregateRowsByDepartment — hurt cases: every row lands in a cell or in sinUbicacion", () => {
  const PROVINCE = "AR-B";

  it("a locality OUTSIDE the catalog goes to the residual, never to a department", async () => {
    if (!catalogPopulated) return;
    const out = await aggregateRowsByDepartment(PROVINCE, [
      { locality: "Not A Real Locality Name Xyz123", value: 7 },
      { locality: "25 de Mayo", value: 6 },
    ]);
    expect(sum(out.cells)).toBe(6);
    expect(out.sinUbicacion).toEqual({ count: 7, suppressed: false });
  });

  it("a NULL locality goes to the residual", async () => {
    if (!catalogPopulated) return;
    const out = await aggregateRowsByDepartment(PROVINCE, [
      { locality: null, value: 9 },
      { locality: "25 de Mayo", value: 6 },
    ]);
    expect(out.cells.find((r) => r.name === "25 de Mayo")?.count).toBe(6);
    expect(sum(out.cells)).toBe(6);
    expect(out.sinUbicacion).toEqual({ count: 9, suppressed: false });
  });

  it("the whole-province sentinel is not a department: it goes to the residual", async () => {
    if (!catalogPopulated) return;
    const out = await aggregateRowsByDepartment(PROVINCE, [
      { locality: WHOLE_PROVINCE_SENTINEL, value: 8 },
    ]);
    expect(sum(out.cells)).toBe(0);
    expect(out.sinUbicacion).toEqual({ count: 8, suppressed: false });
  });

  it("conserves the total: Σ(cells) + sinUbicacion = Σ(input) when nothing is suppressed", async () => {
    if (!catalogPopulated) return;
    const rows = [
      { locality: "25 de Mayo", value: 6 },
      { locality: "Ernestina", value: 5 },
      { locality: "9 de Julio", value: 8 },
      { locality: null, value: 5 },
      { locality: WHOLE_PROVINCE_SENTINEL, value: 5 },
      { locality: "Narnia", value: 6 },
    ];
    const out = await aggregateRowsByDepartment(PROVINCE, rows);
    expect(out.cells.some((c) => c.suppressed)).toBe(false);
    expect(sum(out.cells) + out.sinUbicacion.count).toBe(
      sum(rows.map((r) => ({ count: r.value }))),
    );
    expect(out.sinUbicacion.count).toBe(16);
  });

  it("an unknown province code yields no cells and no residual", async () => {
    const out = await aggregateRowsByDepartment("AR-ZZ", [{ locality: "Anything", value: 1 }]);
    expect(out).toEqual({ cells: [], sinUbicacion: { count: 0, suppressed: false } });
  });
});

describe("aggregateRowsByBarrio (CABA) — hurt cases", () => {
  const CABA = "AR-C";

  it("Núñez and Nunez are ONE barrio: 3 + 3 is a visible 6, not two hidden 3s", async () => {
    if (!catalogPopulated) return;
    const out = await aggregateRowsByDepartment(CABA, [
      { locality: "Núñez", value: 3 },
      { locality: "Nunez", value: 3 },
    ]);
    const nunez = out.cells.find((r) => r.code === "nunez");
    expect(nunez).toBeDefined();
    expect(nunez?.suppressed).toBeFalsy();
    expect(nunez?.count).toBe(6);
    expect(out.sinUbicacion).toEqual({ count: 0, suppressed: false });
  });

  it("CABA's city-wide INDEC name is the whole-province form, not a barrio: residual", async () => {
    if (!catalogPopulated) return;
    const out = await aggregateRowsByDepartment(CABA, [
      { locality: "Ciudad Autónoma de Buenos Aires", value: 5 },
      { locality: WHOLE_PROVINCE_SENTINEL, value: 5 },
      { locality: "Recoleta", value: 9 },
    ]);
    expect(sum(out.cells)).toBe(9);
    expect(out.sinUbicacion).toEqual({ count: 10, suppressed: false });
  });

  it("a name that is not a barrio (a sub-barrio nickname) and a null locality go to the residual", async () => {
    if (!catalogPopulated) return;
    const out = await aggregateRowsByDepartment(CABA, [
      { locality: "Palermo Hollywood", value: 6 },
      { locality: null, value: 5 },
      { locality: "Palermo", value: 7 },
    ]);
    expect(out.cells.find((r) => r.name === "Palermo")?.count).toBe(7);
    expect(out.sinUbicacion).toEqual({ count: 11, suppressed: false });
  });
});

describe("sinUbicacion is k-protected like any cell", () => {
  it("a residual of 1..4 is published as suppressed with its count redacted", async () => {
    if (!catalogPopulated) return;
    const out = await aggregateRowsByDepartment("AR-B", [
      { locality: null, value: 3 },
      { locality: "25 de Mayo", value: 6 },
      { locality: "9 de Julio", value: 8 },
    ]);
    expect(out.sinUbicacion).toEqual({ count: 0, suppressed: true });
  });

  it("a lone suppressed residual drags its smallest visible sibling into suppression (no differencing)", async () => {
    if (!catalogPopulated) return;
    // Recoleta alone is visible; the residual (3) is the ONLY suppressed term.
    // With a published CABA total, Recoleta visible would give the residual away
    // by subtraction, so it must be complementarily suppressed too.
    const out = await aggregateRowsByDepartment("AR-C", [
      { locality: null, value: 3 },
      { locality: "Recoleta", value: 9 },
    ]);
    const recoleta = out.cells.find((r) => r.name === "Recoleta");
    expect(out.sinUbicacion.suppressed).toBe(true);
    expect(out.sinUbicacion.count).toBe(0);
    expect(recoleta?.suppressed).toBe(true);
    expect(recoleta?.count).toBe(0);
  });
});

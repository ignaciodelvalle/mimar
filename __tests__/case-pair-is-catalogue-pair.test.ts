// Fence: a place a writer stores is either ONE catalogue row, or honestly none.
//
// localidades-por-id, place-capture-contract + place-identity. The INDEC
// catalogue ships 68 (province, name) collisions inside a province — Mechita is
// in partido Alberti (06021030) AND partido Bragado (06112080), both in Buenos
// Aires. `localityByName` settles such a name by taking the alphabetically
// first department, so every writer that resolved a NAME without an id quietly
// filed Bragado's animals, bites and denuncias under Alberti (P1: never confuse
// places).
//
// What every write path must answer for an ambiguous name with no id:
//   - strict writers (a person picked from the catalogue) REFUSE it, so the
//     person picks the row they meant;
//   - soft writers (a report that must never be blocked) keep the PROVINCE and
//     store no locality and no id — a province-level, visibly unresolved place —
//     never either homonym.
// And with an id, the id wins, and the stored name is that row's name.
//
// Cross-province homonyms (Villa María, Buenos Aires 06021060 vs Córdoba
// 14042170) are NOT ambiguous inside a province: the (province, name) pair
// already names one row. They are covered by the lost-routing parity fence.

import { inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { resolveBiteJurisdiction } from "@/app/api/v1/pets/[publicToken]/events/bite-jurisdiction";
import { arLocalities, db } from "@/db";
import { normalizeLocationForWrite } from "@/lib/domain/location-normalize";
import type { LocationValue } from "@/lib/domain/location-value";

const MECHITA_ALBERTI = "06021030";
const MECHITA_BRAGADO = "06112080";

const rowIdByIndec = new Map<string, string>();

beforeAll(async () => {
  const rows = await db
    .select({ id: arLocalities.id, indecId: arLocalities.indecId })
    .from(arLocalities)
    .where(inArray(arLocalities.indecId, [MECHITA_ALBERTI, MECHITA_BRAGADO]));
  for (const r of rows) if (r.indecId) rowIdByIndec.set(r.indecId, r.id);
  // The fixtures ARE the catalogue: a re-import that renumbered them must say
  // so here instead of failing every assertion below for an unrelated reason.
  expect(rowIdByIndec.size, "both Mechita catalogue rows must exist").toBe(2);
});

function mechita(localityIndecId: string | null): LocationValue {
  return {
    province: "Buenos Aires",
    provinceCode: null,
    locality: "Mechita",
    localityIndecId,
    lat: null,
    lng: null,
    address: null,
  };
}

describe("the write gate never picks a homonym", () => {
  it("honours the Bragado id: the stored row is Bragado's, under its own name", async () => {
    const out = await normalizeLocationForWrite(mechita(MECHITA_BRAGADO), { locality: "soft" });
    expect(out).toMatchObject({
      province: "Buenos Aires",
      locality: "Mechita",
      localityId: rowIdByIndec.get(MECHITA_BRAGADO),
    });
  });

  it("honours the Alberti id: two offices, two different rows", async () => {
    const out = await normalizeLocationForWrite(mechita(MECHITA_ALBERTI), { locality: "strict" });
    expect(out.localityId).toBe(rowIdByIndec.get(MECHITA_ALBERTI));
  });

  it("soft: an ambiguous name with no id keeps the province and stores no locality", async () => {
    const out = await normalizeLocationForWrite(mechita(null), { locality: "soft" });
    expect(out).toMatchObject({ province: "Buenos Aires", locality: null, localityId: null });
  });

  it("strict: an ambiguous name with no id is refused, never filed under Alberti", async () => {
    await expect(normalizeLocationForWrite(mechita(null), { locality: "strict" })).rejects.toThrow(
      /más de una localidad llamada Mechita/,
    );
  });
});

describe("the bite API never files an ambiguous pair under a homonym", () => {
  // Known failure until work unit A4 (localidades-por-id): flip to `it` there.
  it.fails("an ambiguous pair with no id and no pin is a province-level bite", async () => {
    const out = await resolveBiteJurisdiction({
      provinceCode: "AR-B",
      localityName: "Mechita",
      localityIndecId: null,
      locationLat: null,
      locationLng: null,
    });
    expect(out).toEqual({ ok: true, province: "Buenos Aires", locality: null });
  });

  it("the id picks the row: Bragado's Mechita stays Bragado's", async () => {
    const out = await resolveBiteJurisdiction({
      provinceCode: "AR-B",
      localityName: "Mechita",
      localityIndecId: MECHITA_BRAGADO,
      locationLat: null,
      locationLng: null,
    });
    expect(out).toMatchObject({ ok: true, province: "Buenos Aires", locality: "Mechita" });
  });
});

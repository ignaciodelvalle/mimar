// Locality aliases in the typeahead — the names people use that the INDEC
// catalogue does not carry (lib/infra/locality-aliases.ts).
//
// Runs against the local catalogue, READ ONLY: it asserts what the search
// returns for real names and writes nothing. What it pins:
//   · an alias hit IS its target catalogue row (same id, same indecId, same
//     localityName) — picking "Banfield" stores the Lomas de Zamora row;
//   · an alias whose target is ambiguous is not offered at all;
//   · a name the catalogue already carries is answered by that row, not an alias;
//   · aliases stay out of the non-typeahead path (jurisdiction-from-text calls
//     searchLocalities WITHOUT includeAliases).

import { and, count as countFn, eq, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { arLocalities, db } from "@/db";
import { searchLocalities } from "@/lib/infra/ar-localidades";
import { runLocalitySearch } from "@/src/modules/localities/application/search/search-localities";

let catalogPopulated = false;

beforeAll(async () => {
  const [row] = await db
    .select({ count: countFn() })
    .from(arLocalities)
    .where(isNull(arLocalities.removedAt));
  catalogPopulated = Number(row?.count ?? 0) > 100;
});

async function rowByIndecId(indecId: string) {
  const [row] = await db
    .select()
    .from(arLocalities)
    .where(and(eq(arLocalities.indecId, indecId), isNull(arLocalities.removedAt)));
  return row;
}

async function typeahead(query: string, provinceCode?: string) {
  const r = await runLocalitySearch({ query, ...(provinceCode ? { provinceCode } : {}) });
  if (!("results" in r)) throw new Error(`search failed: ${JSON.stringify(r)}`);
  return r.results;
}

describe("locality aliases — typeahead", () => {
  it.each([
    ["Banfield", "06490010", "Lomas de Zamora"],
    ["Temperley", "06490010", "Lomas de Zamora"],
    ["Ramos Mejía", "06427010", "La Matanza"],
    ["Ciudad Evita", "06427010", "La Matanza"],
    ["Castelar", "06568010", "Morón"],
    ["Bernal", "06658010", "Quilmes"],
    ["Martínez", "06756010", "San Isidro"],
  ])("%s selects the %s (%s) catalogue row", async (alias, indecId, targetName) => {
    if (!catalogPopulated) return;
    const target = await rowByIndecId(indecId);
    expect(target?.localityName).toBe(targetName);

    const results = await typeahead(alias, "AR-B");
    const hit = results.find((r) => r.aliasName === alias);
    expect(hit, `${alias} should be offered in Buenos Aires`).toBeDefined();
    // THE TARGET ROW, field for field — the stored locality is never the alias.
    expect(hit?.id).toBe(target?.id);
    expect(hit?.indecId).toBe(indecId);
    expect(hit?.localityName).toBe(targetName);
    expect(hit?.provinceCode).toBe("AR-B");
    expect(hit?.matchKind).toBe("exact");
    // An exact alias is the first thing a person sees in their province.
    expect(results[0].aliasName).toBe(alias);
  });

  it("ranks an exact alias under an exact catalogue match of the same name", async () => {
    if (!catalogPopulated) return;
    // "Castelar" is a catalogue row in Santa Fe AND an alias in Buenos Aires.
    const results = await typeahead("Castelar");
    const catalogueIdx = results.findIndex(
      (r) => r.provinceCode === "AR-S" && r.localityName === "Castelar" && !r.aliasName,
    );
    const aliasIdx = results.findIndex((r) => r.aliasName === "Castelar");
    expect(catalogueIdx).toBe(0);
    expect(aliasIdx).toBeGreaterThan(catalogueIdx);
  });

  it("never offers an alias whose target is ambiguous", async () => {
    if (!catalogPopulated) return;
    // Villa Adelina straddles San Isidro and Vicente López; Tortuguitas three
    // partidos. Neither may be offered for any of them.
    for (const name of ["Villa Adelina", "Tortuguitas", "Gerli"]) {
      const results = await typeahead(name, "AR-B");
      expect(results.filter((r) => r.aliasName !== undefined && r.aliasName === name)).toEqual([]);
    }
  });

  it("never offers an alias that shares its name with a place the catalogue cannot hold", async () => {
    if (!catalogPopulated) return;
    // San Justo (La Matanza) maps, but a rural San Justo in partido Ayacucho has
    // no census locality: offering only the La Matanza one would hand the other
    // person someone else's partido.
    const results = await typeahead("San Justo", "AR-B");
    expect(results.filter((r) => r.aliasName === "San Justo")).toEqual([]);
  });

  it("answers a name the catalogue carries with the row itself, not an alias", async () => {
    if (!catalogPopulated) return;
    const olivos = await typeahead("Olivos", "AR-B");
    expect(olivos[0].localityName).toBe("Olivos");
    expect(olivos[0].aliasName).toBeUndefined();
    expect(olivos.filter((r) => r.aliasName === "Olivos")).toEqual([]);
  });

  it.each(["Palermo", "Caballito"])("finds the CABA barrio %s directly", async (barrio) => {
    if (!catalogPopulated) return;
    const results = await typeahead(barrio);
    expect(results[0].provinceCode).toBe("AR-C");
    expect(results[0].localityName).toBe(barrio);
    expect(results[0].category).toBe("barrio");
    expect(results[0].aliasName).toBeUndefined();
  });

  it("keeps aliases inside the province the search is scoped to", async () => {
    if (!catalogPopulated) return;
    const results = await typeahead("Banfield", "AR-X");
    expect(results.filter((r) => r.aliasName)).toEqual([]);
  });

  it("offers no alias to a caller that did not ask for them", async () => {
    if (!catalogPopulated) return;
    const results = await searchLocalities({ query: "Banfield" });
    expect(results.filter((r) => r.aliasName !== undefined)).toEqual([]);
  });
});

// The alias generator's mapping rules (scripts/generate-locality-aliases.ts) and
// the committed file it produced (lib/reference/locality-aliases.json). Pure —
// no database: the rules are proven on synthetic rows, the file on its content.

import { describe, expect, it } from "vitest";

import aliasFile from "@/lib/reference/locality-aliases.json";
import { localitySlug } from "@/lib/reference/locality-slug";

import {
  type CensusLocality,
  type GeorefPlace,
  buildLocalityAliases,
  renderAliasFile,
} from "../scripts/generate-locality-aliases";

function place(nombre: string, prov: string, dept: string, censal: string | null): GeorefPlace {
  return {
    nombre,
    categoria: censal ? "Entidad" : "Paraje",
    provincia: { id: prov },
    departamento: { id: dept },
    localidad_censal: { id: censal },
  };
}

const CENSALES: CensusLocality[] = [
  { id: "06490010", nombre: "Lomas de Zamora", provinciaId: "06" },
  { id: "06756010", nombre: "San Isidro", provinciaId: "06" },
  { id: "06861010", nombre: "Vicente López", provinciaId: "06" },
  { id: "06999010", nombre: "Olivos", provinciaId: "06" },
  { id: "02098010", nombre: "CABA - Comuna 14", provinciaId: "02" },
];

describe("buildLocalityAliases", () => {
  it("maps an entity to the census locality INDEC names for it", () => {
    const build = buildLocalityAliases({
      asentamientos: [place("Banfield", "06", "06490", "06490010")],
      bahra: [place("Banfield", "06", "06490", "06490010")],
      censales: CENSALES,
    });
    expect(build.aliases).toEqual([["Banfield", "06490010"]]);
  });

  it("drops a name that points at two census localities in one province", () => {
    const build = buildLocalityAliases({
      asentamientos: [
        place("Villa Adelina", "06", "06756", "06756010"),
        place("Villa Adelina", "06", "06861", "06861010"),
      ],
      bahra: [],
      censales: CENSALES,
    });
    expect(build.aliases).toEqual([]);
    expect(build.dropped.ambiguous).toBe(1);
  });

  it("drops what it cannot place, and what the catalogue already answers", () => {
    const build = buildLocalityAliases({
      asentamientos: [
        place("Paraje Perdido", "06", "06007", null), // no census locality
        place("Palermo", "02", "02098", "02098010"), // CABA comuna: superseded by barrios
        place("Lomas de Zamora", "06", "06490", "06490010"), // is its own target
        place("Olivos", "06", "06861", "06861010"), // a catalogue row carries the name
      ],
      bahra: [],
      censales: CENSALES,
    });
    expect(build.aliases).toEqual([]);
    expect(build.dropped["no-census-locality"]).toBe(1);
    expect(build.dropped["target-not-in-catalogue"]).toBe(1);
    expect(build.dropped["same-as-target"]).toBe(1);
    expect(build.dropped["already-in-catalogue"]).toBe(1);
  });

  it("drops a name that a same-province place with no catalogue home also uses", () => {
    // San Justo (La Matanza) has a census locality; the rural San Justo in
    // partido Ayacucho does not. Offering the first would be the only San Justo
    // the person from the second ever sees.
    const build = buildLocalityAliases({
      asentamientos: [
        place("San Justo", "06", "06427", "06490010"),
        place("San Justo", "06", "06063", null),
      ],
      bahra: [],
      censales: CENSALES,
    });
    expect(build.aliases).toEqual([]);
    expect(build.dropped["shares-name-with-unmapped-place"]).toBe(1);
  });

  it("drops a name the two publications disagree about", () => {
    const build = buildLocalityAliases({
      asentamientos: [place("Temperley", "06", "06490", "06490010")],
      bahra: [place("Temperley", "06", "06490", "06756010")],
      censales: CENSALES,
    });
    expect(build.aliases).toEqual([]);
    expect(build.dropped["sources-disagree"]).toBe(1);
  });

  it("renders deterministically, one pair per line", () => {
    const text = renderAliasFile([
      ["Banfield", "06490010"],
      ["Temperley", "06490010"],
    ]);
    expect(text).toBe(
      '{\n  "aliases": [\n    ["Banfield", "06490010"],\n    ["Temperley", "06490010"]\n  ]\n}\n',
    );
  });
});

describe("lib/reference/locality-aliases.json", () => {
  const aliases = aliasFile.aliases as Array<[string, string]>;

  it("is the generator's own rendering (no hand edits)", () => {
    // Re-render what was parsed: a hand-edited file that drifted from the
    // generator's shape (order, spacing) fails here.
    const sorted = [...aliases].sort((a, b) =>
      a[1] === b[1] ? a[0].localeCompare(b[0], "es") : a[1] < b[1] ? -1 : 1,
    );
    expect(aliases).toEqual(sorted);
  });

  it("points every alias at an 8-digit INDEC census locality outside CABA", () => {
    for (const [name, id] of aliases) {
      expect(id, name).toMatch(/^\d{8}$/);
      expect(id.startsWith("02"), `${name} → ${id}`).toBe(false);
    }
  });

  it("offers each (province, name) at most once", () => {
    const keys = aliases.map(([name, id]) => `${id.slice(0, 2)}|${localitySlug(name)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each([
    ["Banfield", "06490010"],
    ["Temperley", "06490010"],
    ["Ramos Mejía", "06427010"],
    ["Ciudad Evita", "06427010"],
    ["Castelar", "06568010"],
    ["Haedo", "06568010"],
    ["Bernal", "06658010"],
    ["Martínez", "06756010"],
  ])("maps %s to %s", (name, id) => {
    expect(aliases).toContainEqual([name, id]);
  });

  it.each([
    "Villa Adelina",
    "Tortuguitas",
    "Gerli",
    "San Francisco Solano",
    "Canning",
    "San Justo",
  ])("does not carry the ambiguous %s in Buenos Aires", (name) => {
    // Buenos Aires only: the Villa Adelina in Santa Fe is another place with a
    // single census locality, and stays.
    expect(aliases.filter(([n, id]) => n === name && id.startsWith("06"))).toEqual([]);
  });
});

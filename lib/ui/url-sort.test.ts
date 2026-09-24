// Tests for lib/ui/url-sort.ts (Q4) — pins the fail-closed parse, the
// PanoramaDataTable toggle semantics, the aria-sort mapping and the
// non-mutating server re-sort.

import { describe, expect, it } from "vitest";

import { ariaSortValue, nextUrlSortParams, parseUrlSort, sortRowsByUrlSort } from "./url-sort";

const ALLOWED = ["nombre", "senales"] as const;
const FALLBACK = { key: "senales", dir: "desc" } as const;

describe("parseUrlSort", () => {
  it("returns the fallback whole when orden is absent", () => {
    expect(parseUrlSort({}, ALLOWED, FALLBACK)).toEqual(FALLBACK);
  });

  it("fails closed on an unknown orden — fallback key AND dir, stray dir ignored", () => {
    expect(parseUrlSort({ orden: "dni", dir: "asc" }, ALLOWED, FALLBACK)).toEqual(FALLBACK);
  });

  it("honors a valid orden + dir pair", () => {
    expect(parseUrlSort({ orden: "nombre", dir: "asc" }, ALLOWED, FALLBACK)).toEqual({
      key: "nombre",
      dir: "asc",
    });
  });

  it("takes the fallback dir when dir is missing or invalid", () => {
    expect(parseUrlSort({ orden: "nombre" }, ALLOWED, FALLBACK).dir).toBe("desc");
    expect(parseUrlSort({ orden: "nombre", dir: "up" }, ALLOWED, FALLBACK).dir).toBe("desc");
  });
});

describe("nextUrlSortParams", () => {
  it("flips the direction when the active column is clicked again", () => {
    expect(nextUrlSortParams({ key: "senales", dir: "desc" }, "senales", "desc")).toEqual({
      orden: "senales",
      dir: "asc",
    });
  });

  it("starts a new column at its own default direction", () => {
    expect(nextUrlSortParams({ key: "senales", dir: "asc" }, "nombre", "asc")).toEqual({
      orden: "nombre",
      dir: "asc",
    });
  });
});

describe("ariaSortValue", () => {
  it("maps active asc/desc and inactive none", () => {
    expect(ariaSortValue(true, "asc")).toBe("ascending");
    expect(ariaSortValue(true, "desc")).toBe("descending");
    expect(ariaSortValue(false, "asc")).toBe("none");
  });
});

describe("sortRowsByUrlSort", () => {
  const rows = [
    { name: "b", n: 1 },
    { name: "a", n: 3 },
    { name: "c", n: 2 },
  ];
  const comparators = {
    nombre: (a: (typeof rows)[number], b: (typeof rows)[number]) => a.name.localeCompare(b.name),
    senales: (a: (typeof rows)[number], b: (typeof rows)[number]) => a.n - b.n,
  };

  it("sorts ascending and descending by the keyed comparator", () => {
    expect(
      sortRowsByUrlSort(rows, { key: "nombre", dir: "asc" }, comparators).map((r) => r.name),
    ).toEqual(["a", "b", "c"]);
    expect(
      sortRowsByUrlSort(rows, { key: "senales", dir: "desc" }, comparators).map((r) => r.n),
    ).toEqual([3, 2, 1]);
  });

  it("never mutates the input array", () => {
    const before = [...rows];
    sortRowsByUrlSort(rows, { key: "nombre", dir: "asc" }, comparators);
    expect(rows).toEqual(before);
  });
});

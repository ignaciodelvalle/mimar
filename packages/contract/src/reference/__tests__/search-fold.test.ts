// The search fold both clients share (component audit 2026-10-07): the app's
// breed pickers matched with `toLowerCase().includes`, so "dalmata" did not find
// "Dálmata" while the web's search did.

import { describe, expect, it } from "vitest";

import { DOG_BREEDS } from "../breeds.ts";
import { chosenLocalityParent } from "../locality-copy.ts";
import { foldForSearch, matchesSearch } from "../search-fold.ts";

describe("foldForSearch", () => {
  it("drops accents and case", () => {
    expect(foldForSearch("Dálmata")).toBe("dalmata");
    expect(foldForSearch("Bulldog Francés")).toBe("bulldog frances");
    expect(foldForSearch("GRAN DANÉS")).toBe("gran danes");
    expect(foldForSearch("Pequeñés")).toBe("pequenes");
  });

  it("does not trim — the caller decides what an edge space means", () => {
    expect(foldForSearch("  Ñandú ")).toBe("  nandu ");
  });
});

describe("matchesSearch", () => {
  it.each([
    ["Dálmata", "dalmata"],
    ["Bulldog Francés", "frances"],
    ["Gran Danés", "danes"],
    ["Labrador", "LABRADOR"],
    ["Labrador", "labRa"],
    ["Dálmata", "DÁLMATA"],
  ])("finds %s for %s", (candidate, query) => {
    expect(matchesSearch(candidate, query)).toBe(true);
  });

  it("does not find what is not there", () => {
    expect(matchesSearch("Dálmata", "danes")).toBe(false);
  });

  it("matches everything on an empty or blank query", () => {
    expect(matchesSearch("Dálmata", "")).toBe(true);
    expect(matchesSearch("Dálmata", "   ")).toBe(true);
  });

  it("finds the real catalog entries the audit named", () => {
    const find = (query: string) => DOG_BREEDS.filter((b) => matchesSearch(b, query));
    expect(find("dalmata")).toContain("Dálmata");
    expect(find("frances")).toContain("Bulldog Francés");
    expect(find("danes")).toContain("Gran Danés");
  });
});

describe("locality-copy keeps folding the same way after the extraction", () => {
  it("drops a department that only differs from the name by accents and case", () => {
    expect(
      chosenLocalityParent({
        localityName: "Río Cuarto",
        provinceCode: "AR-X",
        provinceName: "Córdoba",
        departmentName: "RIO CUARTO",
      }),
    ).toBe("Córdoba");
  });
});

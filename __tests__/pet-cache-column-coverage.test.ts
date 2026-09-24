// Fitness test — every `pets` column is either re-derived or excluded on purpose
// (finding A08-4, 2026-09 fresh review).
//
// rederivePetCache only reports on the keys of its hand-kept CHECKED_COLUMNS
// map, and the existing suite (pet-cache-rederivation.test.ts) compares the
// report's keys against CHECKED_COLUMN_NAMES — the same constant against
// itself, which can never notice a column that is missing from it. That is how
// `jurisdiction*` and the three condition columns sat in NEITHER the checked
// list NOR the excluded-columns comment until a human audit found them.
//
// So this test checks the SUBJECT, not a list: every property drizzle reports
// on `pets` must be named by exactly one side — CHECKED_COLUMN_NAMES (the
// harness re-derives it) or EXCLUDED_CACHE_COLUMNS (a reasoned exclusion).
// Offline: getTableColumns reads the drizzle model, no database needed.
//
// Precedent: __tests__/denuncia-data-partition-fitness.test.ts.

import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { pets } from "@/db/schema";
import { CHECKED_COLUMN_NAMES, EXCLUDED_CACHE_COLUMNS } from "@/lib/infra/rederive-pet-cache";

const petProperties = Object.keys(getTableColumns(pets));
const excluded = Object.keys(EXCLUDED_CACHE_COLUMNS);

// Checked names that are NOT `pets` properties: the harness reads their stored
// side from the canonical pet_identifications row (ARCH-Q / ARCH-S — the
// microchip columns were dropped from `pets`, the tattoo ones left the drizzle
// model). Pinned exactly, so a typo in CHECKED_COLUMNS cannot hide here.
const IDENTIFICATION_SOURCED = [
  "microchipId",
  "microchipCountryCode",
  "microchipImplantedAt",
  "microchipImplantedBy",
  "microchipLocation",
  "tattooCode",
  "tattooLocation",
  "tattooDescription",
  "tattooRecordedAt",
  "tattooRecordedBy",
];

describe("pets cache coverage — every column is re-derived or excluded", () => {
  it("names every pets column on one side", () => {
    const unplaced = petProperties.filter(
      (p) => !CHECKED_COLUMN_NAMES.includes(p) && !excluded.includes(p),
    );
    expect(
      unplaced,
      "New pets column(s) in neither list. If a writer dual-writes it next to an " +
        "event, add a replay* projection and a CHECKED_COLUMNS entry in " +
        "lib/infra/rederive-pet-cache.ts; otherwise add it to EXCLUDED_CACHE_COLUMNS " +
        "with the reason class that is actually true.",
    ).toEqual([]);
  });

  it("never names a column on both sides", () => {
    expect(CHECKED_COLUMN_NAMES.filter((c) => excluded.includes(c))).toEqual([]);
  });

  it("excludes only columns pets actually has", () => {
    expect(excluded.filter((c) => !petProperties.includes(c))).toEqual([]);
  });

  it("checks only pets columns, plus the pinned identification-sourced set", () => {
    const offTable = CHECKED_COLUMN_NAMES.filter((c) => !petProperties.includes(c));
    expect([...offTable].sort()).toEqual([...IDENTIFICATION_SOURCED].sort());
  });
});

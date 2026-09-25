// Fence: every column this code WRITES exists in the database it runs against.
//
// R9 of the 2026-09-25 localities audit. Migration 0246 added
// `govt_assignments.locality_id`, and the C2b writers insert into it; an
// environment on this code WITHOUT 0246 fails every govt account creation and
// every grant, and nothing said so until a person tried. Stage A of
// `localidades-por-id` adds more columns in stage B, so the trap is about to
// get more places to hide.
//
// Two halves:
//   - the pure comparison (`missingRequiredColumns`) against a fixture, so the
//     rule is tested without a database;
//   - the live check against the local database, which is the same query
//     `/api/health` runs (lib/infra/schema-guard.ts), so a migration that
//     never reached local is caught here before it is caught on staging.

import { describe, expect, it } from "vitest";

import { db } from "@/db";
import {
  REQUIRED_COLUMNS,
  findMissingRequiredColumns,
  missingRequiredColumns,
} from "@/lib/infra/schema-guard";

describe("missingRequiredColumns (pure)", () => {
  const everything = REQUIRED_COLUMNS.map(({ table, column }) => ({ table, column }));

  it("answers nothing missing when every required column is present", () => {
    expect(missingRequiredColumns(everything)).toEqual([]);
  });

  it("names the one column a database without 0246 lacks", () => {
    const without0246 = everything.filter(
      (c) => !(c.table === "govt_assignments" && c.column === "locality_id"),
    );
    expect(missingRequiredColumns(without0246)).toEqual(["govt_assignments.locality_id"]);
  });

  it("guards the four locality_id columns the writers fill today", () => {
    expect(REQUIRED_COLUMNS.map((c) => `${c.table}.${c.column}`)).toEqual(
      expect.arrayContaining([
        "pets.locality_id",
        "welfare_reports.locality_id",
        "cases.locality_id",
        "govt_assignments.locality_id",
      ]),
    );
  });
});

describe("findMissingRequiredColumns (local database)", () => {
  it("finds every required column in the local schema", async () => {
    expect(await findMissingRequiredColumns(db)).toEqual([]);
  });
});

// Fence: every top-level key `export_subject_data`'s CURRENT definition builds
// into its `jsonb_build_object` must have a matching entry in
// SUBJECT_RIGHTS_SECTION_LABELS. Parses the SQL directly rather than
// hand-copying the key list — a table added to the RPC and forgotten here
// fails THIS test instead of quietly falling back to "Otros datos" forever
// (or, before PO decision 13A, showing its raw snake_case name to a citizen).
//
// Migrations are forward-only and immutable, so the CURRENT definition is
// whichever `CREATE OR REPLACE FUNCTION public.export_subject_data` sits in
// the highest-numbered migration file — found by globbing `db/migrations`
// rather than hardcoding a filename, so a future redefinition is picked up
// automatically instead of silently parsing a stale, superseded body.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SUBJECT_RIGHTS_SECTION_LABELS } from "../subject-rights-sections.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "db/migrations");
const EXPORT_FUNCTION_SIGNATURE = "CREATE OR REPLACE FUNCTION public.export_subject_data";

interface MigrationCandidate {
  file: string;
  number: number;
}

/** The numeric prefix every migration file is named with, e.g. "0245" -> 245. */
function migrationNumber(file: string): number | null {
  const match = file.match(/^(\d+)_/);
  return match ? Number(match[1]) : null;
}

/**
 * The highest-numbered migration file that (re)defines `export_subject_data`.
 * Migrations are forward-only, so the highest number among matches IS the
 * function's current body — no need to also check for a later DROP, since
 * this project never drops the RPC without replacing it in the same sweep.
 */
function latestExportSubjectDataMigration(): MigrationCandidate {
  const candidates = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((file) => ({ file, number: migrationNumber(file) }))
    .filter((c): c is MigrationCandidate => {
      if (c.number === null) return false;
      const sql = readFileSync(path.join(MIGRATIONS_DIR, c.file), "utf8");
      return sql.includes(EXPORT_FUNCTION_SIGNATURE);
    })
    .sort((a, b) => b.number - a.number);

  if (candidates.length === 0) {
    throw new Error(
      `No migration under db/migrations defines ${EXPORT_FUNCTION_SIGNATURE} — has it been renamed or dropped?`,
    );
  }
  return candidates[0];
}

const LATEST_MIGRATION = latestExportSubjectDataMigration();
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, LATEST_MIGRATION.file);

/** Every `'key', ` literal that opens a jsonb_build_object entry in the export function. */
function exportKeysFromMigration(): string[] {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  // Bounded to the jsonb_build_object CALL ITSELF (`SELECT jsonb_build_object(`
  // … `) INTO result;`), not the whole function — the function also contains
  // an audit INSERT with its own `jsonb_build_object('norma', …)` and a bare
  // string VALUE ('subject_data_exported') that happens to sit at the same
  // 4-space indent and would otherwise false-match as a 25th "key".
  const start = sql.indexOf("SELECT jsonb_build_object(");
  const end = sql.indexOf(") INTO result;", start);
  if (start === -1 || end === -1) {
    throw new Error(
      `export_subject_data's jsonb_build_object call not found in ${LATEST_MIGRATION.file} — has its shape changed?`,
    );
  }
  const body = sql.slice(start, end);

  // Each entry opens as `    'key_name', ` at the start of a line (4-space
  // indent, per this file's own formatting) — matches every key this
  // function's jsonb_build_object builds, and nothing inside a nested
  // sub-select (those are indented further).
  const matches = [...body.matchAll(/^ {4}'([a-z_]+)',/gm)];
  const keys = matches.map((m) => m[1]);
  if (keys.length === 0) {
    throw new Error("No jsonb_build_object keys matched — the regex or migration format changed.");
  }
  return keys;
}

describe(`SUBJECT_RIGHTS_SECTION_LABELS parity with export_subject_data (${LATEST_MIGRATION.file})`, () => {
  it("has a label entry for every key the RPC actually returns", () => {
    const sqlKeys = exportKeysFromMigration();
    const missing = sqlKeys.filter((k) => !(k in SUBJECT_RIGHTS_SECTION_LABELS));

    expect(missing, "keys returned by the RPC with no SUBJECT_RIGHTS_SECTION_LABELS entry").toEqual(
      [],
    );
  });

  it("declares no label for a key the RPC does not return", () => {
    // Catches the opposite drift: a key renamed or removed in the SQL whose
    // stale label entry is now dead weight (or worse, a leftover hidden rule
    // that no longer applies to anything).
    const sqlKeys = new Set(exportKeysFromMigration());
    const stale = Object.keys(SUBJECT_RIGHTS_SECTION_LABELS).filter((k) => !sqlKeys.has(k));

    expect(stale, "SUBJECT_RIGHTS_SECTION_LABELS entries with no matching RPC key").toEqual([]);
  });

  it("picked the highest-numbered migration that (re)defines the function", () => {
    // Independent re-check: no migration numbered ABOVE the one this test
    // picked may also define the function — if one did, that one (not
    // MIGRATION_PATH) would be the current body, and this test would have
    // silently parsed a superseded definition.
    const higherFileRedefinesIt = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .some((f) => {
        const n = migrationNumber(f);
        if (n === null || n <= LATEST_MIGRATION.number) return false;
        return readFileSync(path.join(MIGRATIONS_DIR, f), "utf8").includes(
          EXPORT_FUNCTION_SIGNATURE,
        );
      });

    expect(higherFileRedefinesIt).toBe(false);
  });
});

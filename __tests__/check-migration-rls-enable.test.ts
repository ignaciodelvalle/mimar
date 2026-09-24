/**
 * Unit tests for scripts/check-migration-rls-enable.ts (A02-7, T3-F1) — a
 * migration that creates a public table must enable RLS on it in the same file.
 * Pure fixture tests plus one run over the real db/migrations tree, so both the
 * scanner's logic and the frozen allowlist are pinned.
 */

import { describe, expect, it } from "vitest";

import {
  HISTORICAL_OFFENDERS,
  MIN_CREATE_TABLES_SEEN,
  createdPublicTables,
  evaluate,
  readMigrations,
  scanMigration,
} from "@/scripts/check-migration-rls-enable";

describe("scanMigration — one file", () => {
  it("flags a public table created without ENABLE ROW LEVEL SECURITY (the 0124 shape)", () => {
    const hits = scanMigration(
      "9999_x.sql",
      "CREATE TABLE IF NOT EXISTS notification_dead_letter (\n  id uuid primary key\n);",
    );
    expect(hits).toEqual([{ file: "9999_x.sql", table: "notification_dead_letter", line: 1 }]);
  });

  it("passes when the same file enables RLS, in any spelling of the name", () => {
    for (const enable of [
      "ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;",
      'alter table "public"."t" enable row level security;',
      "ALTER TABLE IF EXISTS ONLY t ENABLE ROW LEVEL SECURITY;",
    ]) {
      expect(
        scanMigration("f.sql", `create table if not exists "public"."t" (id int);\n${enable}`),
      ).toEqual([]);
    }
  });

  it("is per table, not per file: enabling one of two tables still flags the other", () => {
    const hits = scanMigration(
      "f.sql",
      "CREATE TABLE a (id int);\nCREATE TABLE b (id int);\nALTER TABLE a ENABLE ROW LEVEL SECURITY;",
    );
    expect(hits.map((h) => h.table)).toEqual(["b"]);
  });

  it("does not accept a commented-out ENABLE", () => {
    const sql =
      "CREATE TABLE t (id int);\n-- ALTER TABLE t ENABLE ROW LEVEL SECURITY;\n/* ALTER TABLE t ENABLE ROW LEVEL SECURITY; */";
    expect(scanMigration("f.sql", sql).map((h) => h.table)).toEqual(["t"]);
  });

  it("ignores CREATE TABLE in comments, TEMP tables and other schemas", () => {
    const sql = [
      "-- CREATE TABLE IF NOT EXISTS; DROP POLICY IF EXISTS before each CREATE POLICY.",
      "CREATE TEMP TABLE _probe (id int);",
      "CREATE TABLE IF NOT EXISTS ref.via_aplicacion (id int);",
      "CREATE TABLE pii.subject (id int);",
    ].join("\n");
    expect(createdPublicTables(sql)).toEqual([]);
  });

  it("does not let RLS on another schema's same-named table count", () => {
    const sql = "CREATE TABLE t (id int);\nALTER TABLE pii.t ENABLE ROW LEVEL SECURITY;";
    expect(scanMigration("f.sql", sql).map((h) => h.table)).toEqual(["t"]);
  });
});

describe("evaluate — allowlist is exact", () => {
  const files = [{ file: "0001_a.sql", sql: "CREATE TABLE a (id int);" }];

  it("an allowlisted hit is not a violation", () => {
    expect(evaluate(files, { "0001_a.sql": ["a"] })).toEqual({
      violations: [],
      stale: [],
      tablesSeen: 1,
    });
  });

  it("an allowlist entry with no matching hit is stale", () => {
    expect(evaluate(files, { "0001_a.sql": ["a", "ghost"] }).stale).toEqual(["0001_a.sql:ghost"]);
  });

  it("the allowlist is keyed by FILE: the same table in a new migration is a violation", () => {
    const more = [...files, { file: "0002_b.sql", sql: "CREATE TABLE a (id int);" }];
    expect(evaluate(more, { "0001_a.sql": ["a"] }).violations.map((v) => v.file)).toEqual([
      "0002_b.sql",
    ]);
  });
});

describe("the real db/migrations tree", () => {
  const verdict = evaluate(readMigrations());

  it("has no migration creating a public table without RLS beyond the frozen historical ones", () => {
    expect(verdict.violations).toEqual([]);
    expect(verdict.stale).toEqual([]);
  });

  it("is not vacuous: the scan sees the floor of public CREATE TABLE statements", () => {
    expect(verdict.tablesSeen).toBeGreaterThanOrEqual(MIN_CREATE_TABLES_SEEN);
  });

  it("the allowlist names 0124's dead-letter table — the finding this fence exists for", () => {
    expect(HISTORICAL_OFFENDERS["0124_notifications_dedupe_key_and_dead_letter.sql"]).toEqual([
      "notification_dead_letter",
    ]);
  });
});

// Fence: the five tables that name a jurisdiction can reference an authority
// UNIT (localidades-por-id C3, migration 0255).
//
// govt_assignments, govt_business_rules, organization_coverage,
// service_offerings and alert_subscriptions gain a nullable
// `authority_unit_id`. NULL is the legacy name path; a set id is the unit path.
// Each row flips individually and the two are never OR'd, so a grant can move
// to its unit without widening anybody else's (design, "Scope, RLS, routing,
// rules"). Nothing writes or reads the column before stage D.
//
// Every reference is ON DELETE RESTRICT — a unit is never deleted anyway
// (0253 trigger), and a grant must never lose its scope in silence.

import { getTableColumns, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  alertSubscriptions,
  db,
  govtAssignments,
  govtBusinessRules,
  organizationCoverage,
  serviceOfferings,
} from "@/db";

const TABLES = [
  "alert_subscriptions",
  "govt_assignments",
  "govt_business_rules",
  "organization_coverage",
  "service_offerings",
] as const;

describe("authority_unit_id references (C3)", () => {
  it("each table has a nullable uuid authority_unit_id", async () => {
    const rows = (await db.execute(sql`
      select c.relname as tbl, t.typname as type, a.attnotnull as not_null
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_type t on t.oid = a.atttypid
       where n.nspname = 'public' and a.attname = 'authority_unit_id'
         and not a.attisdropped and c.relkind = 'r'
       order by c.relname
    `)) as unknown as Array<{ tbl: string; type: string; not_null: boolean }>;
    expect(rows).toEqual(TABLES.map((tbl) => ({ tbl, type: "uuid", not_null: false })));
  });

  it("each reference is ON DELETE RESTRICT to authority_units", async () => {
    const rows = (await db.execute(sql`
      select c.conrelid::regclass::text as tbl, c.confdeltype as on_delete
        from pg_catalog.pg_constraint c
        join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
       where c.contype = 'f' and c.confrelid = 'public.authority_units'::regclass
         and a.attname = 'authority_unit_id'
       order by 1
    `)) as unknown as Array<{ tbl: string; on_delete: string }>;
    expect(rows).toEqual(TABLES.map((tbl) => ({ tbl, on_delete: "r" })));
  });

  it("each table is indexed on the unit it references", async () => {
    const rows = (await db.execute(sql`
      select tablename as tbl from pg_catalog.pg_indexes
       where schemaname = 'public' and indexdef like '%(authority_unit_id%'
       order by 1
    `)) as unknown as Array<{ tbl: string }>;
    expect([...new Set(rows.map((r) => r.tbl))]).toEqual([...TABLES]);
  });

  it("db/schema.ts declares the column on every table", () => {
    for (const table of [
      alertSubscriptions,
      govtAssignments,
      govtBusinessRules,
      organizationCoverage,
      serviceOfferings,
    ]) {
      expect(getTableColumns(table)).toHaveProperty("authorityUnitId");
    }
  });
});

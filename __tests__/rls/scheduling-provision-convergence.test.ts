// RLS — the scheduling tables after migration 0290: service_offerings joins
// the aal2 house rule, and a provisioned database lands the same scheduling
// policies as a migrated one.
//
// WHAT THIS DEFENDS
// -----------------
// 1. service_offerings carried the one scheduling org-member branch without
//    the restrictive `caller_meets_institutional_aal()` policy (0288 left it as
//    residual). Its 0279 column grant does not survive deploy-provision's
//    re-grant, so on a provisioned database that branch handed an aal1
//    institutional member whole rows. Every deny below is paired with a
//    positive control on the same rows.
// 2. db/scheduling_rls.sql is applied by scripts/deploy-provision.ts AFTER
//    the migration replay. Until 0290 it put a bare auth.uid() back on four
//    policies 0137 had wrapped (the "0137 drift"). The convergence test
//    applies the whole file over the migrated catalog, inside a transaction
//    that always rolls back, and asserts that no scheduling policy, RLS flag
//    or grant moves — whatever the next drift is, it fails here.
//
// PRE-FLIGHT: local Supabase stack with 0290 applied, .env.local loaded.

import { readFileSync } from "node:fs";

import { inArray } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, profiles } from "@/db";
import {
  type SchedulingWorld,
  buildSchedulingWorld,
  teardownSchedulingWorld,
  visibleKeys,
} from "../_helpers/scheduling-rls-fixtures";
import { addMembership, makeProfile } from "../_helpers/visit-fixtures";

const MIGRATION = "db/migrations/0290_scheduling_provision_convergence.sql";
const MIRROR = "db/scheduling_rls.sql";
const TABLES = ["appointments", "service_offerings", "service_schedule_rules", "time_slots"];

let world: SchedulingWorld;
/** Active institutional-account member of orgA. */
let instMember: string;
let govt: string;

beforeAll(async () => {
  world = await buildSchedulingWorld("RLS90");
  instMember = await makeProfile(world.fx, "RLS90-instMember");
  govt = await makeProfile(world.fx, "RLS90-govt");
  await db
    .update(profiles)
    .set({ accountType: "institutional" })
    .where(inArray(profiles.id, [instMember, govt]));
  await db
    .update(profiles)
    .set({ role: "govt" })
    .where(inArray(profiles.id, [govt]));
  await db
    .update(profiles)
    .set({ role: "vet" })
    .where(inArray(profiles.id, [world.users.provider]));
  await addMembership(world.orgA, instMember);
});

afterAll(async () => {
  await teardownSchedulingWorld(world);
});

describe("service_offerings — institutional sessions require aal2 (0290)", () => {
  it("an institutional org member reads none at aal1 and its org's offering at aal2", async () => {
    expect(
      await visibleKeys(world, "service_offerings", "authenticated", instMember, "aal1"),
    ).toEqual([]);
    expect(await visibleKeys(world, "service_offerings", "authenticated", instMember)).toEqual([]);
    expect(
      await visibleKeys(world, "service_offerings", "authenticated", instMember, "aal2"),
    ).toEqual(["org"]);
  });

  it("personal accounts at aal1 read what they read before", async () => {
    const read = (userId: string) =>
      visibleKeys(world, "service_offerings", "authenticated", userId, "aal1");
    expect(await read(world.users.member)).toEqual(["org"]);
    expect(await read(world.users.provider)).toEqual(["provider"]);
    expect(await read(world.users.otherMember)).toEqual(["other"]);
    expect(await read(world.users.owner)).toEqual([]);
    expect(await read(world.users.leftMember)).toEqual([]);
  });

  it("a govt principal with no scheduling branch reads none at either level", async () => {
    for (const aal of ["aal1", "aal2"] as const) {
      expect(await visibleKeys(world, "service_offerings", "authenticated", govt, aal)).toEqual([]);
    }
  });

  it("the provider vet's sub-selects through service_offerings still resolve at aal1", async () => {
    for (const table of ["appointments", "service_schedule_rules", "time_slots"] as const) {
      expect(
        await visibleKeys(world, table, "authenticated", world.users.provider, "aal1"),
      ).toEqual(["provider"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Provision convergence — over a dedicated connection, one transaction that
// always rolls back (the local database is shared by every worker).
// ---------------------------------------------------------------------------
const client = postgres(
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  { max: 1, onnotice: () => {} },
);
afterAll(() => client.end({ timeout: 5 }));

class Rollback extends Error {}

type Snapshot = { policies: unknown[]; tables: unknown[]; columns: unknown[] };

async function snapshot(tx: postgres.TransactionSql): Promise<Snapshot> {
  const policies = await tx`
    select tablename::text, policyname::text, permissive, cmd, roles::text[] as roles,
           coalesce(qual, '') as qual, coalesce(with_check, '') as with_check
      from pg_policies
     where schemaname = 'public' and tablename = any(${TABLES})
     order by 1, 2`;
  const tables = await tx`
    select c.relname::text, c.relrowsecurity, c.relforcerowsecurity,
           (select coalesce(array_agg(a::text order by a::text), '{}')
              from unnest(c.relacl) a) as acl
      from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relname = any(${TABLES})
     order by 1`;
  const columns = await tx`
    select c.relname::text, a.attname::text,
           (select coalesce(array_agg(x::text order by x::text), '{}')
              from unnest(a.attacl) x) as acl
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
     where c.relnamespace = 'public'::regnamespace and c.relname = any(${TABLES})
       and a.attnum > 0 and not a.attisdropped
     order by 1, 2`;
  return { policies: [...policies], tables: [...tables], columns: [...columns] };
}

/**
 * Apply db/scheduling_rls.sql over the migrated catalog and return the
 * catalog before and after. The four tables are locked NOWAIT up front, so
 * this transaction never waits while holding a lock (no deadlock with a
 * concurrent worker); a busy table is retried, never waited on.
 */
async function applyMirrorAndRollBack(): Promise<{ before: Snapshot; after: Snapshot }> {
  const mirror = readFileSync(MIRROR, "utf8");
  for (let attempt = 0; ; attempt++) {
    let result: { before: Snapshot; after: Snapshot } | undefined;
    try {
      await client.begin(async (tx) => {
        await tx.unsafe(
          `lock table ${TABLES.map((t) => `public.${t}`).join(", ")} in access exclusive mode nowait`,
        );
        const before = await snapshot(tx);
        await tx.unsafe(mirror).simple();
        const after = await snapshot(tx);
        result = { before, after };
        throw new Rollback();
      });
    } catch (err) {
      if (err instanceof Rollback && result) return result;
      const code = (err as { code?: string }).code;
      if (code === "55P03" && attempt < 100) {
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
        continue;
      }
      throw err;
    }
  }
}

describe("provision convergence (0290)", () => {
  it("applying db/scheduling_rls.sql over the migrated catalog moves nothing", async () => {
    const { before, after } = await applyMirrorAndRollBack();
    // Sanity: the snapshot really saw the scheduling policies.
    expect(before.policies.length).toBeGreaterThanOrEqual(13);
    expect(after.policies).toEqual(before.policies);
    expect(after.tables).toEqual(before.tables);
    expect(after.columns).toEqual(before.columns);
  });

  it("no scheduling policy in the migrated catalog calls auth.uid() unwrapped", async () => {
    const rows = await client<{ policy: string }[]>`
      select tablename || ': ' || policyname as policy
        from pg_policies
       where schemaname = 'public' and tablename = any(${TABLES})
         and replace(coalesce(qual, '') || coalesce(with_check, ''),
                     'SELECT auth.uid() AS uid', '') like '%auth.uid()%'`;
    expect(rows.map((r) => r.policy)).toEqual([]);
  });

  it("db/scheduling_rls.sql carries every 0290 block byte-identical", () => {
    const migration = readFileSync(MIGRATION, "utf8");
    const mirror = readFileSync(MIRROR, "utf8");
    const blocks = [
      ...migration.matchAll(
        /-- >>> scheduling_rls\.sql mirror: .+\n([\s\S]*?)-- <<< scheduling_rls\.sql mirror/g,
      ),
    ].map((m) => m[1]);
    expect(blocks).toHaveLength(5);
    for (const block of blocks) expect(mirror).toContain(block);
  });

  it("db/scheduling_rls.sql has no bare auth.uid() left", () => {
    const mirror = readFileSync(MIRROR, "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(mirror.replaceAll("(select auth.uid())", "")).not.toContain("auth.uid()");
  });
});

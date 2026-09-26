// public.govt_scope(user) — what a govt user's ACTIVE grants cover
// (localidades-por-id D1, migration 0257).
//
// One grant, one path. A grant with authority_unit_id NULL comes back as its
// name pair (source 'legacy'), untouched, so every consumer reads it with the
// name semantics it always had: identical on both paths, nothing widened. A
// grant on a provincial unit is the whole province (source 'province'). A
// grant on any other unit expands to the unit's ACTIVE member localities
// (source 'locality') — by catalogue id, so a homonym in another partido or
// province is never among them. A revoked grant covers nothing.
//
// Everything runs in a transaction that is always rolled back (shared DB).

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function inRolledBackTx(body: (tx: Tx) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await body(tx);
      tx.rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof TransactionRollbackError)) throw e;
    });
}

async function one<T>(tx: Tx, query: ReturnType<typeof sql>): Promise<T> {
  const rows = (await tx.execute(query)) as unknown as T[];
  expect(rows.length).toBeGreaterThan(0);
  return rows[0] as T;
}

async function govtUser(tx: Tx): Promise<string> {
  return (
    await one<{ id: string }>(
      tx,
      sql`select id::text as id from public.profiles
           where role = 'govt'::user_role and account_type = 'institutional'
             and deactivated_at is null and deleted_at is null
           order by created_at limit 1`,
    )
  ).id;
}

async function localityId(tx: Tx, indecId: string): Promise<string> {
  return (
    await one<{ id: string }>(
      tx,
      sql`select id::text as id from public.ar_localities where indec_id = ${indecId} and removed_at is null`,
    )
  ).id;
}

async function municipalUnitOf(tx: Tx, locality: string): Promise<string> {
  return (
    await one<{ unit_id: string }>(
      tx,
      sql`select unit_id::text as unit_id from public.authority_unit_localities
           where locality_id = ${locality}::uuid and level = 'municipal' and valid_to is null`,
    )
  ).unit_id;
}

async function provincialUnit(tx: Tx, code: string): Promise<string> {
  return (
    await one<{ id: string }>(
      tx,
      sql`select id::text as id from public.authority_units where province_code = ${code} and kind = 'provincia'`,
    )
  ).id;
}

async function grant(
  tx: Tx,
  user: string,
  province: string,
  locality: string,
  unitId: string | null,
  revoked = false,
): Promise<string> {
  return (
    await one<{ id: string }>(
      tx,
      sql`insert into public.govt_assignments
            (user_id, jurisdiction_province, jurisdiction_locality, authority_unit_id, revoked_at)
          values (${user}::uuid, ${province}, ${locality}, ${unitId}::uuid,
                  ${revoked ? sql`now()` : sql`null`})
          returning id::text as id`,
    )
  ).id;
}

type ScopeRow = {
  assignment_id: string;
  source: string;
  province_code: string | null;
  locality_id: string | null;
  jurisdiction_province: string | null;
  jurisdiction_locality: string | null;
};

async function scopeOf(tx: Tx, user: string, assignments: string[]): Promise<ScopeRow[]> {
  const rows = (await tx.execute(sql`
    select assignment_id::text as assignment_id, source, province_code,
           locality_id::text as locality_id, jurisdiction_province, jurisdiction_locality
      from public.govt_scope(${user}::uuid)
  `)) as unknown as ScopeRow[];
  return rows.filter((r) => assignments.includes(r.assignment_id));
}

const MECHITA_ALBERTI = "06021030";
const MECHITA_BRAGADO = "06112080";
const VILLA_MARIA_BA = "06021060"; // partido Alberti
const VILLA_MARIA_CBA = "14042170";

describe("public.govt_scope", () => {
  it("a legacy grant comes back as its name pair, and only that", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await govtUser(tx);
      const g = await grant(tx, user, "Mendoza", "Scope Fence Legacy", null);
      expect(await scopeOf(tx, user, [g])).toEqual([
        {
          assignment_id: g,
          source: "legacy",
          province_code: "AR-M",
          locality_id: null,
          jurisdiction_province: "Mendoza",
          jurisdiction_locality: "Scope Fence Legacy",
        },
      ]);
    });
  });

  it("a municipal unit grant expands to its active member localities by id, never a homonym", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await govtUser(tx);
      const mechitaAlberti = await localityId(tx, MECHITA_ALBERTI);
      const villaMariaBa = await localityId(tx, VILLA_MARIA_BA);
      const alberti = await municipalUnitOf(tx, mechitaAlberti);
      const g = await grant(tx, user, "Buenos Aires", "Scope Fence Alberti", alberti);

      const rows = await scopeOf(tx, user, [g]);
      expect(new Set(rows.map((r) => r.source))).toEqual(new Set(["locality"]));
      const ids = rows.map((r) => r.locality_id);
      expect(ids).toContain(mechitaAlberti);
      expect(ids).toContain(villaMariaBa);
      expect(ids).not.toContain(await localityId(tx, MECHITA_BRAGADO));
      expect(ids).not.toContain(await localityId(tx, VILLA_MARIA_CBA));
      expect(
        rows.every((r) => r.province_code === "AR-B" && r.jurisdiction_locality === null),
      ).toBe(true);

      // A membership closed today is no longer covered.
      await tx.execute(sql`
        update public.authority_unit_localities set valid_to = now(), ended_by = ${user}::uuid
         where unit_id = ${alberti}::uuid and locality_id = ${villaMariaBa}::uuid and valid_to is null
      `);
      const after = (await scopeOf(tx, user, [g])).map((r) => r.locality_id);
      expect(after).toContain(mechitaAlberti);
      expect(after).not.toContain(villaMariaBa);
    });
  });

  it("a provincial unit grant is the whole province, with no locality", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await govtUser(tx);
      const caba = await provincialUnit(tx, "AR-C");
      const g = await grant(tx, user, "CABA", "Scope Fence Whole City", caba);
      expect(await scopeOf(tx, user, [g])).toEqual([
        {
          assignment_id: g,
          source: "province",
          province_code: "AR-C",
          locality_id: null,
          jurisdiction_province: null,
          jurisdiction_locality: null,
        },
      ]);
    });
  });

  it("a revoked grant covers nothing, on either path", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await govtUser(tx);
      const alberti = await municipalUnitOf(tx, await localityId(tx, MECHITA_ALBERTI));
      const legacy = await grant(tx, user, "Mendoza", "Scope Fence Revoked", null, true);
      const unit = await grant(tx, user, "Buenos Aires", "Scope Fence Revoked Unit", alberti, true);
      expect(await scopeOf(tx, user, [legacy, unit])).toEqual([]);
    });
  });
});

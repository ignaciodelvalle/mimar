// The place parity sweep (localidades-por-id D7): the flip gate for the
// `scope` consumer.
//
// For every govt user with an active grant, the sweep asks the name path and
// the id path the same question — which pets, cases and welfare reports does
// this user see? — and classifies every row where they disagree
// (lib/place/shadow.ts). The gate passes only with zero `other` and zero
// `legacy_grant`. A user who holds only legacy grants can never disagree:
// both paths render the same name pair.
//
// Everything runs in a transaction that is always rolled back.

import { randomUUID } from "node:crypto";

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db, govtAssignments, pets, profiles } from "@/db";
import { sweepScopeParity } from "@/lib/place/parity-sweep";

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

async function first<T>(tx: Tx, query: ReturnType<typeof sql>): Promise<T> {
  const rows = (await tx.execute(query)) as unknown as T[];
  expect(rows.length).toBeGreaterThan(0);
  return rows[0] as T;
}

async function localityId(tx: Tx, indecId: string): Promise<string> {
  return (
    await first<{ id: string }>(
      tx,
      sql`select id::text as id from public.ar_localities where indec_id = ${indecId} and removed_at is null`,
    )
  ).id;
}

async function draftMunicipalUnitOf(tx: Tx, locality: string): Promise<string> {
  return (
    await first<{ unit_id: string }>(
      tx,
      sql`select unit_id::text as unit_id from public.authority_unit_localities
           where locality_id = ${locality}::uuid and level = 'municipal' and valid_to is null`,
    )
  ).unit_id;
}

async function govt(tx: Tx, grant: { locality: string; unitId: string | null }): Promise<string> {
  const id = randomUUID();
  await tx
    .insert(profiles)
    .values({ id, displayName: "D7 sweep probe", role: "govt", accountType: "institutional" });
  await tx.insert(govtAssignments).values({
    userId: id,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: grant.locality,
    authorityUnitId: grant.unitId,
  });
  return id;
}

async function pet(tx: Tx, localityIdOrNull: string | null, locality = "Mechita"): Promise<string> {
  const [row] = await tx
    .insert(pets)
    .values({
      publicToken: `DIM-D7${randomUUID().slice(0, 2).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      name: "D7 sweep pet",
      species: "dog",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: locality,
      localityId: localityIdOrNull,
    })
    .returning({ id: pets.id });
  return row.id;
}

/**
 * Stage D review W1: only a CONFIRMED unit governs anything (govt_scope,
 * routing, rules, the confirm flow). The seed leaves every unit a draft, so a
 * fixture confirms the one it uses — inside the rolled-back transaction.
 */
async function confirmed(tx: Tx, unitId: string): Promise<string> {
  await tx.execute(sql`
    update public.authority_units
       set status = 'confirmed', confirmed_at = coalesce(confirmed_at, now())
     where id = ${unitId}::uuid
  `);
  return unitId;
}

async function municipalUnitOf(tx: Tx, locality: string): Promise<string> {
  return confirmed(tx, await draftMunicipalUnitOf(tx, locality));
}

const MECHITA_ALBERTI = "06021030";
const MECHITA_BRAGADO = "06112080";
const VILLA_MARIA_BA = "06021060";

describe("sweepScopeParity", () => {
  it("classifies a unit grant's disagreements and passes the gate on accepted kinds only", async () => {
    await inRolledBackTx(async (tx) => {
      const alberti = await localityId(tx, MECHITA_ALBERTI);
      const bragado = await localityId(tx, MECHITA_BRAGADO);
      // Holds Alberti's unit, grant named "Mechita" (as the confirm flow leaves it).
      const user = await govt(tx, {
        locality: "Mechita",
        unitId: await municipalUnitOf(tx, alberti),
      });
      const own = await pet(tx, alberti);
      const homonym = await pet(tx, bragado);
      const unresolved = await pet(tx, null);

      const report = await sweepScopeParity(tx, { userIds: [user] });
      const kinds = new Map(report.rows.map((r) => [r.subjectId, r.kind]));
      expect(kinds.has(own)).toBe(false); // both paths see it
      expect(kinds.get(homonym)).toBe("homonym_split");
      expect(kinds.get(unresolved)).toBe("unresolved_to_province");
      expect(report.counts.homonym_split).toBeGreaterThanOrEqual(1);
      expect(report.verdict.pass).toBe(true);
    });
  });

  it("a user with only legacy grants has no disagreement at all", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await govt(tx, { locality: "Mechita", unitId: null });
      await pet(tx, await localityId(tx, MECHITA_BRAGADO));
      await pet(tx, null);
      const report = await sweepScopeParity(tx, { userIds: [user] });
      expect(report.rows).toEqual([]);
      expect(report.usersSwept).toBe(1);
      expect(report.verdict).toEqual({ pass: true, blocking: {} });
    });
  });

  it("a resolved row a unit grant drops without a homonym is OTHER and fails the gate", async () => {
    await inRolledBackTx(async (tx) => {
      // Villa María names ONE row inside Buenos Aires (its homonym is in
      // Córdoba), so a disagreement on it is not a homonym split.
      const villaMaria = await localityId(tx, VILLA_MARIA_BA);
      const user = await govt(tx, {
        locality: "Villa María",
        unitId: await municipalUnitOf(tx, villaMaria),
      });
      // The unit stops governing Villa María: the name path still sees the
      // pet, the id path no longer does, and no name explains it.
      await tx.execute(sql`
        update public.authority_unit_localities set valid_to = now(), ended_by = ${user}::uuid
         where locality_id = ${villaMaria}::uuid and level = 'municipal' and valid_to is null
      `);
      const dropped = await pet(tx, villaMaria, "Villa María");
      const report = await sweepScopeParity(tx, { userIds: [user] });
      expect(report.rows.find((r) => r.subjectId === dropped)?.kind).toBe("other");
      expect(report.verdict.pass).toBe(false);
      expect(report.verdict.blocking.other).toBeGreaterThanOrEqual(1);
    });
  });
});

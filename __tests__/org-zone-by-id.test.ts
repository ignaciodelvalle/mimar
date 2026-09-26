// Coverage zones keyed by catalogue row or unit (localidades-por-id D5,
// migration 0261).
//
// One organization may work in Mechita (partido Alberti) AND Mechita (partido
// Bragado): two zones with the same name, told apart by their catalogue ids.
// A zone is unique by what it names (row, unit, or — for unkeyed zones — the
// name pair, as before), and never names both a row and a unit.
//
// Rolled back (shared DB).

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db, organizations } from "@/db";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { OrgRepository } from "@/src/modules/organizations/infrastructure/org-repository";

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

async function localityId(tx: Tx, indecId: string): Promise<string> {
  const rows = (await tx.execute(
    sql`select id::text as id from public.ar_localities where indec_id = ${indecId} and removed_at is null`,
  )) as unknown as Array<{ id: string }>;
  return (rows[0] as { id: string }).id;
}

async function newOrg(tx: Tx): Promise<string> {
  const [row] = await tx
    .insert(organizations)
    .values({
      publicToken: generatePublicToken(),
      legalName: "D5 zones probe SRL",
      displayName: "D5 zones probe",
      orgType: "shelter",
      email: "d5-zones-probe@dim-test.local",
    })
    .returning({ id: organizations.id });
  return row.id;
}

async function rejects(tx: Tx, body: () => Promise<unknown>): Promise<boolean> {
  await tx.execute(sql`savepoint probe`);
  try {
    await body();
    await tx.execute(sql`release savepoint probe`);
    return false;
  } catch {
    await tx.execute(sql`rollback to savepoint probe`);
    return true;
  }
}

describe("coverage zones by catalogue id (0261)", () => {
  it("two homonymous localities are two zones; the same row twice is refused", async () => {
    await inRolledBackTx(async (tx) => {
      const repo = new OrgRepository();
      const org = await newOrg(tx);
      const alberti = await localityId(tx, "06021030");
      const bragado = await localityId(tx, "06112080");
      const zone = (id: string) => ({
        organizationId: org,
        province: "Buenos Aires",
        locality: "Mechita",
        localityId: id,
        placeMethod: "catalogue_id",
      });
      await repo.insertCoverage(zone(alberti), tx);
      await repo.insertCoverage(zone(bragado), tx);
      expect(await rejects(tx, () => repo.insertCoverage(zone(bragado), tx))).toBe(true);
    });
  });

  it("an unkeyed zone keeps the 0073 name rule, and a zone never names both a row and a unit", async () => {
    await inRolledBackTx(async (tx) => {
      const repo = new OrgRepository();
      const org = await newOrg(tx);
      const byName = { organizationId: org, province: "Buenos Aires", locality: "Mechita" };
      await repo.insertCoverage(byName, tx);
      expect(await rejects(tx, () => repo.insertCoverage(byName, tx))).toBe(true);
      const wide = { organizationId: org, province: "Buenos Aires", locality: null };
      await repo.insertCoverage(wide, tx);
      expect(await rejects(tx, () => repo.insertCoverage(wide, tx))).toBe(true);

      const unit = (
        (await tx.execute(
          sql`select id::text as id from public.authority_units where province_code = 'AR-B' and kind <> 'provincia' limit 1`,
        )) as unknown as Array<{ id: string }>
      )[0]?.id as string;
      const both = {
        organizationId: org,
        province: "Buenos Aires",
        locality: "Mechita",
        localityId: await localityId(tx, "06021030"),
        authorityUnitId: unit,
      };
      expect(await rejects(tx, () => repo.insertCoverage(both, tx))).toBe(true);
    });
  });
});

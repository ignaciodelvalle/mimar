// Lost-pet broadcast by catalogue id and unit (localidades-por-id D5, spec
// "org-coverage-and-lost-broadcast").
//
// On the id path an org whose coverage zone recorded Bragado's Mechita is not
// alerted for a dog lost in Alberti's Mechita; an org keyed to Alberti's
// (confirmed) unit is; an org whose zone recorded nothing keeps the name rule.
// An unresolved place still reaches the province — never zero orgs.
//
// The path is asked explicitly so the shared `coverage` flag is never touched;
// every fixture lives in a transaction that is always rolled back.

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db, organizationCoverage, organizations } from "@/db";
import { coveringOrgIds } from "@/lib/infra/lost-pet-broadcast";
import { generatePublicToken } from "@/lib/infra/publicToken";

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

/** The municipal unit of a locality, confirmed (drafts govern nothing). */
async function confirmedUnitOf(tx: Tx, locality: string): Promise<string> {
  const { unit_id } = await first<{ unit_id: string }>(
    tx,
    sql`select unit_id::text as unit_id from public.authority_unit_localities
         where locality_id = ${locality}::uuid and level = 'municipal' and valid_to is null`,
  );
  await tx.execute(sql`
    update public.authority_units
       set status = 'confirmed', confirmed_at = coalesce(confirmed_at, now())
     where id = ${unit_id}::uuid
  `);
  return unit_id;
}

async function org(
  tx: Tx,
  suffix: string,
  zone: { locality: string | null; localityId?: string | null; unitId?: string | null },
): Promise<string> {
  const [row] = await tx
    .insert(organizations)
    .values({
      publicToken: generatePublicToken(),
      legalName: `D5 probe ${suffix} SRL`,
      displayName: `D5 probe ${suffix}`,
      orgType: "shelter",
      email: `d5-probe-${suffix}@dim-test.local`,
      verified: true,
      status: "active",
    })
    .returning({ id: organizations.id });
  await tx.insert(organizationCoverage).values({
    organizationId: row.id,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: zone.locality,
    localityId: zone.localityId ?? null,
    authorityUnitId: zone.unitId ?? null,
  });
  return row.id;
}

const MECHITA_ALBERTI = "06021030";
const MECHITA_BRAGADO = "06112080";

describe("coveringOrgIds", () => {
  it("splits the Mechita homonym on the id path, and a unit zone reaches its localities", async () => {
    await inRolledBackTx(async (tx) => {
      const alberti = await localityId(tx, MECHITA_ALBERTI);
      const bragado = await localityId(tx, MECHITA_BRAGADO);
      const bragadoZone = await org(tx, "bragado-zone", {
        locality: "Mechita",
        localityId: bragado,
      });
      const nameOnly = await org(tx, "name-only", { locality: "Mechita" });
      const albertiUnit = await org(tx, "alberti-unit", {
        locality: "Alberti",
        unitId: await confirmedUnitOf(tx, alberti),
      });
      const place = { province: "Buenos Aires", locality: "Mechita", localityId: alberti };

      const byName = await coveringOrgIds(tx, place, "name");
      expect(byName).toContain(bragadoZone);
      expect(byName).toContain(nameOnly);
      expect(byName).not.toContain(albertiUnit);

      const byId = await coveringOrgIds(tx, place, "id");
      expect(byId).not.toContain(bragadoZone);
      expect(byId).toContain(nameOnly);
      expect(byId).toContain(albertiUnit);

      const inBragado = await coveringOrgIds(tx, { ...place, localityId: bragado }, "id");
      expect(inBragado).toContain(bragadoZone);
      expect(inBragado).not.toContain(albertiUnit);
    });
  });

  it("an unresolved place still alerts the province's orgs, never a municipal unit", async () => {
    await inRolledBackTx(async (tx) => {
      const alberti = await localityId(tx, MECHITA_ALBERTI);
      const wide = await org(tx, "province-wide", { locality: null });
      const albertiUnit = await org(tx, "alberti-unit-2", {
        locality: "Alberti",
        unitId: await confirmedUnitOf(tx, alberti),
      });
      const unresolved = { province: "Buenos Aires", locality: null, localityId: null };
      const byId = await coveringOrgIds(tx, unresolved, "id");
      expect(byId).toContain(wide);
      expect(byId).not.toContain(albertiUnit);
    });
  });
});

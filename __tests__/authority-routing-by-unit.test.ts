// Authority routing by unit (localidades-por-id D3, spec "authority-routing").
//
// On the id path a grant on an authority unit is paged when the unit governs
// the place (public.authority_units_for_place); a homonym's unit never is,
// and an unresolved place reaches only the provincial unit. A LEGACY grant
// (authority_unit_id NULL) is paged exactly as on the name path — the switch
// widens and narrows nothing for it.
//
// The path is asked explicitly (context.mode) so the shared `routing` flag is
// never touched, and the grants are read through a transaction that is
// always rolled back. The probed operator's own grants are revoked inside it,
// so nothing but the fixture decides who is paged.

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import { type ApprovalJurisdiction, govtAuthoritiesForPlace } from "@/lib/infra/approval-routing";

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

/** An active govt operator with every grant of their own revoked (in the tx). */
async function bareOperator(tx: Tx): Promise<string> {
  const { id } = await first<{ id: string }>(
    tx,
    sql`select id::text as id from public.profiles
         where role = 'govt'::user_role and account_type = 'institutional'
           and deactivated_at is null and deleted_at is null and is_system = false
         order by created_at limit 1`,
  );
  await tx.execute(sql`
    update public.govt_assignments set revoked_at = now()
     where user_id = ${id}::uuid and revoked_at is null
  `);
  return id;
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

async function draftProvincialUnit(tx: Tx, code: string): Promise<string> {
  return (
    await first<{ id: string }>(
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
): Promise<void> {
  await tx.execute(sql`
    insert into public.govt_assignments (user_id, jurisdiction_province, jurisdiction_locality, authority_unit_id)
    values (${user}::uuid, ${province}, ${locality}, ${unitId}::uuid)
  `);
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

async function provincialUnit(tx: Tx, code: string): Promise<string> {
  return confirmed(tx, await draftProvincialUnit(tx, code));
}

const MECHITA_ALBERTI = "06021030";
const MECHITA_BRAGADO = "06112080";
const VILLA_MARIA_BA = "06021060";
const VILLA_MARIA_CBA = "14042170";

async function paged(tx: Tx, place: ApprovalJurisdiction, mode: "name" | "id"): Promise<string[]> {
  return govtAuthoritiesForPlace(place, { mode, exec: tx, route: "routing_by_unit_fence" });
}

describe("routing on the id path", () => {
  it("a unit grant is paged for its own Mechita and never for the homonym's", async () => {
    await inRolledBackTx(async (tx) => {
      const op = await bareOperator(tx);
      const alberti = await localityId(tx, MECHITA_ALBERTI);
      const bragado = await localityId(tx, MECHITA_BRAGADO);
      await grant(tx, op, "Buenos Aires", "Mechita", await municipalUnitOf(tx, alberti));

      const at = (id: string) => ({
        province: "Buenos Aires",
        locality: "Mechita",
        localityId: id,
      });
      expect(await paged(tx, at(alberti), "id")).toContain(op);
      expect(await paged(tx, at(bragado), "id")).not.toContain(op);
      // The name path cannot tell them apart — the defect this change closes.
      expect(await paged(tx, at(bragado), "name")).toContain(op);
    });
  });

  it("a unit grant in Buenos Aires is never paged for Villa María, Córdoba", async () => {
    await inRolledBackTx(async (tx) => {
      const op = await bareOperator(tx);
      const vmBa = await localityId(tx, VILLA_MARIA_BA);
      await grant(tx, op, "Buenos Aires", "Villa María", await municipalUnitOf(tx, vmBa));
      const cordoba = {
        province: "Córdoba",
        locality: "Villa María",
        localityId: await localityId(tx, VILLA_MARIA_CBA),
      };
      expect(await paged(tx, cordoba, "id")).not.toContain(op);
      expect(
        await paged(tx, { ...cordoba, province: "Buenos Aires", localityId: vmBa }, "id"),
      ).toContain(op);
    });
  });

  it("an unresolved place reaches the provincial unit, never a municipal one", async () => {
    await inRolledBackTx(async (tx) => {
      const op = await bareOperator(tx);
      const alberti = await localityId(tx, MECHITA_ALBERTI);
      await grant(tx, op, "Buenos Aires", "Mechita", await municipalUnitOf(tx, alberti));
      const unresolved = { province: "Buenos Aires", locality: "Mechita", localityId: null };
      expect(await paged(tx, unresolved, "id")).not.toContain(op);

      await grant(tx, op, "Buenos Aires", "", await provincialUnit(tx, "AR-B"));
      expect(await paged(tx, unresolved, "id")).toContain(op);
    });
  });

  it("a legacy grant is paged identically on both paths", async () => {
    await inRolledBackTx(async (tx) => {
      const op = await bareOperator(tx);
      await grant(tx, op, "Buenos Aires", "Mechita", null);
      for (const indec of [MECHITA_ALBERTI, MECHITA_BRAGADO]) {
        const place = {
          province: "Buenos Aires",
          locality: "Mechita",
          localityId: await localityId(tx, indec),
        };
        const byName = (await paged(tx, place, "name")).includes(op);
        const byId = (await paged(tx, place, "id")).includes(op);
        expect(byName).toBe(true);
        expect(byId).toBe(byName);
      }
      const unresolved = { province: "Buenos Aires", locality: "Mechita", localityId: null };
      expect((await paged(tx, unresolved, "id")).includes(op)).toBe(
        (await paged(tx, unresolved, "name")).includes(op),
      );
    });
  });

  it("a caller that passes no locality id keeps the name path whatever the mode", async () => {
    await inRolledBackTx(async (tx) => {
      const op = await bareOperator(tx);
      const alberti = await localityId(tx, MECHITA_ALBERTI);
      await grant(tx, op, "Buenos Aires", "Mechita", await municipalUnitOf(tx, alberti));
      const unwired = { province: "Buenos Aires", locality: "Mechita" };
      expect(await paged(tx, unwired, "id")).toEqual(await paged(tx, unwired, "name"));
    });
  });
});

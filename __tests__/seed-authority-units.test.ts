// The authority-unit seed against the catalogue (localidades-por-id C2).
//
// The seed (scripts/seed-authority-units.ts) runs in db:bootstrap after the
// catalogue import, so the local database holds its result. These tests read
// that result, and exercise the seed itself inside a transaction that is
// ALWAYS rolled back: the database is shared, and a membership row is never
// deleted.
//
//   - CABA is ONE ciudad unit over every barrio (D1).
//   - Homonyms split by unit, within and across provinces (P1/P3).
//   - A re-run changes nothing, and never undoes a membership an admin moved.
//   - Outside Buenos Aires the unit is the official local government; the
//     seed-opened memberships of a superseded `departamento` draft are closed
//     only when nothing points at the unit (plan step 6).
//   - A grant holding part of a unit is listed for confirmation and its access
//     stays exactly as it was (D2).

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import {
  applyAuthorityUnitPlan,
  loadGrantCoverage,
  planFromDatabase,
} from "@/scripts/seed-authority-units";

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

type UnitRow = { seed_key: string | null; kind: string; unit_id: string };

async function activeUnitOf(tx: Tx | typeof db, indecId: string): Promise<UnitRow> {
  const rows = (await tx.execute(sql`
    select u.seed_key, u.kind, u.id::text as unit_id
      from public.ar_localities l
      join public.authority_unit_localities m
        on m.locality_id = l.id and m.valid_to is null and m.level = 'municipal'
      join public.authority_units u on u.id = m.unit_id
     where l.indec_id = ${indecId} and l.removed_at is null
  `)) as unknown as UnitRow[];
  expect(rows, `INDEC ${indecId} must sit in exactly one active unit`).toHaveLength(1);
  return rows[0] as UnitRow;
}

// Villa María, Buenos Aires (partido Alberti) and Villa María, Córdoba.
const VILLA_MARIA_BA = "06021060";
const VILLA_MARIA_CBA = "14042170";

describe("the seeded units", () => {
  it("CABA is one ciudad unit over every barrio, never a unit per barrio", async () => {
    const rows = (await db.execute(sql`
      select u.seed_key, u.kind, count(*)::int as barrios
        from public.ar_localities l
        join public.authority_unit_localities m
          on m.locality_id = l.id and m.valid_to is null and m.level = 'municipal'
        join public.authority_units u on u.id = m.unit_id
       where l.province_code = 'AR-C' and l.removed_at is null
         and l.source = 'caba_open_data'
       group by u.seed_key, u.kind
    `)) as unknown as Array<{ seed_key: string; kind: string; barrios: number }>;
    expect(rows).toEqual([{ seed_key: "ciudad:AR-C", kind: "ciudad", barrios: 48 }]);
  });

  it("homonyms split by unit, within and across provinces", async () => {
    const mechitas = (await db.execute(sql`
      select l.indec_id from public.ar_localities l
       where l.province_code = 'AR-B' and l.locality_name = 'Mechita'
         and l.removed_at is null and l.indec_id is not null
       order by l.indec_id
    `)) as unknown as Array<{ indec_id: string }>;
    expect(mechitas, "Mechita is in two partidos of Buenos Aires").toHaveLength(2);
    const [a, b] = await Promise.all(mechitas.map((m) => activeUnitOf(db, m.indec_id)));
    expect(a?.unit_id).not.toBe(b?.unit_id);

    const ba = await activeUnitOf(db, VILLA_MARIA_BA);
    const cba = await activeUnitOf(db, VILLA_MARIA_CBA);
    expect(ba).toMatchObject({ seed_key: "municipio:AR-B:06021", kind: "municipio" });
    expect(cba).toMatchObject({ seed_key: "gobierno_local:AR-X:140357", kind: "municipio" });
  });

  it("every seeded unit is a draft until an admin confirms it", async () => {
    const rows = (await db.execute(sql`
      select count(*)::int as n from public.authority_units
       where seed_key is not null and status <> 'draft' and confirmed_by is null
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(0);
  });
});

describe("the seed itself", () => {
  it("a second run changes nothing", async () => {
    await inRolledBackTx(async (tx) => {
      const plan = await planFromDatabase(tx);
      await applyAuthorityUnitPlan(tx, plan);
      expect(await applyAuthorityUnitPlan(tx, plan)).toMatchObject({
        unitsCreated: 0,
        membershipsOpened: 0,
        membershipsClosed: 0,
      });
    });
  });

  it("never undoes a membership an admin moved", async () => {
    await inRolledBackTx(async (tx) => {
      const before = await activeUnitOf(tx, VILLA_MARIA_BA);
      const [unit] = (await tx.execute(sql`
        insert into public.authority_units (kind, level, province_code, name)
        values ('municipio', 'municipal', 'AR-B', 'Unidad de prueba')
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      await tx.execute(sql`
        update public.authority_unit_localities m set valid_to = now()
          from public.ar_localities l
         where l.id = m.locality_id and l.indec_id = ${VILLA_MARIA_BA}
           and m.valid_to is null and m.level = 'municipal'
      `);
      await tx.execute(sql`
        insert into public.authority_unit_localities (unit_id, locality_id)
        select ${unit?.id}::uuid, l.id from public.ar_localities l where l.indec_id = ${VILLA_MARIA_BA}
      `);

      const result = await applyAuthorityUnitPlan(tx, await planFromDatabase(tx));
      const after = await activeUnitOf(tx, VILLA_MARIA_BA);
      expect(after.unit_id).toBe(unit?.id);
      expect(after.unit_id).not.toBe(before.unit_id);
      expect(result.keptElsewhere).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("superseded department units (plan step 6)", () => {
  /** Put Villa María (Córdoba) back in a seed-made `departamento` draft, as the first seed left it. */
  async function backInADepartment(tx: Tx, seedKey: string, addedBy: string | null) {
    const [unit] = (await tx.execute(sql`
      insert into public.authority_units (seed_key, kind, level, province_code, name, indec_department_code)
      values (${seedKey}, 'departamento', 'municipal', 'AR-X', 'General San Martín (prueba)', '14042')
      returning id::text as id
    `)) as unknown as Array<{ id: string }>;
    await tx.execute(sql`
      update public.authority_unit_localities m set valid_to = now()
        from public.ar_localities l
       where l.id = m.locality_id and l.indec_id = ${VILLA_MARIA_CBA}
         and m.valid_to is null and m.level = 'municipal'
    `);
    await tx.execute(sql`
      insert into public.authority_unit_localities (unit_id, locality_id, added_by)
      select ${unit?.id}::uuid, l.id, ${addedBy}::uuid
        from public.ar_localities l where l.indec_id = ${VILLA_MARIA_CBA} and l.removed_at is null
    `);
    return unit?.id as string;
  }

  it("a seed-opened membership of an unreferenced departamento draft moves to the local government", async () => {
    await inRolledBackTx(async (tx) => {
      const dept = await backInADepartment(tx, "departamento:AR-X:fence-free", null);
      const result = await applyAuthorityUnitPlan(tx, await planFromDatabase(tx));
      expect(result.membershipsClosed).toBeGreaterThanOrEqual(1);
      const after = await activeUnitOf(tx, VILLA_MARIA_CBA);
      expect(after).toMatchObject({ seed_key: "gobierno_local:AR-X:140357", kind: "municipio" });
      // The unit itself stays: units are never deleted.
      const [still] = (await tx.execute(sql`
        select count(*)::int as n from public.authority_units where id = ${dept}::uuid
      `)) as unknown as Array<{ n: number }>;
      expect(still?.n).toBe(1);
    });
  });

  it("a departamento something points at keeps its memberships, and is reported", async () => {
    await inRolledBackTx(async (tx) => {
      const dept = await backInADepartment(tx, "departamento:AR-X:fence-referenced", null);
      // A child unit is a reference like any grant or rule would be.
      await tx.execute(sql`
        insert into public.authority_units (kind, level, province_code, name, parent_unit_id)
        values ('comuna', 'municipal', 'AR-X', 'Hija de prueba', ${dept}::uuid)
      `);
      const result = await applyAuthorityUnitPlan(tx, await planFromDatabase(tx));
      expect((await activeUnitOf(tx, VILLA_MARIA_CBA)).unit_id).toBe(dept);
      expect(result.referencedSuperseded.filter((u) => u.unitId === dept)).toEqual([
        expect.objectContaining({
          unitId: dept,
          seedKey: "departamento:AR-X:fence-referenced",
          referencedBy: ["authority_units.parent_unit_id"],
          membershipsKept: 1,
        }),
      ]);
    });
  });

  it("a membership an admin placed in a departamento is never closed by the seed", async () => {
    await inRolledBackTx(async (tx) => {
      const [admin] = (await tx.execute(sql`
        select p.id::text as id from public.profiles p order by p.created_at limit 1
      `)) as unknown as Array<{ id: string }>;
      const dept = await backInADepartment(tx, "departamento:AR-X:fence-admin", admin?.id ?? null);
      await applyAuthorityUnitPlan(tx, await planFromDatabase(tx));
      expect((await activeUnitOf(tx, VILLA_MARIA_CBA)).unit_id).toBe(dept);
    });
  });

  // Step-6 review: the guard is `u.status = 'draft'`. A departamento an
  // authority CONFIRMED is its decision, not the seed's proposal — a reseed
  // that no longer proposes it must leave its memberships where they are.
  it("a CONFIRMED superseded departamento keeps its memberships through a reseed", async () => {
    await inRolledBackTx(async (tx) => {
      const dept = await backInADepartment(tx, "departamento:AR-X:fence-confirmed", null);
      await tx.execute(sql`
        update public.authority_units set status = 'confirmed', confirmed_at = now()
         where id = ${dept}::uuid
      `);
      const result = await applyAuthorityUnitPlan(tx, await planFromDatabase(tx));
      expect((await activeUnitOf(tx, VILLA_MARIA_CBA)).unit_id).toBe(dept);
      expect(result.referencedSuperseded.some((u) => u.unitId === dept)).toBe(false);
    });
  });
});

describe("the partial-grant report (D2)", () => {
  it("an operator holding all but one locality of a unit is listed, and keeps exactly that access", async () => {
    await inRolledBackTx(async (tx) => {
      const alberti = await activeUnitOf(tx, VILLA_MARIA_BA);
      const members = (await tx.execute(sql`
        select l.id::text as id, l.locality_name as name
          from public.authority_unit_localities m
          join public.ar_localities l on l.id = m.locality_id
         where m.unit_id = ${alberti.unit_id}::uuid and m.valid_to is null
         order by l.id
      `)) as unknown as Array<{ id: string; name: string }>;
      expect(members.length, "partido Alberti governs more than one locality").toBeGreaterThan(1);

      const [operator] = (await tx.execute(sql`
        select p.id::text as id from public.profiles p
         where not exists (select 1 from public.govt_assignments g where g.user_id = p.id)
         order by p.created_at
         limit 1
      `)) as unknown as Array<{ id: string }>;
      expect(operator, "the local database must have a profile with no grant").toBeDefined();
      const held = members.slice(1);
      for (const m of held) {
        await tx.execute(sql`
          insert into public.govt_assignments
            (user_id, jurisdiction_province, jurisdiction_locality, locality_id)
          values (${operator?.id}::uuid, 'Buenos Aires', ${m.name}, ${m.id}::uuid)
        `);
      }
      const grantsBefore = (await tx.execute(sql`
        select id::text as id, locality_id::text as locality_id, revoked_at
          from public.govt_assignments where user_id = ${operator?.id}::uuid order by id
      `)) as unknown as Array<Record<string, unknown>>;

      const report = await loadGrantCoverage(tx);
      const mine = report.partial.filter((p) => p.userId === operator?.id);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        unitId: alberti.unit_id,
        held: held.length,
        unitSize: members.length,
      });

      const grantsAfter = (await tx.execute(sql`
        select id::text as id, locality_id::text as locality_id, revoked_at
          from public.govt_assignments where user_id = ${operator?.id}::uuid order by id
      `)) as unknown as Array<Record<string, unknown>>;
      expect(grantsAfter).toEqual(grantsBefore);
    });
  });
});

// The partial-grant confirm flow (localidades-por-id D2 report → D2 writer;
// spec "Partial grants never auto-widen").
//
// A govt grant moves from its name pair to an authority unit only when a
// platform admin confirms it — this is the ONE writer of
// govt_assignments.authority_unit_id. The grants that move are the ones whose
// recorded catalogue row (0246 locality_id) is a member of the unit; a grant
// with no recorded row is never mapped by its name (P1). When the unit holds
// localities the grants do not, the confirmation must name every one of them:
// access stays at 8 of 9 until a person accepts the 9th. A whole-province
// grant maps to its provincial unit — for CABA the provincia AR-C unit, the
// one that also sees unresolved places, never the ciudad unit.
//
// Every fixture is written in a transaction that is always rolled back.

import { randomUUID } from "node:crypto";

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db, profiles } from "@/db";
import {
  confirmGrantUnit,
  listGrantCandidates,
  planGrantUnit,
} from "@/src/modules/organizations/application/authority-units/grant-unit";

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

async function admin(tx: Tx): Promise<string> {
  return (
    await first<{ id: string }>(
      tx,
      sql`select id::text as id from public.profiles
           where role = 'admin'::user_role and account_type = 'institutional'
             and deactivated_at is null and deleted_at is null
           order by created_at limit 1`,
    )
  ).id;
}

async function newGovt(tx: Tx): Promise<string> {
  const id = randomUUID();
  await tx.insert(profiles).values({
    id,
    displayName: "D2 confirm probe",
    role: "govt",
    accountType: "institutional",
  });
  return id;
}

async function locality(tx: Tx, indecId: string): Promise<{ id: string; name: string }> {
  return first<{ id: string; name: string }>(
    tx,
    sql`select id::text as id, locality_name as name from public.ar_localities
         where indec_id = ${indecId} and removed_at is null`,
  );
}

async function membersOf(tx: Tx, unitId: string): Promise<Array<{ id: string; name: string }>> {
  return (await tx.execute(sql`
    select l.id::text as id, l.locality_name as name
      from public.authority_unit_localities m
      join public.ar_localities l on l.id = m.locality_id
     where m.unit_id = ${unitId}::uuid and m.valid_to is null
     order by l.locality_name
  `)) as unknown as Array<{ id: string; name: string }>;
}

async function municipalUnitOf(tx: Tx, localityId: string): Promise<string> {
  return (
    await first<{ unit_id: string }>(
      tx,
      sql`select unit_id::text as unit_id from public.authority_unit_localities
           where locality_id = ${localityId}::uuid and level = 'municipal' and valid_to is null`,
    )
  ).unit_id;
}

async function unitOfKind(tx: Tx, code: string, kind: string): Promise<string> {
  return (
    await first<{ id: string }>(
      tx,
      sql`select id::text as id from public.authority_units
           where province_code = ${code} and kind = ${kind} order by created_at limit 1`,
    )
  ).id;
}

async function grant(
  tx: Tx,
  user: string,
  province: string,
  loc: string,
  localityId: string | null,
): Promise<string> {
  return (
    await first<{ id: string }>(
      tx,
      sql`insert into public.govt_assignments (user_id, jurisdiction_province, jurisdiction_locality, locality_id)
          values (${user}::uuid, ${province}, ${loc}, ${localityId}::uuid)
          returning id::text as id`,
    )
  ).id;
}

async function unitOfGrant(tx: Tx, assignmentId: string): Promise<string | null> {
  return (
    await first<{ unit: string | null }>(
      tx,
      sql`select authority_unit_id::text as unit from public.govt_assignments where id = ${assignmentId}::uuid`,
    )
  ).unit;
}

const MECHITA_ALBERTI = "06021030";

describe("confirmGrantUnit", () => {
  it("a holder of every locality of the unit is confirmed without widening, and audited", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = await admin(tx);
      const user = await newGovt(tx);
      const unit = await municipalUnitOf(tx, (await locality(tx, MECHITA_ALBERTI)).id);
      const grants: string[] = [];
      for (const m of await membersOf(tx, unit)) {
        grants.push(await grant(tx, user, "Buenos Aires", `${m.name} ${m.id.slice(0, 4)}`, m.id));
      }
      const plan = await planGrantUnit(tx, { userId: user, unitId: unit });
      expect(plan).toMatchObject({ added: [] });

      const done = await confirmGrantUnit(tx, actor, {
        userId: user,
        unitId: unit,
        reason: "Convenio firmado",
        acceptAdded: [],
      });
      expect(done).toEqual({ ok: true, assignmentIds: [...grants].sort() });
      for (const g of grants) expect(await unitOfGrant(tx, g)).toBe(unit);

      const audit = await first<{ n: number }>(
        tx,
        sql`select count(*)::int as n from public.audit_log
             where action = 'govt_assignment_unit_confirmed' and actor_user_id = ${actor}::uuid
               and payload->>'unit_id' = ${unit}`,
      );
      expect(audit.n).toBe(1);
    });
  });

  it("a partial holder is refused until the admin names every added locality", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = await admin(tx);
      const user = await newGovt(tx);
      const mechita = await locality(tx, MECHITA_ALBERTI);
      const unit = await municipalUnitOf(tx, mechita.id);
      const members = await membersOf(tx, unit);
      expect(members.length).toBeGreaterThan(1);
      const only = await grant(tx, user, "Buenos Aires", "Mechita", mechita.id);
      const added = members
        .filter((m) => m.id !== mechita.id)
        .map((m) => m.id)
        .sort();

      const refused = await confirmGrantUnit(tx, actor, {
        userId: user,
        unitId: unit,
        reason: "Convenio firmado",
        acceptAdded: [],
      });
      expect(refused).toMatchObject({ error: "PARTIAL_GRANT" });
      expect(await unitOfGrant(tx, only)).toBeNull();

      const wrongList = await confirmGrantUnit(tx, actor, {
        userId: user,
        unitId: unit,
        reason: "Convenio firmado",
        acceptAdded: added.slice(1),
      });
      expect(wrongList).toMatchObject({ error: "PARTIAL_GRANT" });
      expect(await unitOfGrant(tx, only)).toBeNull();

      const accepted = await confirmGrantUnit(tx, actor, {
        userId: user,
        unitId: unit,
        reason: "El municipio asume todo el partido",
        acceptAdded: added,
      });
      expect(accepted).toEqual({ ok: true, assignmentIds: [only] });
      expect(await unitOfGrant(tx, only)).toBe(unit);
    });
  });

  it("a grant with no recorded catalogue row is never mapped by its name", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = await admin(tx);
      const user = await newGovt(tx);
      const unit = await municipalUnitOf(tx, (await locality(tx, MECHITA_ALBERTI)).id);
      const byName = await grant(tx, user, "Buenos Aires", "Mechita", null);
      expect(
        await confirmGrantUnit(tx, actor, {
          userId: user,
          unitId: unit,
          reason: "x",
          acceptAdded: [],
        }),
      ).toEqual({ error: "NO_GRANTS" });
      expect(await unitOfGrant(tx, byName)).toBeNull();
    });
  });

  it("a whole-CABA grant maps to the provincia AR-C unit, never the ciudad unit", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = await admin(tx);
      const user = await newGovt(tx);
      const whole = await grant(tx, user, "CABA", "Ciudad Autónoma de Buenos Aires", null);
      const provincia = await unitOfKind(tx, "AR-C", "provincia");
      const ciudad = await unitOfKind(tx, "AR-C", "ciudad");

      expect(
        await confirmGrantUnit(tx, actor, {
          userId: user,
          unitId: ciudad,
          reason: "x",
          acceptAdded: [],
        }),
      ).toMatchObject({ error: "WHOLE_PROVINCE_GRANT" });
      expect(await unitOfGrant(tx, whole)).toBeNull();

      expect(
        await confirmGrantUnit(tx, actor, {
          userId: user,
          unitId: provincia,
          reason: "Toda la ciudad",
          acceptAdded: [],
        }),
      ).toEqual({ ok: true, assignmentIds: [whole] });
      expect(await unitOfGrant(tx, whole)).toBe(provincia);
    });
  });

  it("the unit's page lists each holder whose grants would move, with what the unit adds", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await newGovt(tx);
      const mechita = await locality(tx, MECHITA_ALBERTI);
      const unit = await municipalUnitOf(tx, mechita.id);
      const only = await grant(tx, user, "Buenos Aires", "Mechita", mechita.id);
      const candidates = await listGrantCandidates(tx, unit);
      const mine = candidates.find((c) => c.userId === user);
      expect(mine?.displayName).toBe("D2 confirm probe");
      expect(mine?.grants).toEqual([{ assignmentId: only, locality: "Mechita" }]);
      expect(mine?.added.map((a) => a.localityId)).not.toContain(mechita.id);
      expect(mine?.added.length).toBe((await membersOf(tx, unit)).length - 1);
    });
  });

  it("only an active platform admin confirms", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await newGovt(tx);
      const unit = await municipalUnitOf(tx, (await locality(tx, MECHITA_ALBERTI)).id);
      expect(
        await confirmGrantUnit(tx, user, {
          userId: user,
          unitId: unit,
          reason: "x",
          acceptAdded: [],
        }),
      ).toEqual({ error: "CAPABILITY_DENIED" });
    });
  });
});

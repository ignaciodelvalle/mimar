// The /admin/localidades unit editor (localidades-por-id C4, design addendum #2).
//
// Current membership decides visibility, so a membership change is an act of
// authority: only an active platform admin makes it, every change says who,
// when, before and after, and a unit's change log is readable by platform
// admins. A municipal membership is MOVED, never removed (every live locality
// stays in exactly one municipal unit); a regional one can be removed.
//
// Everything runs inside a transaction that is always rolled back: the local
// database is shared, and neither a unit nor a membership is ever deleted.

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import {
  confirmAuthorityUnit,
  createAuthorityUnit,
  moveLocalityToUnit,
  removeLocalityFromUnit,
  renameAuthorityUnit,
} from "@/src/modules/organizations/application/authority-units/manage-units";
import {
  listAuthorityUnits,
  loadAuthorityUnitDetail,
} from "@/src/modules/organizations/application/authority-units/read-units";

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

async function profileId(tx: Tx, role: "admin" | "govt"): Promise<string> {
  const rows = (await tx.execute(sql`
    select id::text as id from public.profiles
     where role = ${role}::user_role and account_type = 'institutional'
       and deactivated_at is null and deleted_at is null
     order by created_at limit 1
  `)) as unknown as Array<{ id: string }>;
  expect(rows, `the local database must have an active institutional ${role}`).toHaveLength(1);
  return (rows[0] as { id: string }).id;
}

async function localityId(tx: Tx, indecId: string): Promise<string> {
  const rows = (await tx.execute(sql`
    select id::text as id from public.ar_localities where indec_id = ${indecId}
  `)) as unknown as Array<{ id: string }>;
  return (rows[0] as { id: string }).id;
}

async function activeUnit(tx: Tx, locality: string, level: string): Promise<string | null> {
  const rows = (await tx.execute(sql`
    select unit_id::text as unit_id from public.authority_unit_localities
     where locality_id = ${locality}::uuid and level = ${level} and valid_to is null
  `)) as unknown as Array<{ unit_id: string }>;
  return rows[0]?.unit_id ?? null;
}

const VILLA_MARIA_BA = "06021060"; // partido Alberti
const VILLA_MARIA_CBA = "14042170";

describe("moveLocalityToUnit", () => {
  it("closes the old membership, opens the new one and audits who, when, before and after", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await profileId(tx, "admin");
      const loc = await localityId(tx, VILLA_MARIA_BA);
      const from = await activeUnit(tx, loc, "municipal");
      expect(from, "the seed placed Villa María (BA) in a unit").not.toBeNull();
      const created = await createAuthorityUnit(tx, admin, {
        kind: "municipio",
        provinceCode: "AR-B",
        name: "Municipio de prueba",
      });
      if (!("ok" in created)) throw new Error(created.error);

      const result = await moveLocalityToUnit(tx, admin, {
        localityId: loc,
        toUnitId: created.unitId,
        reason: "Convenio con el municipio",
      });
      expect(result).toEqual({ ok: true, noOp: false });
      expect(await activeUnit(tx, loc, "municipal")).toBe(created.unitId);

      const history = (await tx.execute(sql`
        select unit_id::text as unit_id, valid_to is not null as closed,
               added_by::text as added_by, ended_by::text as ended_by
          from public.authority_unit_localities
         where locality_id = ${loc}::uuid and level = 'municipal'
         order by valid_from, valid_to nulls last
      `)) as unknown as Array<Record<string, unknown>>;
      expect(history.at(-2)).toMatchObject({ unit_id: from, closed: true, ended_by: admin });
      expect(history.at(-1)).toMatchObject({
        unit_id: created.unitId,
        closed: false,
        added_by: admin,
      });

      const [audit] = (await tx.execute(sql`
        select actor_user_id::text as actor, payload from public.audit_log
         where action = 'authority_unit_membership_moved'
           and payload->>'locality_id' = ${loc}
         order by performed_at desc limit 1
      `)) as unknown as Array<{ actor: string; payload: Record<string, unknown> }>;
      expect(audit?.actor).toBe(admin);
      expect(audit?.payload).toMatchObject({
        locality_id: loc,
        from_unit_id: from,
        to_unit_id: created.unitId,
        level: "municipal",
        reason: "Convenio con el municipio",
        before_values: { unit_id: from },
        after_values: { unit_id: created.unitId },
      });
    });
  });

  it("moving a locality to the unit it is already in is a no-op, with no audit row", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await profileId(tx, "admin");
      const loc = await localityId(tx, VILLA_MARIA_BA);
      const current = (await activeUnit(tx, loc, "municipal")) as string;
      const [before] = (await tx.execute(sql`
        select count(*)::int as n from public.audit_log where action = 'authority_unit_membership_moved'
      `)) as unknown as Array<{ n: number }>;
      expect(
        await moveLocalityToUnit(tx, admin, { localityId: loc, toUnitId: current, reason: "x" }),
      ).toEqual({ ok: true, noOp: true });
      const [after] = (await tx.execute(sql`
        select count(*)::int as n from public.audit_log where action = 'authority_unit_membership_moved'
      `)) as unknown as Array<{ n: number }>;
      expect(after?.n).toBe(before?.n);
    });
  });

  it("refuses a unit of another province, and a non-admin actor", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await profileId(tx, "admin");
      const govt = await profileId(tx, "govt");
      const cordoba = await localityId(tx, VILLA_MARIA_CBA);
      const baUnit = (await activeUnit(
        tx,
        await localityId(tx, VILLA_MARIA_BA),
        "municipal",
      )) as string;
      expect(
        await moveLocalityToUnit(tx, admin, {
          localityId: cordoba,
          toUnitId: baUnit,
          reason: "prueba",
        }),
      ).toEqual({ error: "PROVINCE_MISMATCH" });
      expect(
        await moveLocalityToUnit(tx, govt, {
          localityId: cordoba,
          toUnitId: baUnit,
          reason: "prueba",
        }),
      ).toEqual({ error: "CAPABILITY_DENIED" });
    });
  });

  it("requires a reason", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await profileId(tx, "admin");
      const loc = await localityId(tx, VILLA_MARIA_BA);
      const unit = (await activeUnit(tx, loc, "municipal")) as string;
      const result = await moveLocalityToUnit(tx, admin, {
        localityId: loc,
        toUnitId: unit,
        reason: "   ",
      });
      expect(result).toMatchObject({ error: expect.stringMatching(/^VALIDATION_ERROR/) });
    });
  });
});

describe("removeLocalityFromUnit", () => {
  it("a municipal membership is moved, never removed", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await profileId(tx, "admin");
      const loc = await localityId(tx, VILLA_MARIA_BA);
      const unit = (await activeUnit(tx, loc, "municipal")) as string;
      expect(
        await removeLocalityFromUnit(tx, admin, { localityId: loc, unitId: unit, reason: "x" }),
      ).toEqual({ error: "MUNICIPAL_MEMBERSHIP_MOVES_ONLY" });
      expect(await activeUnit(tx, loc, "municipal")).toBe(unit);
    });
  });

  it("a regional membership can be removed, audited", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await profileId(tx, "admin");
      const loc = await localityId(tx, VILLA_MARIA_BA);
      const region = await createAuthorityUnit(tx, admin, {
        kind: "region",
        provinceCode: "AR-B",
        name: "Región Sanitaria de prueba",
      });
      if (!("ok" in region)) throw new Error(region.error);
      await moveLocalityToUnit(tx, admin, {
        localityId: loc,
        toUnitId: region.unitId,
        reason: "alta en la región",
      });
      expect(await activeUnit(tx, loc, "regional")).toBe(region.unitId);

      expect(
        await removeLocalityFromUnit(tx, admin, {
          localityId: loc,
          unitId: region.unitId,
          reason: "la región se redefine",
        }),
      ).toEqual({ ok: true });
      expect(await activeUnit(tx, loc, "regional")).toBeNull();
      const [audit] = (await tx.execute(sql`
        select payload from public.audit_log
         where action = 'authority_unit_membership_removed' and payload->>'locality_id' = ${loc}
         order by performed_at desc limit 1
      `)) as unknown as Array<{ payload: Record<string, unknown> }>;
      expect(audit?.payload).toMatchObject({
        unit_id: region.unitId,
        level: "regional",
        reason: "la región se redefine",
      });
    });
  });
});

describe("unit lifecycle", () => {
  it("a region is created regional, under its province; a provincia is never created by hand", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await profileId(tx, "admin");
      const region = await createAuthorityUnit(tx, admin, {
        kind: "region",
        provinceCode: "AR-B",
        name: "Región Sanitaria XIII",
      });
      if (!("ok" in region)) throw new Error(region.error);
      const [row] = (await tx.execute(sql`
        select u.level, u.status, p.kind as parent_kind
          from public.authority_units u
          left join public.authority_units p on p.id = u.parent_unit_id
         where u.id = ${region.unitId}::uuid
      `)) as unknown as Array<{ level: string; status: string; parent_kind: string | null }>;
      expect(row).toEqual({ level: "regional", status: "draft", parent_kind: "provincia" });
      expect(
        await createAuthorityUnit(tx, admin, {
          kind: "provincia",
          provinceCode: "AR-B",
          name: "X",
        }),
      ).toMatchObject({ error: expect.stringMatching(/^VALIDATION_ERROR/) });
    });
  });

  it("confirming and renaming a unit are audited with before and after", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await profileId(tx, "admin");
      const unit = (await activeUnit(
        tx,
        await localityId(tx, VILLA_MARIA_BA),
        "municipal",
      )) as string;
      expect(
        await renameAuthorityUnit(tx, admin, { unitId: unit, name: "Partido de Alberti" }),
      ).toEqual({
        ok: true,
      });
      expect(await confirmAuthorityUnit(tx, admin, { unitId: unit })).toEqual({ ok: true });
      const [row] = (await tx.execute(sql`
        select status, confirmed_by::text as confirmed_by from public.authority_units
         where id = ${unit}::uuid
      `)) as unknown as Array<{ status: string; confirmed_by: string }>;
      expect(row).toEqual({ status: "confirmed", confirmed_by: admin });
      const actions = (await tx.execute(sql`
        select action, payload->'before_values' as before, payload->'after_values' as after
          from public.audit_log
         where payload->>'unit_id' = ${unit}
           and action in ('authority_unit_confirmed', 'authority_unit_renamed')
         order by performed_at, action
      `)) as unknown as Array<{ action: string; before: unknown; after: unknown }>;
      expect(actions.map((a) => a.action).sort()).toEqual([
        "authority_unit_confirmed",
        "authority_unit_renamed",
      ]);
      expect(actions.find((a) => a.action === "authority_unit_confirmed")).toMatchObject({
        before: { status: "draft" },
        after: { status: "confirmed" },
      });
    });
  });
});

describe("reading units", () => {
  it("lists a province's units with their live member counts", async () => {
    await inRolledBackTx(async (tx) => {
      const units = await listAuthorityUnits(tx, "AR-C");
      const ciudad = units.find((u) => u.kind === "ciudad");
      expect(ciudad).toMatchObject({ name: "Ciudad Autónoma de Buenos Aires", level: "municipal" });
      expect(ciudad?.members).toBeGreaterThanOrEqual(48);
      expect(units.find((u) => u.kind === "provincia")).toMatchObject({ members: null });
    });
  });

  it("a unit's change log shows every move with its actor, date and reason", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await profileId(tx, "admin");
      const loc = await localityId(tx, VILLA_MARIA_BA);
      const created = await createAuthorityUnit(tx, admin, {
        kind: "municipio",
        provinceCode: "AR-B",
        name: "Municipio de prueba",
      });
      if (!("ok" in created)) throw new Error(created.error);
      await moveLocalityToUnit(tx, admin, {
        localityId: loc,
        toUnitId: created.unitId,
        reason: "Convenio con el municipio",
      });

      const detail = await loadAuthorityUnitDetail(tx, created.unitId);
      expect(detail?.members.map((m) => m.localityId)).toEqual([loc]);
      const move = detail?.changes.find((c) => c.action === "authority_unit_membership_moved");
      expect(move).toMatchObject({
        actorUserId: admin,
        localityId: loc,
        localityName: "Villa María",
        reason: "Convenio con el municipio",
      });
      expect(move?.performedAt).toBeInstanceOf(Date);
    });
  });
});

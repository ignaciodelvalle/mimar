// E3 (localidades-por-id): closing the memberships of localities the INDEC
// import removed.
//
// A catalogue row the import soft-removes (removed_at set) keeps its active
// unit memberships: the membership fence keeps every LIVE locality in one
// municipal unit, and nothing may close a membership behind an admin's back.
// So they are LISTED on /admin/localidades, and an admin closes each one
// explicitly — with a reason, audited, never automatically. A live locality's
// municipal membership still only moves. Everything is rolled back.

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import {
  closeRemovedLocalityMembership,
  listRemovedLocalityMemberships,
} from "@/src/modules/organizations/application/authority-units/removed-locality-memberships";

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

/** A live locality of Buenos Aires with an active municipal membership. */
async function member(tx: Tx): Promise<{ localityId: string; unitId: string }> {
  const rows = (await tx.execute(sql`
    select l.id::text as "localityId", m.unit_id::text as "unitId"
      from public.ar_localities l
      join public.authority_unit_localities m
        on m.locality_id = l.id and m.level = 'municipal' and m.valid_to is null
     where l.province_code = 'AR-B' and l.removed_at is null and l.indec_id = '06112080'
  `)) as unknown as Array<{ localityId: string; unitId: string }>;
  expect(rows).toHaveLength(1);
  return rows[0] as { localityId: string; unitId: string };
}

describe("memberships of removed localities (E3)", () => {
  it("are listed, and an admin closes one with a reason, audited; a rerun finds nothing", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await profileId(tx, "admin");
      const m = await member(tx);
      await tx.execute(sql`
        update public.ar_localities set removed_at = now() where id = ${m.localityId}::uuid
      `);

      const listed = await listRemovedLocalityMemberships(tx, { provinceCode: "AR-B" });
      const row = listed.find((r) => r.localityId === m.localityId);
      expect(row).toMatchObject({ unitId: m.unitId, level: "municipal" });
      expect(row?.unitName).toBeTruthy();

      const result = await closeRemovedLocalityMembership(tx, admin, {
        localityId: m.localityId,
        unitId: m.unitId,
        reason: "El INDEC dio de baja la localidad en la importación de 2026.",
      });
      expect(result).toEqual({ ok: true });

      const [closed] = (await tx.execute(sql`
        select valid_to is not null as closed, ended_by::text as "endedBy"
          from public.authority_unit_localities
         where locality_id = ${m.localityId}::uuid and unit_id = ${m.unitId}::uuid
         order by valid_from desc limit 1
      `)) as unknown as Array<{ closed: boolean; endedBy: string }>;
      expect(closed).toEqual({ closed: true, endedBy: admin });

      const [audit] = (await tx.execute(sql`
        select payload from public.audit_log
         where action = 'authority_unit_membership_removed' and actor_user_id = ${admin}::uuid
           and payload->>'locality_id' = ${m.localityId}
         order by performed_at desc limit 1
      `)) as unknown as Array<{ payload: Record<string, unknown> }>;
      expect(audit?.payload).toMatchObject({
        unit_id: m.unitId,
        cause: "locality_removed_from_catalogue",
      });

      expect(
        (await listRemovedLocalityMemberships(tx, { provinceCode: "AR-B" })).some(
          (r) => r.localityId === m.localityId,
        ),
      ).toBe(false);
      expect(
        await closeRemovedLocalityMembership(tx, admin, {
          localityId: m.localityId,
          unitId: m.unitId,
          reason: "otra vez",
        }),
      ).toEqual({ error: "NOT_A_MEMBER" });
    });
  });

  it("refuses a missing reason, a non-admin, and a locality the catalogue still holds", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await profileId(tx, "admin");
      const govt = await profileId(tx, "govt");
      const m = await member(tx);
      // Still live: its municipal membership only moves.
      expect(
        await closeRemovedLocalityMembership(tx, admin, { ...m, reason: "no corresponde" }),
      ).toEqual({ error: "LOCALITY_NOT_REMOVED" });

      await tx.execute(sql`
        update public.ar_localities set removed_at = now() where id = ${m.localityId}::uuid
      `);
      const noReason = await closeRemovedLocalityMembership(tx, admin, { ...m, reason: "  " });
      expect("error" in noReason && noReason.error.startsWith("VALIDATION_ERROR")).toBe(true);
      expect(await closeRemovedLocalityMembership(tx, govt, { ...m, reason: "x" })).toEqual({
        error: "CAPABILITY_DENIED",
      });
    });
  });
});

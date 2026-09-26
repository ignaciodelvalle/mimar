// Two stage-D guards, pinned (stage D verify W2 + W3).
//
// W2 — only a CONFIRMED authority unit governs anything. The confirm flow and
// govt_scope were already tested; the routing, rules and coverage READS were
// not, so dropping their `u.status = 'confirmed'` would have stayed green.
//
// W3 — shadow mode never breaks the request it watches. The id path is made
// to fail for real (a place id that is not a uuid fails its ::uuid cast); the
// name answer is served, and the caller's transaction is still usable.
//
// Everything runs in a transaction that is always rolled back.

import { TransactionRollbackError, and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { authorityUnitLocalities, db, govtAssignments, organizationCoverage } from "@/db";
import { govtAuthoritiesForPlace } from "@/lib/infra/approval-routing";
import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import { coveringOrgIds, coveringOrgsInShadow } from "@/lib/infra/lost-pet-broadcast";
import { coverageCoversPlaceById } from "@/lib/place/coverage";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const MECHITA_BRAGADO = "06112080";

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

async function bragadoUnit(tx: Tx) {
  const [row] = (await tx.execute(sql`
    select id::text as id from public.ar_localities where indec_id = ${MECHITA_BRAGADO}
  `)) as unknown as Array<{ id: string }>;
  const locality = row?.id as string;
  const [m] = await tx
    .select({ unitId: authorityUnitLocalities.unitId })
    .from(authorityUnitLocalities)
    .where(
      and(
        eq(authorityUnitLocalities.localityId, locality),
        eq(authorityUnitLocalities.level, "municipal"),
      ),
    );
  const unit = m?.unitId as string;
  await tx.execute(sql`
    update public.authority_units set status = 'draft', confirmed_at = null where id = ${unit}::uuid
  `);
  const confirm = () =>
    tx.execute(sql`
      update public.authority_units set status = 'confirmed', confirmed_at = now()
       where id = ${unit}::uuid
    `);
  return { locality, unit, confirm };
}

const mechita = (localityId: string) => ({
  province: "Buenos Aires",
  locality: "Mechita",
  localityId,
});

describe("draft units govern nothing (W2)", () => {
  it("routing: a grant on a draft unit is not paged; once confirmed it is", async () => {
    await inRolledBackTx(async (tx) => {
      const { locality, unit, confirm } = await bragadoUnit(tx);
      const [govt] = (await tx.execute(sql`
        select id::text as id from public.profiles
         where role = 'govt' and deactivated_at is null and deleted_at is null and not is_system
         order by created_at limit 1
      `)) as unknown as Array<{ id: string }>;
      const userId = govt?.id as string;
      await tx.delete(govtAssignments).where(eq(govtAssignments.userId, userId));
      await tx.insert(govtAssignments).values({
        userId,
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "Mechita",
        localityId: locality,
        authorityUnitId: unit,
      });
      const paged = () => govtAuthoritiesForPlace(mechita(locality), { mode: "id", exec: tx });
      expect(await paged()).not.toContain(userId);
      await confirm();
      expect(await paged()).toContain(userId);
    });
  });

  it("rules: a draft unit's ordinance governs nothing; once confirmed it does", async () => {
    await inRolledBackTx(async (tx) => {
      const { locality, unit, confirm } = await bragadoUnit(tx);
      const [rule] = (await tx.execute(sql`
        insert into public.govt_business_rules
          (jurisdiction_country, jurisdiction_province, jurisdiction_locality, authority_unit_id,
           rule_type, rule_payload)
        values ('AR', 'Buenos Aires', 'Bragado', ${unit}::uuid, 'rabies_observation_window',
                '{"days": 17}'::jsonb)
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const resolve = () =>
        resolveBusinessRule(
          "rabies_observation_window",
          { country: "AR", ...mechita(locality) },
          tx,
          { mode: "id" },
        );
      expect((await resolve()).matchedRow?.id).not.toBe(rule?.id);
      await confirm();
      expect((await resolve()).matchedRow?.id).toBe(rule?.id);
    });
  });

  it("coverage: a zone keyed to a draft unit covers nothing; once confirmed it does", async () => {
    await inRolledBackTx(async (tx) => {
      const { locality, unit, confirm } = await bragadoUnit(tx);
      const [org] = (await tx.execute(sql`
        select id::text as id from public.organizations order by created_at limit 1
      `)) as unknown as Array<{ id: string }>;
      await tx.insert(organizationCoverage).values({
        organizationId: org?.id as string,
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "Bragado",
        authorityUnitId: unit,
      });
      const covering = async () =>
        (
          await tx
            .select({ id: organizationCoverage.id })
            .from(organizationCoverage)
            .where(
              and(
                eq(organizationCoverage.authorityUnitId, unit),
                coverageCoversPlaceById(mechita(locality)),
              ),
            )
        ).length;
      expect(await covering()).toBe(0);
      await confirm();
      expect(await covering()).toBe(1);
    });
  });
});

describe("shadow never breaks the request it watches (W3)", () => {
  // Not a uuid: the id path's ::uuid cast fails, the name path never reads it.
  const broken = { province: "Buenos Aires", locality: "Mechita", localityId: "not-a-uuid" };

  it("routing, rules and coverage serve the name answer, and the transaction lives on", async () => {
    await inRolledBackTx(async (tx) => {
      const byName = await govtAuthoritiesForPlace(broken, { mode: "name", exec: tx });
      expect(await govtAuthoritiesForPlace(broken, { mode: "shadow", exec: tx })).toEqual(byName);

      const ruleByName = await resolveBusinessRule(
        "rabies_observation_window",
        { country: "AR", ...broken },
        tx,
        { mode: "name" },
      );
      const ruleInShadow = await resolveBusinessRule(
        "rabies_observation_window",
        { country: "AR", ...broken },
        tx,
        { mode: "shadow" },
      );
      expect(ruleInShadow.matchedRow?.id ?? null).toBe(ruleByName.matchedRow?.id ?? null);

      const orgsByName = await coveringOrgIds(tx, broken, "name");
      expect(await coveringOrgsInShadow(tx, broken, "shadow-guard-test")).toEqual(orgsByName);

      // The failed id statements were rolled back to their savepoints.
      const [alive] = (await tx.execute(sql`select 1 as one`)) as unknown as Array<{
        one: number;
      }>;
      expect(alive?.one).toBe(1);
    });
  });
});

// Stage D verify W8: every holder of the unit that governs the place is
// paged — not the first one found — and none of the homonym's unit.
describe("multi-operator fan-out (W8)", () => {
  it("all three operators of Bragado's unit are paged; Alberti's operator is not", async () => {
    await inRolledBackTx(async (tx) => {
      const { locality, unit, confirm } = await bragadoUnit(tx);
      await confirm();
      const [alberti] = (await tx.execute(sql`
        select l.id::text as locality, m.unit_id::text as unit
          from public.ar_localities l
          join public.authority_unit_localities m
            on m.locality_id = l.id and m.level = 'municipal' and m.valid_to is null
         where l.indec_id = '06021030'
      `)) as unknown as Array<{ locality: string; unit: string }>;
      await tx.execute(sql`
        update public.authority_units set status = 'confirmed', confirmed_at = now()
         where id = ${alberti?.unit}::uuid
      `);
      const govts = (await tx.execute(sql`
        select id::text as id from public.profiles
         where role = 'govt' and deactivated_at is null and deleted_at is null and not is_system
         order by created_at limit 4
      `)) as unknown as Array<{ id: string }>;
      expect(govts.length, "four govt profiles must exist (seed)").toBe(4);
      const ids = govts.map((g) => g.id);
      for (const id of ids) await tx.delete(govtAssignments).where(eq(govtAssignments.userId, id));
      await tx.insert(govtAssignments).values([
        ...ids.slice(0, 3).map((userId) => ({
          userId,
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "Mechita",
          localityId: locality,
          authorityUnitId: unit,
        })),
        {
          userId: ids[3] as string,
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "Mechita",
          localityId: alberti?.locality as string,
          authorityUnitId: alberti?.unit as string,
        },
      ]);
      const paged = await govtAuthoritiesForPlace(mechita(locality), { mode: "id", exec: tx });
      for (const id of ids.slice(0, 3)) expect(paged).toContain(id);
      expect(paged).not.toContain(ids[3]);
    });
  });
});

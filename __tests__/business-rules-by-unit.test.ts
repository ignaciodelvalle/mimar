// Business rules by authority unit (localidades-por-id D4, spec
// "business-rules-resolution").
//
// On the id path the cascade is: a rule keyed to a unit that governs the place
// (most specific level first) → a legacy locality rule by name → a rule keyed
// to the provincial unit → a legacy province rule → country → default. A
// unit's ordinance never governs a homonym in another partido or province; an
// unresolved place never takes a locality-level ordinance. A legacy rule row
// (unit NULL) with no locality_id matches by name exactly as before; one that
// recorded its catalogue row matches only that row.
//
// The path is asked explicitly (mode) so the shared `rules` flag is never
// touched; every fixture lives in a transaction that is always rolled back.

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";

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

/** A rabies-window rule row; returns its id. The type is unique per name tuple. */
async function rule(
  tx: Tx,
  over: {
    locality: string | null;
    unitId?: string | null;
    localityId?: string | null;
    days: number;
  },
): Promise<string> {
  // Clear any row already holding this name tuple (rolled back afterwards).
  await tx.execute(sql`
    delete from public.govt_business_rules
     where rule_type = 'rabies_observation_window' and jurisdiction_country = 'AR'
       and jurisdiction_province = 'Buenos Aires'
       and jurisdiction_locality is not distinct from ${over.locality}
  `);
  return (
    await first<{ id: string }>(
      tx,
      sql`insert into public.govt_business_rules
            (jurisdiction_country, jurisdiction_province, jurisdiction_locality,
             authority_unit_id, locality_id, rule_type, rule_payload)
          values ('AR', 'Buenos Aires', ${over.locality}, ${over.unitId ?? null}::uuid,
                  ${over.localityId ?? null}::uuid, 'rabies_observation_window',
                  ${JSON.stringify({ days: over.days })}::jsonb)
          returning id::text as id`,
    )
  ).id;
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

const mechita = (localityId: string | null) => ({
  country: "AR",
  province: "Buenos Aires",
  locality: "Mechita",
  localityId,
});

describe("resolveBusinessRule on the id path", () => {
  it("a Bragado ordinance governs Bragado's Mechita and never Alberti's", async () => {
    await inRolledBackTx(async (tx) => {
      const alberti = await localityId(tx, MECHITA_ALBERTI);
      const bragado = await localityId(tx, MECHITA_BRAGADO);
      const bragadoUnit = await municipalUnitOf(tx, bragado);
      const ordinance = await rule(tx, { locality: "Bragado", unitId: bragadoUnit, days: 14 });

      const inBragado = await resolveBusinessRule(
        "rabies_observation_window",
        mechita(bragado),
        tx,
        { mode: "id" },
      );
      expect(inBragado.matchedRow?.id).toBe(ordinance);
      expect(inBragado.matchedRow?.authorityUnitId).toBe(bragadoUnit);
      expect(inBragado.source).toBe("locality");

      const inAlberti = await resolveBusinessRule(
        "rabies_observation_window",
        mechita(alberti),
        tx,
        { mode: "id" },
      );
      expect(inAlberti.matchedRow?.id).not.toBe(ordinance);
    });
  });

  it("an unresolved place never takes a unit's locality-level ordinance", async () => {
    await inRolledBackTx(async (tx) => {
      const bragado = await localityId(tx, MECHITA_BRAGADO);
      const ordinance = await rule(tx, {
        locality: "Bragado",
        unitId: await municipalUnitOf(tx, bragado),
        days: 14,
      });
      const unresolved = await resolveBusinessRule("rabies_observation_window", mechita(null), tx, {
        mode: "id",
      });
      expect(unresolved.matchedRow?.id).not.toBe(ordinance);
      expect(unresolved.source).not.toBe("locality");
    });
  });

  it("a legacy locality rule with no catalogue row matches by name on both paths", async () => {
    await inRolledBackTx(async (tx) => {
      const alberti = await localityId(tx, MECHITA_ALBERTI);
      const legacy = await rule(tx, { locality: "Mechita", days: 12 });
      for (const mode of ["name", "id"] as const) {
        const r = await resolveBusinessRule("rabies_observation_window", mechita(alberti), tx, {
          mode,
        });
        expect(r.matchedRow?.id, mode).toBe(legacy);
      }
    });
  });

  it("a legacy rule that recorded Bragado's row stops governing Alberti's Mechita", async () => {
    await inRolledBackTx(async (tx) => {
      const alberti = await localityId(tx, MECHITA_ALBERTI);
      const bragado = await localityId(tx, MECHITA_BRAGADO);
      const legacy = await rule(tx, { locality: "Mechita", localityId: bragado, days: 12 });
      const byName = await resolveBusinessRule("rabies_observation_window", mechita(alberti), tx, {
        mode: "name",
      });
      const byId = await resolveBusinessRule("rabies_observation_window", mechita(alberti), tx, {
        mode: "id",
      });
      expect(byName.matchedRow?.id).toBe(legacy);
      expect(byId.matchedRow?.id).not.toBe(legacy);
      const own = await resolveBusinessRule("rabies_observation_window", mechita(bragado), tx, {
        mode: "id",
      });
      expect(own.matchedRow?.id).toBe(legacy);
    });
  });

  it("a unit-keyed row is never matched by its name pair on the id path", async () => {
    await inRolledBackTx(async (tx) => {
      const bragado = await localityId(tx, MECHITA_BRAGADO);
      const alberti = await localityId(tx, MECHITA_ALBERTI);
      // Keyed to Bragado's unit but carrying the name "Mechita".
      const keyed = await rule(tx, {
        locality: "Mechita",
        unitId: await municipalUnitOf(tx, bragado),
        days: 20,
      });
      const r = await resolveBusinessRule("rabies_observation_window", mechita(alberti), tx, {
        mode: "id",
      });
      expect(r.matchedRow?.id).not.toBe(keyed);
    });
  });
});

// ---------------------------------------------------------------------------
// The wizard can now key a rule to a catalogue row or a unit (migration 0263),
// so two homonyms can each carry their own ordinance. The NAME path (the
// default flag) must not guess between them, and must never read a
// unit-keyed row as a name rule. With one row per name — every row before
// 0263 — it answers exactly as before.
// ---------------------------------------------------------------------------

async function keyedMechitaRule(tx: Tx, localityRow: string, days: number): Promise<string> {
  return (
    await first<{ id: string }>(
      tx,
      sql`insert into public.govt_business_rules
            (jurisdiction_country, jurisdiction_province, jurisdiction_locality,
             locality_id, rule_type, rule_payload)
          values ('AR', 'Buenos Aires', 'Mechita', ${localityRow}::uuid,
                  'rabies_observation_window', ${JSON.stringify({ days })}::jsonb)
          returning id::text as id`,
    )
  ).id;
}

describe("resolveBusinessRule on the name path, once homonyms carry their own rules", () => {
  it("two keyed Mechita rules: the place's own row wins; with no row, no locality rule is guessed", async () => {
    await inRolledBackTx(async (tx) => {
      const alberti = await localityId(tx, MECHITA_ALBERTI);
      const bragado = await localityId(tx, MECHITA_BRAGADO);
      await tx.execute(sql`
        delete from public.govt_business_rules
         where rule_type = 'rabies_observation_window' and jurisdiction_province = 'Buenos Aires'
           and jurisdiction_locality = 'Mechita'
      `);
      const albertiRule = await keyedMechitaRule(tx, alberti, 11);
      const bragadoRule = await keyedMechitaRule(tx, bragado, 13);

      const own = await resolveBusinessRule("rabies_observation_window", mechita(bragado), tx, {
        mode: "name",
      });
      expect(own.matchedRow?.id).toBe(bragadoRule);

      const nameOnly = await resolveBusinessRule(
        "rabies_observation_window",
        { country: "AR", province: "Buenos Aires", locality: "Mechita" },
        tx,
      );
      expect([albertiRule, bragadoRule]).not.toContain(nameOnly.matchedRow?.id);
      expect(nameOnly.source).not.toBe("locality");
    });
  });

  it("a unit-keyed rule is never read as a province rule by name", async () => {
    await inRolledBackTx(async (tx) => {
      const bragado = await localityId(tx, MECHITA_BRAGADO);
      const keyed = await rule(tx, {
        locality: null,
        unitId: await municipalUnitOf(tx, bragado),
        days: 21,
      });
      const r = await resolveBusinessRule(
        "rabies_observation_window",
        { country: "AR", province: "Buenos Aires", locality: "Otra" },
        tx,
      );
      expect(r.matchedRow?.id).not.toBe(keyed);
    });
  });
});

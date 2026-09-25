// Fence: every live locality belongs to exactly one active authority unit at
// municipal level, and the membership itself can only be opened and closed —
// never rewritten, never deleted.
//
// localidades-por-id, authority-units (P3: always reach exactly the right
// authority). Before this change there was no authority unit at all: a
// municipality was N `govt_assignments` rows, one per INDEC locality, and a
// partido onboarded with 8 of its 9 localities routed the ninth's bites to
// national admins without a trace (R2 of the 2026-09-25 audit).
//
// C1 (migration 0253) creates `authority_units` + `authority_unit_localities`
// EMPTY; the structural block below pins what the tables refuse. C2
// (scripts/seed-authority-units.ts, run by db:bootstrap) fills the membership,
// and the sweep at the end holds it whole.
//
// Everything that writes runs inside a transaction that is rolled back: the
// local database is shared, and a membership row can never be deleted.

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import { isGovernableLocality } from "@/lib/place/authority-units-plan";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Run `body` in a transaction that is always rolled back. */
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

/** The error a savepoint-wrapped statement raised, or null. */
async function errorOf(tx: Tx, statement: ReturnType<typeof sql>): Promise<string | null> {
  try {
    await tx.transaction(async (sp) => {
      await sp.execute(statement);
    });
    return null;
  } catch (e) {
    let cur = e as { message?: string; cause?: unknown } | null;
    const messages: string[] = [];
    while (cur) {
      if (cur.message) messages.push(cur.message);
      cur = (cur.cause as typeof cur) ?? null;
    }
    return messages.join(" | ");
  }
}

async function localityByIndecId(tx: Tx, indecId: string): Promise<string> {
  const rows = (await tx.execute(sql`
    select id::text as id from public.ar_localities
     where indec_id = ${indecId} and removed_at is null
  `)) as unknown as Array<{ id: string }>;
  expect(rows, `INDEC ${indecId} must be in the local catalogue`).toHaveLength(1);
  return (rows[0] as { id: string }).id;
}

async function newUnit(
  tx: Tx,
  kind: string,
  level: string,
  provinceCode: string,
  name: string,
): Promise<string> {
  const [row] = (await tx.execute(sql`
    insert into public.authority_units (kind, level, province_code, name)
    values (${kind}, ${level}, ${provinceCode}, ${name})
    returning id::text as id
  `)) as unknown as Array<{ id: string }>;
  return (row as { id: string }).id;
}

/** Close the locality's active memberships, so a test can place it itself. */
async function freeLocality(tx: Tx, localityId: string): Promise<void> {
  await tx.execute(sql`
    update public.authority_unit_localities set valid_to = now()
     where locality_id = ${localityId}::uuid and valid_to is null
  `);
}

/** The province's provincial unit: the seeded one, or a new one if absent. */
async function provincialUnit(tx: Tx, provinceCode: string): Promise<string> {
  const rows = (await tx.execute(sql`
    select id::text as id from public.authority_units
     where province_code = ${provinceCode} and kind = 'provincia'
  `)) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? newUnit(tx, "provincia", "provincial", provinceCode, "fence provincia");
}

// Villa María, Buenos Aires (partido Alberti) and Villa María, Córdoba: the
// cross-province homonym pair the whole change is fenced with.
const VILLA_MARIA_BA = "06021060";
const VILLA_MARIA_CBA = "14042170";

describe("authority unit tables (C1, migration 0253)", () => {
  it("both tables exist with row level security enabled", async () => {
    const rows = (await db.execute(sql`
      select c.relname as name, c.relrowsecurity as rls
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('authority_units', 'authority_unit_localities')
       order by c.relname
    `)) as unknown as Array<{ name: string; rls: boolean }>;
    expect(rows).toEqual([
      { name: "authority_unit_localities", rls: true },
      { name: "authority_units", rls: true },
    ]);
  });

  it("a locality has at most one ACTIVE membership per level", async () => {
    await inRolledBackTx(async (tx) => {
      const loc = await localityByIndecId(tx, VILLA_MARIA_BA);
      await freeLocality(tx, loc);
      const a = await newUnit(tx, "municipio", "municipal", "AR-B", "fence A");
      const b = await newUnit(tx, "municipio", "municipal", "AR-B", "fence B");
      expect(
        await errorOf(
          tx,
          sql`insert into public.authority_unit_localities (unit_id, locality_id)
              values (${a}::uuid, ${loc}::uuid)`,
        ),
      ).toBeNull();
      expect(
        await errorOf(
          tx,
          sql`insert into public.authority_unit_localities (unit_id, locality_id)
              values (${b}::uuid, ${loc}::uuid)`,
        ),
      ).toMatch(/authority_unit_localities_active_unique|duplicate key/);
    });
  });

  it("a unit never takes a locality of another province", async () => {
    await inRolledBackTx(async (tx) => {
      const cordoba = await localityByIndecId(tx, VILLA_MARIA_CBA);
      const unit = await newUnit(tx, "municipio", "municipal", "AR-B", "fence BA");
      expect(
        await errorOf(
          tx,
          sql`insert into public.authority_unit_localities (unit_id, locality_id)
              values (${unit}::uuid, ${cordoba}::uuid)`,
        ),
      ).toMatch(/belongs to AR-X, the unit to AR-B/);
    });
  });

  it("a provincial unit covers its province implicitly and takes no explicit member", async () => {
    await inRolledBackTx(async (tx) => {
      const loc = await localityByIndecId(tx, VILLA_MARIA_BA);
      await freeLocality(tx, loc);
      const unit = await provincialUnit(tx, "AR-B");
      expect(
        await errorOf(
          tx,
          sql`insert into public.authority_unit_localities (unit_id, locality_id)
              values (${unit}::uuid, ${loc}::uuid)`,
        ),
      ).toMatch(/provincial unit has no explicit members/);
    });
  });

  it("the membership level is the unit's, whatever the caller sends", async () => {
    await inRolledBackTx(async (tx) => {
      const loc = await localityByIndecId(tx, VILLA_MARIA_BA);
      await freeLocality(tx, loc);
      const unit = await newUnit(tx, "municipio", "municipal", "AR-B", "fence level");
      const [row] = (await tx.execute(sql`
        insert into public.authority_unit_localities (unit_id, locality_id, level)
        values (${unit}::uuid, ${loc}::uuid, 'submunicipal')
        returning level
      `)) as unknown as Array<{ level: string }>;
      expect(row?.level).toBe("municipal");
    });
  });

  it("kind and level agree: only a provincia is provincial", async () => {
    await inRolledBackTx(async (tx) => {
      expect(
        await errorOf(
          tx,
          sql`insert into public.authority_units (kind, level, province_code, name)
              values ('municipio', 'provincial', 'AR-B', 'fence mismatch')`,
        ),
      ).toMatch(/authority_units_kind_level|violates check constraint/);
    });
  });

  it("a membership is closed, never rewritten, deleted or truncated", async () => {
    await inRolledBackTx(async (tx) => {
      const loc = await localityByIndecId(tx, VILLA_MARIA_BA);
      await freeLocality(tx, loc);
      const a = await newUnit(tx, "municipio", "municipal", "AR-B", "fence close A");
      const b = await newUnit(tx, "municipio", "municipal", "AR-B", "fence close B");
      const [m] = (await tx.execute(sql`
        insert into public.authority_unit_localities (unit_id, locality_id)
        values (${a}::uuid, ${loc}::uuid)
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const id = (m as { id: string }).id;

      expect(
        await errorOf(
          tx,
          sql`update public.authority_unit_localities set unit_id = ${b}::uuid where id = ${id}::uuid`,
        ),
      ).toMatch(/only closing an active membership is allowed/);
      expect(
        await errorOf(tx, sql`delete from public.authority_unit_localities where id = ${id}::uuid`),
      ).toMatch(/never deleted/);
      expect(await errorOf(tx, sql`truncate public.authority_unit_localities`)).toMatch(
        /never deleted/,
      );

      // Closing is the one legal update, and it happens once.
      expect(
        await errorOf(
          tx,
          sql`update public.authority_unit_localities
                 set valid_to = now()
               where id = ${id}::uuid`,
        ),
      ).toBeNull();
      expect(
        await errorOf(
          tx,
          sql`update public.authority_unit_localities
                 set valid_to = now()
               where id = ${id}::uuid`,
        ),
      ).toMatch(/only closing an active membership is allowed/);

      // With the old row closed, the locality can join another unit.
      expect(
        await errorOf(
          tx,
          sql`insert into public.authority_unit_localities (unit_id, locality_id)
              values (${b}::uuid, ${loc}::uuid)`,
        ),
      ).toBeNull();
    });
  });

  it("a unit is never deleted", async () => {
    await inRolledBackTx(async (tx) => {
      const unit = await newUnit(tx, "municipio", "municipal", "AR-B", "fence delete");
      expect(
        await errorOf(tx, sql`delete from public.authority_units where id = ${unit}::uuid`),
      ).toMatch(/never deleted/);
    });
  });
});

// Catalogue rows OTHER test files create and delete while the suite runs. The
// suite runs files in parallel, so the sweep below would see them live and in
// no unit. Each marker is the one its owning file documents as impossible
// upstream; none can name a real INDEC or CABA row:
//   - department code ending in 999 (import-indec-localities, ar-localidades:
//     "INDEC assigns department 999 nowhere");
//   - source 'bahra' (department-drill; the catalogue has no BAHRA rows);
//   - slug prefix 'schematest-' (ar-localities-schema).
const SYNTHETIC_FIXTURE = sql`(
  coalesce(l.department_code, '') like '%999'
  or l.source = 'bahra'
  or l.locality_slug like 'schematest-%'
)`;

describe("authority unit membership", () => {
  it("the catalogue this fence will sweep is populated, and so is the membership", async () => {
    const [row] = (await db.execute(sql`
      select (select count(*)::int from public.ar_localities where removed_at is null) as live,
             (select count(*)::int from public.authority_unit_localities where valid_to is null) as members
    `)) as unknown as Array<{ live: number; members: number }>;
    expect(row?.live).toBeGreaterThan(100);
    expect(row?.members).toBeGreaterThan(100);
  });

  // Flipped at C2: scripts/seed-authority-units.ts runs in db:bootstrap after
  // the catalogue import. A red here means a live locality nobody governs (a
  // re-import added it: re-run the seed, or place it in /admin/localidades)
  // or one governed twice.
  it("every live locality is in exactly one active municipal-level unit", async () => {
    const rows = (await db.execute(sql`
      select l.id::text as id, l.province_code as "provinceCode", l.locality_name as "localityName",
             l.department_code as "departmentCode", l.source, count(m.unit_id)::int as units
        from public.ar_localities l
        left join public.authority_unit_localities m
          on m.locality_id = l.id and m.valid_to is null and m.level = 'municipal'
       where l.removed_at is null
         and not ${SYNTHETIC_FIXTURE}
       group by l.id
      having count(m.unit_id) <> 1
    `)) as unknown as Array<{
      id: string;
      provinceCode: string;
      localityName: string;
      departmentCode: string | null;
      source: string;
      units: number;
    }>;
    // A row the catalogue guard drops (whole-province aggregate, superseded
    // source) governs nothing by design — the same predicate the seed uses.
    const offenders = rows.filter((r) => isGovernableLocality({ ...r, departmentName: null }));
    expect(offenders.slice(0, 20)).toEqual([]);
  });
});

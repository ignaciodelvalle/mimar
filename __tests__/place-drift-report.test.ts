// The catalogue drift report (localidades-por-id E3, design "Catalogue drift"):
// after an INDEC import renamed one row and removed another, the report lists
// every row that still stores the old name, and everything that still points
// at the removed id — with the live same-slug rows as successor CANDIDATES,
// none chosen. It only reads: nothing it lists is changed by listing it.
//
// The fixture is an import in miniature, written in a transaction that is
// always rolled back: two catalogue rows, a grant on each, a membership and a
// place resolution on the second; then one rename and one removal.

import { randomUUID } from "node:crypto";

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db, profiles } from "@/db";
import { collectPlaceDrift, formatPlaceDrift } from "@/lib/place/drift-report";

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

async function catalogueRow(tx: Tx, name: string, slug: string): Promise<string> {
  const rows = (await tx.execute(sql`
    insert into public.ar_localities
      (province_code, department_name, locality_name, locality_slug, category, source)
    values ('AR-L', 'Depto Deriva', ${name}, ${slug}, 'localidad', 'manual')
    returning id::text as id
  `)) as unknown as Array<{ id: string }>;
  return (rows[0] as { id: string }).id;
}

async function grant(tx: Tx, userId: string, locality: string, localityId: string) {
  await tx.execute(sql`
    insert into public.govt_assignments
      (user_id, jurisdiction_province, jurisdiction_locality, locality_id)
    values (${userId}::uuid, 'La Pampa', ${locality}, ${localityId}::uuid)
  `);
}

describe("place drift report (E3)", () => {
  it("lists a renamed row's stale names and a removed row's references, with successor candidates", async () => {
    await inRolledBackTx(async (tx) => {
      const tag = randomUUID().slice(0, 8);
      const renamedId = await catalogueRow(tx, `Deriva Uno ${tag}`, `deriva-uno-${tag}`);
      const removedId = await catalogueRow(tx, `Deriva Dos ${tag}`, `deriva-dos-${tag}`);

      const govt = randomUUID();
      await tx.insert(profiles).values({
        id: govt,
        displayName: "E3 drift probe",
        role: "govt",
        accountType: "institutional",
      });
      await grant(tx, govt, `Deriva Uno ${tag}`, renamedId);
      await grant(tx, govt, `Deriva Dos ${tag}`, removedId);

      const [unit] = (await tx.execute(sql`
        select id::text as id from public.authority_units
         where province_code = 'AR-L' and level = 'municipal' order by name limit 1
      `)) as unknown as Array<{ id: string }>;
      expect(unit, "the local database must have a municipal unit in La Pampa").toBeDefined();
      await tx.execute(sql`
        insert into public.authority_unit_localities (unit_id, locality_id, level)
        values (${(unit as { id: string }).id}::uuid, ${removedId}::uuid, 'municipal')
      `);

      // Nothing drifted yet: the fixture is not in the report.
      const before = await collectPlaceDrift(tx);
      expect(before.renamed.filter((g) => g.localityId === renamedId)).toEqual([]);
      expect(before.removed.filter((r) => r.localityId === removedId)).toEqual([]);

      // The import: one rename, one removal, and a re-issued row with the same slug.
      await tx.execute(sql`
        update public.ar_localities set locality_name = ${`Deriva Renombrada ${tag}`}
         where id = ${renamedId}::uuid
      `);
      await tx.execute(sql`
        update public.ar_localities set removed_at = now() where id = ${removedId}::uuid
      `);
      const successorId = await catalogueRow(tx, `Deriva Dos ${tag}`, `deriva-dos-${tag}`);

      const report = await collectPlaceDrift(tx);

      expect(report.renamed.filter((g) => g.localityId === renamedId)).toEqual([
        {
          table: "govt_assignments",
          localityId: renamedId,
          storedName: `Deriva Uno ${tag}`,
          catalogueName: `Deriva Renombrada ${tag}`,
          method: null,
          rows: 1,
        },
      ]);

      const removed = report.removed.filter((r) => r.localityId === removedId);
      expect(removed).toHaveLength(1);
      expect(removed[0]).toMatchObject({
        localityName: `Deriva Dos ${tag}`,
        provinceCode: "AR-L",
        rowsByTable: { govt_assignments: 1 },
        activeMemberships: 1,
        successorCandidates: [
          { localityId: successorId, name: `Deriva Dos ${tag}`, department: "Depto Deriva" },
        ],
      });
      // A removed row is not reported as a rename too.
      expect(report.renamed.some((g) => g.localityId === removedId)).toBe(false);

      // Listing changed nothing: the grant still points at the removed id and
      // the membership is still open.
      const [still] = (await tx.execute(sql`
        select (select count(*)::int from public.govt_assignments
                 where locality_id = ${removedId}::uuid and revoked_at is null) as grants,
               (select count(*)::int from public.authority_unit_localities
                 where locality_id = ${removedId}::uuid and valid_to is null) as memberships
      `)) as unknown as Array<{ grants: number; memberships: number }>;
      expect(still).toEqual({ grants: 1, memberships: 1 });

      const lines = formatPlaceDrift(report).join("\n");
      expect(lines).toContain(`"Deriva Uno ${tag}" -> "Deriva Renombrada ${tag}"`);
      expect(lines).toContain(
        `successor candidates: Deriva Dos ${tag} (Depto Deriva) ${successorId}`,
      );
    });
  });
});

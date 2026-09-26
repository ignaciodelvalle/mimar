// CABA barrio -> comuna (localidades-por-id C5).
//
// The mapping comes from the official data.buenosaires.gob.ar resource,
// committed verbatim in lib/reference/caba-barrio-comunas.json and reconciled
// with the catalogue's spelling by lib/reference/caba-comunas.ts. This file
// holds:
//   1. the reference: 48 barrios, 15 comunas, the INDEC codes 02007 … 02105;
//   2. the reconciliation: every catalogue barrio matched to exactly one
//      source row, and a LOUD failure on any mismatch;
//   3. migration 0267's VALUES equal to that reconciliation, row for row;
//   4. the migration on the local catalogue (in a transaction that is rolled
//      back — the database is shared): every live barrio names its comuna, a
//      re-run changes nothing, an unknown barrio aborts it, and the seed then
//      proposes the 15 comunas as submunicipal units below the ciudad.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import raw from "@/lib/reference/caba-barrio-comunas.json";
import {
  COMUNA_COUNT,
  CURATED_PARTS,
  SOURCE_SPELLING,
  cabaComunas,
  reconcileCabaComunas,
} from "@/lib/reference/caba-comunas";
import { CABA_BARRIOS } from "@/scripts/caba-barrios-data";
import { slugify } from "@/scripts/import-caba-barrios";
import { applyAuthorityUnitPlan, planFromDatabase } from "@/scripts/seed-authority-units";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const NAMES = CABA_BARRIOS.map((b) => b.name);
const MIGRATION = readFileSync(
  join(process.cwd(), "db", "migrations", "0267_caba_barrio_comunas.sql"),
  "utf8",
);

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

describe("the committed official source", () => {
  it("carries 48 barrios over the 15 comunas, with provenance", () => {
    expect(raw.rows).toHaveLength(48);
    expect(new Set(raw.rows.map(([name]) => name)).size).toBe(48);
    expect(new Set(raw.rows.map(([, n]) => n))).toEqual(
      new Set(Array.from({ length: COMUNA_COUNT }, (_, i) => i + 1)),
    );
    expect(raw.source.file).toMatch(/^https:\/\/cdn\.buenosaires\.gob\.ar\//);
    expect(raw.source.license).toBe("CC-BY-2.5-AR");
    expect(raw.source.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(raw.source.fileSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("names each comuna by its INDEC department: Comuna n is 02000 + 7n", () => {
    const comunas = cabaComunas();
    expect(comunas.size).toBe(15);
    for (const [n, c] of comunas) {
      expect(c).toEqual({
        number: n,
        departmentCode: `02${String(7 * n).padStart(3, "0")}`,
        departmentName: `Comuna ${n}`,
      });
    }
  });
});

describe("reconcileCabaComunas", () => {
  it("maps every catalogue barrio to exactly one comuna, and every comuna has a barrio", () => {
    const map = reconcileCabaComunas(NAMES);
    expect([...map.keys()].sort()).toEqual([...NAMES].sort());
    expect(new Set([...map.values()].map((c) => c.number)).size).toBe(15);
  });

  it("resolves the three spelling differences explicitly, never by a fuzzy match", () => {
    const map = reconcileCabaComunas(NAMES);
    for (const [sourceName, catalogueName] of Object.entries(SOURCE_SPELLING)) {
      const row = raw.rows.find(([name]) => name === sourceName);
      expect(row, `${sourceName} is a source row`).toBeDefined();
      expect(map.get(catalogueName)?.number).toBe(row?.[1]);
    }
    // Two accent/case folds, anchored: the source writes them without accents.
    expect(map.get("Núñez")?.departmentName).toBe("Comuna 13");
    expect(map.get("Palermo")?.departmentCode).toBe("02098");
  });

  it("fails loudly when the catalogue lacks a barrio the source names", () => {
    expect(() => reconcileCabaComunas(NAMES.filter((n) => n !== "Palermo"))).toThrow(
      /"PALERMO" matches no catalogue barrio/,
    );
  });

  it("fails loudly when the catalogue has a barrio the source does not name", () => {
    expect(() => reconcileCabaComunas([...NAMES, "Palermo Soho"])).toThrow(
      /"Palermo Soho" has no source row/,
    );
  });

  it("fails loudly on a spelling it has not been told about", () => {
    const renamed = NAMES.map((n) => (n === "Villa General Mitre" ? "Villa Gral Mitre" : n));
    expect(() => reconcileCabaComunas(renamed)).toThrow(/"Villa Gral Mitre" has no source row/);
  });
});

describe("migration 0267", () => {
  it("writes exactly the reconciled mapping, plus the curated part rows", () => {
    const values = [...MIGRATION.matchAll(/\('([a-z0-9-]+)', '(\d{5})', '(Comuna \d+)'\)/g)].map(
      (m) => [m[1], m[2], m[3]] as const,
    );
    const map = reconcileCabaComunas(NAMES);
    const expected = [
      ...[...map].map(([name, c]) => [slugify(name), c.departmentCode, c.departmentName] as const),
      ...Object.entries(CURATED_PARTS).map(([part, parent]) => {
        const c = map.get(parent);
        return [slugify(part), c?.departmentCode ?? "", c?.departmentName ?? ""] as const;
      }),
    ];
    const byKey = (a: readonly string[], b: readonly string[]) =>
      (a[0] ?? "") < (b[0] ?? "") ? -1 : 1;
    expect([...values].sort(byKey)).toEqual([...expected].sort(byKey));
    expect(values).toHaveLength(49);
  });

  it("on the local catalogue: every live barrio names its comuna, and a re-run changes nothing", async () => {
    const map = reconcileCabaComunas(NAMES);
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql.raw(MIGRATION));
      const rows = (await tx.execute(sql`
        select locality_name as name, source, department_code as code, department_name as dept
          from public.ar_localities
         where province_code = 'AR-C' and removed_at is null
           and source in ('caba_open_data', 'manual')
         order by locality_name
      `)) as unknown as Array<{ name: string; source: string; code: string; dept: string }>;
      expect(rows.filter((r) => r.source === "caba_open_data")).toHaveLength(48);
      for (const r of rows) {
        const comuna = map.get(CURATED_PARTS[r.name] ?? r.name);
        expect({ name: r.name, code: r.code, dept: r.dept }).toEqual({
          name: r.name,
          code: comuna?.departmentCode,
          dept: comuna?.departmentName,
        });
      }

      await tx.execute(sql.raw(MIGRATION));
      const again = (await tx.execute(sql`
        select locality_name as name, source, department_code as code, department_name as dept
          from public.ar_localities
         where province_code = 'AR-C' and removed_at is null
           and source in ('caba_open_data', 'manual')
         order by locality_name
      `)) as unknown as typeof rows;
      expect(again).toEqual(rows);
    });
  });

  it("refuses to commit a catalogue with a barrio the official list does not name", async () => {
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql`
        insert into public.ar_localities
          (province_code, locality_name, locality_slug, category, source)
        values ('AR-C', 'Barrio Inventado', 'barrio-inventado', 'barrio', 'caba_open_data')
      `);
      let message = "";
      try {
        await tx.transaction(async (sp) => {
          await sp.execute(sql.raw(MIGRATION));
        });
      } catch (e) {
        let cur = e as { message?: string; cause?: unknown } | null;
        while (cur) {
          message += ` ${cur.message ?? ""}`;
          cur = (cur.cause as typeof cur) ?? null;
        }
      }
      expect(message).toMatch(
        /0267: live CABA barrio row\(s\) with no official comuna: Barrio Inventado/,
      );
    });
  });

  it("then the seed proposes the 15 comunas as submunicipal drafts below the ciudad", async () => {
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql.raw(MIGRATION));
      const plan = await planFromDatabase(tx);
      const comunas = plan.units.filter((u) => u.level === "submunicipal");
      expect(comunas).toHaveLength(15);
      expect(comunas.every((u) => u.kind === "comuna" && u.parentSeedKey === "ciudad:AR-C")).toBe(
        true,
      );
      // 48 barrios + Belgrano R, each in exactly one comuna.
      const members = comunas.flatMap((u) => u.localityIds);
      expect(members).toHaveLength(49);
      expect(new Set(members).size).toBe(49);

      await applyAuthorityUnitPlan(tx, plan);
      const units = (await tx.execute(sql`
        select u.name, u.status, p.seed_key as parent,
               count(m.id) filter (where m.valid_to is null)::int as members
          from public.authority_units u
          join public.authority_units p on p.id = u.parent_unit_id
          left join public.authority_unit_localities m on m.unit_id = u.id
         where u.seed_key like 'comuna:AR-C:%'
         group by u.id, p.seed_key
         order by u.indec_department_code
      `)) as unknown as Array<{ name: string; status: string; parent: string; members: number }>;
      expect(units.map((u) => u.name)).toEqual(
        Array.from({ length: 15 }, (_, i) => `Comuna ${i + 1}`),
      );
      expect(units.every((u) => u.status === "draft" && u.parent === "ciudad:AR-C")).toBe(true);
      expect(units.reduce((n, u) => n + u.members, 0)).toBe(49);

      // A barrio now reaches its comuna AND the ciudad (and the province).
      const levels = (await tx.execute(sql`
        select f.level from public.ar_localities l
         cross join lateral public.authority_units_for_place(l.id, 'AR-C') f
         where l.province_code = 'AR-C' and l.locality_slug = 'palermo' and l.removed_at is null
         order by f.level
      `)) as unknown as Array<{ level: string }>;
      expect(levels.map((r) => r.level)).toEqual(["municipal", "provincial", "submunicipal"]);
    });
  });
});

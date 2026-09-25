// Fence: where a row carries a catalogue id, its stored place names THAT row.
//
// localidades-por-id, place-identity + the audit's "missing entirely" list
// (§3, item 2). Four tables carry `locality_id` today (pets, welfare_reports,
// cases — migration 0147; govt_assignments — 0246), next to the display pair
// (jurisdiction_province, jurisdiction_locality) every decision still reads.
// The two are only worth anything together if they AGREE: an id whose
// catalogue row is Bragado's Mechita next to a pair a writer took from
// Alberti's is a row that will move to another municipality the day scope
// switches to ids, and nothing would say so.
//
// Two halves:
//   - the LIVE sweep over the local database: every row with an id, in every
//     table that has one, names that id's catalogue locality and province;
//   - the GATE: what `normalizeLocationForWrite` returns with an id is that
//     id's own name and province, for both modes that honour ids.
//
// Stage B (localidades-por-id B1, migration 0248) added `locality_id` and
// `place_method` to nine more tables; they are in the sweep. A third half
// checks the method against the id: `unresolved` exactly when there is none.

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/db";
import { normalizeLocationForWrite } from "@/lib/domain/location-normalize";
import { PROVINCES } from "@/lib/reference/ar-provincias";

/** Tables that carry both the display pair and `locality_id`. */
const TABLES_WITH_ID = [
  "pets",
  "welfare_reports",
  "cases",
  "govt_assignments",
  // migration 0248
  "organizations",
  "organization_coverage",
  "service_offerings",
  "govt_business_rules",
  "alert_subscriptions",
  "alert_firings",
  "foster_volunteers",
  "approval_requests",
  "custody_disputes",
] as const;

/** Tables that also record HOW the id was decided (0248). */
const TABLES_WITH_METHOD = TABLES_WITH_ID.filter((t) => t !== "govt_assignments");

type Disagreement = {
  id: string;
  province: string | null;
  locality: string | null;
  catalogue_province: string;
  catalogue_locality: string;
};

/** code → display name, as a VALUES list the sweep can join against. */
const provinceNames = sql.join(
  PROVINCES.map((p) => sql`(${p.code}, ${p.name})`),
  sql`, `,
);

async function disagreements(table: (typeof TABLES_WITH_ID)[number]): Promise<Disagreement[]> {
  const rows = await db.execute(sql`
    select t.id::text as id,
           t.jurisdiction_province as province,
           t.jurisdiction_locality as locality,
           p.name as catalogue_province,
           l.locality_name as catalogue_locality
      from ${sql.identifier(table)} t
      join public.ar_localities l on l.id = t.locality_id
      join (values ${provinceNames}) as p(code, name) on p.code = l.province_code
     where t.locality_id is not null
       and (t.jurisdiction_locality is distinct from l.locality_name
            or t.jurisdiction_province is distinct from p.name)
     limit 20
  `);
  return rows as unknown as Disagreement[];
}

describe("live sweep: a stored id and its stored pair name the same place", () => {
  for (const table of TABLES_WITH_ID) {
    it(`${table}: no row's id disagrees with its (province, locality)`, async () => {
      expect(await disagreements(table)).toEqual([]);
    });
  }
});

describe("live sweep: a recorded method agrees with the id", () => {
  for (const table of TABLES_WITH_METHOD) {
    it(`${table}: 'unresolved' exactly when there is no id`, async () => {
      const rows = (await db.execute(sql`
        select t.id::text as id, t.locality_id::text as locality_id, t.place_method
          from ${sql.identifier(table)} t
         where t.place_method is not null
           and (t.place_method = 'unresolved') = (t.locality_id is not null)
         limit 20
      `)) as unknown as Array<Record<string, string | null>>;
      expect(rows).toEqual([]);
    });
  }
});

describe("the write gate returns an id's own name and province", () => {
  // Real rows chosen for shape, not for meaning: a within-province homonym, a
  // cross-province homonym on each side, and a plain unique name.
  const SAMPLE_INDEC_IDS = ["06021030", "06112080", "06021060", "14042170", "06441030"];
  const byIndec = new Map<string, { id: string; name: string; provinceCode: string }>();

  beforeAll(async () => {
    const rows = (await db.execute(sql`
      select id::text as id, indec_id, locality_name as name, province_code
        from public.ar_localities
       where indec_id in (${sql.join(
         SAMPLE_INDEC_IDS.map((i) => sql`${i}`),
         sql`, `,
       )}) and removed_at is null
    `)) as unknown as Array<{ id: string; indec_id: string; name: string; province_code: string }>;
    for (const r of rows) {
      byIndec.set(r.indec_id, { id: r.id, name: r.name, provinceCode: r.province_code });
    }
    expect(byIndec.size, "every sampled INDEC row must exist").toBe(SAMPLE_INDEC_IDS.length);
  });

  for (const mode of ["strict", "soft"] as const) {
    it(`${mode}: every sampled id comes back under its own catalogue name and province`, async () => {
      for (const indecId of SAMPLE_INDEC_IDS) {
        const row = byIndec.get(indecId);
        if (!row) throw new Error(`missing fixture ${indecId}`);
        const province = PROVINCES.find((p) => p.code === row.provinceCode);
        const out = await normalizeLocationForWrite(
          {
            province: null,
            provinceCode: row.provinceCode,
            locality: row.name,
            localityIndecId: indecId,
            lat: null,
            lng: null,
            address: null,
          },
          { locality: mode },
        );
        expect(out, indecId).toMatchObject({
          province: province?.name,
          locality: row.name,
          localityId: row.id,
        });
      }
    });
  }
});

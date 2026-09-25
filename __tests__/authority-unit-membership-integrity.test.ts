// Fence (stub): every live locality belongs to exactly one active authority
// unit at municipal level, and no removed locality is silently still a member.
//
// localidades-por-id, authority-units (P3: always reach exactly the right
// authority). Today there is no authority unit at all: a municipality is N
// `govt_assignments` rows, one per INDEC locality, and a partido onboarded with
// 8 of its 9 localities routes the ninth's bites to national admins without a
// trace (R2 of the 2026-09-25 audit).
//
// RED UNTIL WORK UNIT C1 of localidades-por-id, which creates
// `authority_units` + `authority_unit_localities`. The known failure below
// queries them; C1 flips it to `it` and C2 (the seed) makes it meaningful.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";

describe("authority unit membership", () => {
  it("the catalogue this fence will sweep is populated", async () => {
    const rows = (await db.execute(sql`
      select count(*)::int as n from public.ar_localities where removed_at is null
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0]?.n).toBeGreaterThan(100);
  });

  // Known failure until work unit C1 (localidades-por-id): flip to `it` there.
  it.fails("every live locality is in exactly one active municipal-level unit", async () => {
    const rows = (await db.execute(sql`
      select l.id::text as id, count(m.unit_id)::int as units
        from public.ar_localities l
        left join public.authority_unit_localities m
          on m.locality_id = l.id and m.valid_to is null
       where l.removed_at is null
       group by l.id
      having count(m.unit_id) <> 1
       limit 20
    `)) as unknown as Array<{ id: string; units: number }>;
    expect(rows).toEqual([]);
  });
});

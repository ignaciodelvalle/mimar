// Fence (stub): every live locality belongs to exactly one active authority
// unit at municipal level, and no removed locality is silently still a member.
//
// localidades-por-id, authority-units (P3: always reach exactly the right
// authority). Today there is no authority unit at all: a municipality is N
// `govt_assignments` rows, one per INDEC locality, and a partido onboarded with
// 8 of its 9 localities routes the ninth's bites to national admins without a
// trace (R2 of the 2026-09-25 audit).
//
// RED UNTIL WORK UNIT C2 of localidades-por-id (the seed), NOT C1. C1 creates
// `authority_units` + `authority_unit_localities` empty, so every live
// locality is still in zero units and the assertion keeps failing; C2 fills
// the membership and flips the known failure below to `it`.
//
// The fence fails on its ASSERTION, never on "relation does not exist": while
// the membership table is absent, every live locality is counted as a member
// of zero units — which is the truth — and the same `toEqual([])` rejects it.

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

  // Known failure until work unit C2 (localidades-por-id): flip to `it` there.
  it.fails("every live locality is in exactly one active municipal-level unit", async () => {
    const [exists] = (await db.execute(sql`
      select to_regclass('public.authority_unit_localities') is not null as present
    `)) as unknown as Array<{ present: boolean }>;
    const rows = exists?.present
      ? ((await db.execute(sql`
          select l.id::text as id, count(m.unit_id)::int as units
            from public.ar_localities l
            left join public.authority_unit_localities m
              on m.locality_id = l.id and m.valid_to is null
           where l.removed_at is null
           group by l.id
          having count(m.unit_id) <> 1
           limit 20
        `)) as unknown as Array<{ id: string; units: number }>)
      : // No membership table yet: every live locality is in zero units.
        ((await db.execute(sql`
          select l.id::text as id, 0 as units
            from public.ar_localities l
           where l.removed_at is null
           limit 20
        `)) as unknown as Array<{ id: string; units: number }>);
    expect(rows).toEqual([]);
  });

  // Pins the branch above: today the fence fails on the membership assertion,
  // not on a missing relation. Delete this at C1 (the table then exists).
  it("today the membership table is absent and the fence reads zero units", async () => {
    const [exists] = (await db.execute(sql`
      select to_regclass('public.authority_unit_localities') is not null as present
    `)) as unknown as Array<{ present: boolean }>;
    expect(exists?.present).toBe(false);
  });
});

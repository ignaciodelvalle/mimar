// Fence: the historical backfill never gives an ambiguous name an id.
//
// R7 of the 2026-09-25 localities audit. `scripts/backfill-locality-id.ts`
// filled `pets/welfare_reports/cases.locality_id` from the stored NAME pair
// through `resolveCanonicalJurisdiction`, which settles a within-province
// homonym by taking the alphabetically first department. Every Bragado row
// named "Mechita" it touched now carries Alberti's id — a confidently wrong
// foreign key that nothing reads yet and that the day scope moves to ids would
// silently move to another municipality. Migration 0237 had already refused
// this exact move ("filling it from a display name would make the name a join
// key").
//
// The spec (place-identity, "Ambiguous historical row stays unresolved"):
// backfill leaves an ambiguous pair with `locality_id` NULL and queues it.
//
// RED UNTIL WORK UNIT B5 of localidades-por-id, which deletes the name-based
// backfill, re-derives ids from the spine and repairs what the old script
// wrote. The known failure below reads the resolver the script calls today.

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/db";
import { resolveCanonicalJurisdiction } from "@/lib/infra/jurisdiction-validation";
import { sql } from "drizzle-orm";

beforeAll(async () => {
  const rows = (await db.execute(sql`
    select count(*)::int as n
      from public.ar_localities
     where province_code = 'AR-B' and locality_name = 'Mechita' and removed_at is null
  `)) as unknown as Array<{ n: number }>;
  // The premise: Mechita is a within-province homonym in the local catalogue.
  expect(rows[0]?.n).toBe(2);
});

describe("backfill-locality-id's resolver and a within-province homonym", () => {
  // Known failure until work unit B5 (localidades-por-id): flip to `it` there.
  it.fails("refuses to name one of the two Mechitas from the name alone", async () => {
    await expect(
      resolveCanonicalJurisdiction({ rawProvince: "Buenos Aires", rawLocality: "Mechita" }),
    ).rejects.toThrow();
  });
});

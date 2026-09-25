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
// wrote. The known failure below is a PLACEHOLDER aimed at B5's entry point,
// `scripts/place-repair-homonym-ids.ts`, and states the contract B5 must meet:
//   - the old name-based `scripts/backfill-locality-id.ts` is gone;
//   - the new script exists and exports `resolveBackfillPlace({ province,
//     locality })`, which answers `{ localityId: null }` for an ambiguous pair.
// Every step is an assertion, so today it fails on "the entry point does not
// exist yet", never on an import error. B5 flips it to `it`.

import { existsSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/db";

const OLD_SCRIPT = path.join(process.cwd(), "scripts", "backfill-locality-id.ts");
const B5_ENTRY = path.join(process.cwd(), "scripts", "place-repair-homonym-ids.ts");

type BackfillEntry = {
  resolveBackfillPlace?: (pair: {
    province: string;
    locality: string;
  }) => Promise<{ localityId: string | null }>;
};

beforeAll(async () => {
  const rows = (await db.execute(sql`
    select count(*)::int as n
      from public.ar_localities
     where province_code = 'AR-B' and locality_name = 'Mechita' and removed_at is null
  `)) as unknown as Array<{ n: number }>;
  // The premise: Mechita is a within-province homonym in the local catalogue.
  expect(rows[0]?.n).toBe(2);
});

describe("the historical backfill and a within-province homonym", () => {
  // Known failure until work unit B5 (localidades-por-id): flip to `it` there.
  it.fails(
    "B5's backfill refuses to name one of the two Mechitas from the name alone",
    async () => {
      expect(existsSync(OLD_SCRIPT), "the name-based backfill is deleted").toBe(false);
      expect(existsSync(B5_ENTRY), "B5's entry point exists").toBe(true);
      const entry = (await import(/* @vite-ignore */ B5_ENTRY)) as BackfillEntry;
      expect(typeof entry.resolveBackfillPlace).toBe("function");
      const place = await entry.resolveBackfillPlace?.({
        province: "Buenos Aires",
        locality: "Mechita",
      });
      expect(place?.localityId).toBeNull();
    },
  );

  // Pins why the placeholder is red today: the old script is still here and
  // B5's entry point is not. Delete this at B5.
  it("today the name-based backfill still exists and B5's entry point does not", () => {
    expect(existsSync(OLD_SCRIPT)).toBe(true);
    expect(existsSync(B5_ENTRY)).toBe(false);
  });
});

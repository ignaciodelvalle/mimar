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
// Work unit B5 of localidades-por-id deleted the name-based backfill and put
// its replacement at `scripts/place-repair-homonym-ids.ts`:
//   - `resolveBackfillPlace({ province, locality })` gives a historical NAME an
//     id only when it names exactly one live row — `{ localityId: null }` for
//     a homonym;
//   - `decideRepair` audits an id already stored against what the record says
//     (the spine, the case's own events, the denuncia's `place_entered`), and
//     never trusts the old id as ground truth.

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
  it("B5's backfill refuses to name one of the two Mechitas from the name alone", async () => {
    expect(existsSync(OLD_SCRIPT), "the name-based backfill is deleted").toBe(false);
    expect(existsSync(B5_ENTRY), "B5's entry point exists").toBe(true);
    const entry = (await import(/* @vite-ignore */ B5_ENTRY)) as BackfillEntry;
    expect(typeof entry.resolveBackfillPlace).toBe("function");
    const place = await entry.resolveBackfillPlace?.({
      province: "Buenos Aires",
      locality: "Mechita",
    });
    expect(place?.localityId).toBeNull();
  });

  it("a name that names ONE row is given that row, and says how", async () => {
    const entry = (await import(/* @vite-ignore */ B5_ENTRY)) as BackfillEntry & {
      resolveBackfillPlace: (pair: { province: string; locality: string }) => Promise<{
        localityId: string | null;
        method: string;
      }>;
    };
    const rows = (await db.execute(sql`
      select id::text as id from public.ar_localities
       where indec_id = '14042170' and removed_at is null
    `)) as unknown as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(
      await entry.resolveBackfillPlace({ province: "Córdoba", locality: "Villa María" }),
    ).toEqual({ localityId: rows[0]?.id, method: "legacy_unique_name" });
  });
});

describe("the repair of ids the old backfill already wrote", () => {
  const ALBERTI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const BRAGADO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  type RepairEntry = {
    decideRepair: (
      storedId: string | null,
      recorded: string | null | undefined,
    ) => { verdict: string; localityId: string | null };
  };

  async function decide(storedId: string | null, recorded: string | null | undefined) {
    const entry = (await import(/* @vite-ignore */ B5_ENTRY)) as RepairEntry;
    return entry.decideRepair(storedId, recorded);
  }

  it("keeps an id the record agrees with", async () => {
    expect(await decide(BRAGADO, BRAGADO)).toEqual({ verdict: "keep", localityId: BRAGADO });
  });

  it("rewrites Alberti's guessed id to the Bragado row the record names", async () => {
    expect(await decide(ALBERTI, BRAGADO)).toEqual({ verdict: "rewrite", localityId: BRAGADO });
  });

  it("rewrites to no row when the record says nothing resolved", async () => {
    expect(await decide(ALBERTI, null)).toEqual({ verdict: "rewrite", localityId: null });
  });

  it("clears a guessed id the record is silent about — never trusts it", async () => {
    expect(await decide(ALBERTI, undefined)).toEqual({ verdict: "clear", localityId: null });
  });
});

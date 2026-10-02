// place-legacy-grants (localidades CABA + Córdoba, 2026-10, change C4): the
// read-only check names every active CABA/Córdoba grant that still matches by
// its locality NAME — and nothing else.
//
// Against the local database, inside ONE transaction that always rolls back
// (the database is shared by every worktree): a legacy Córdoba grant on a
// homonym is named; the same user's grant on a unit, a revoked grant and a
// legacy grant in another province are not.

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { UNIT_FIRST_PROVINCE_CODES, unitFirstProvinceCode } from "@/lib/place/unit-first-provinces";
import { describeLegacyGrants, findLegacyGrants } from "@/scripts/place-legacy-grants";

const client = postgres(
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  { max: 1, onnotice: () => {} },
);
afterAll(() => client.end({ timeout: 5 }));

class Rollback extends Error {}

describe("unitFirstProvinceCode", () => {
  it("names CABA and Córdoba by any spelling, and nothing else", () => {
    expect(UNIT_FIRST_PROVINCE_CODES).toEqual(["AR-C", "AR-X"]);
    expect(unitFirstProvinceCode("CABA")).toBe("AR-C");
    expect(unitFirstProvinceCode("Ciudad Autónoma de Buenos Aires")).toBe("AR-C");
    expect(unitFirstProvinceCode("cordoba")).toBe("AR-X");
    expect(unitFirstProvinceCode("AR-X")).toBe("AR-X");
    expect(unitFirstProvinceCode("Buenos Aires")).toBeNull();
    expect(unitFirstProvinceCode(null)).toBeNull();
  });
});

describe("findLegacyGrants", () => {
  it("names an active name-matched grant in CABA/Córdoba, and only that", async () => {
    let found: Awaited<ReturnType<typeof findLegacyGrants>> = [];
    let ids: Record<string, string> = {};
    await client
      .begin(async (tx) => {
        const userId = randomUUID();
        await tx`insert into auth.users (id, email) values (${userId}::uuid, ${`legacy-grants-${userId}@dim-test.local`})`;
        const [unit] = await tx<{ id: string }[]>`
          select id::text as id from public.authority_units where province_code = 'AR-X' limit 1`;
        const grant = async (
          code: string,
          locality: string,
          extra: { unit?: string; revoked?: boolean } = {},
        ) => {
          const [row] = await tx<{ id: string }[]>`
            insert into public.govt_assignments
              (user_id, jurisdiction_province, jurisdiction_locality, authority_unit_id, revoked_at)
            values (${userId}::uuid, public.ar_province_name(${code}), ${locality},
                    ${extra.unit ?? null}::uuid, ${extra.revoked ? new Date(0) : null})
            returning id::text as id`;
          return row.id;
        };
        ids = {
          legacyCordoba: await grant("AR-X", "San Pedro"),
          revokedCordoba: await grant("AR-X", "San Vicente", { revoked: true }),
          otherProvince: await grant("AR-B", "Tigre"),
          ...(unit ? { onUnit: await grant("AR-X", "La Puerta", { unit: unit.id }) } : {}),
        };
        // Non-vacuity: the local catalogue's seeded units exist, so the
        // "on a unit" grant is really exercised.
        expect(unit).toBeDefined();
        const all = await findLegacyGrants(tx as unknown as postgres.Sql);
        found = all.filter((g) => g.userId === userId);
        throw new Rollback();
      })
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });

    expect(found.map((g) => g.assignmentId)).toEqual([ids.legacyCordoba]);
    expect(found[0]).toMatchObject({ provinceCode: "AR-X", locality: "San Pedro" });
    expect(describeLegacyGrants(found)[0]).toContain("matches by name, not by unit");
  });
});

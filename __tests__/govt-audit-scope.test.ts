// Tests for lib/infra/govt-audit-scope.ts — jurisdiction-derived actor scope
// for /gob/historial (Wave C, gob-audit-inventory item 1).
//
// audit_log has no jurisdiction column, so "audit for MY jurisdiction" is
// derived from govt_assignments: which user ids currently hold an ACTIVE
// assignment matching the viewer's jurisdiction tuples. Covers:
//   1. Returns actor ids for a matching, active assignment.
//   2. Excludes a REVOKED assignment in the same jurisdiction.
//   3. Excludes an assignment in a DIFFERENT locality.
//   4. Returns [] immediately when `jurisdictions` is empty (no DB round-trip).
//   5. De-dupes a user with two active assignments matching two of the
//      queried jurisdictions (selectDistinct).

import { inArray, like, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, govtAssignments, profiles } from "@/db";
import { fetchJurisdictionActorIds } from "@/lib/infra/govt-audit-scope";

const TEST_PROVINCE = "Buenos Aires";
const TEST_LOCALITY = `govt-audit-scope-locality-${Date.now()}`;
const OTHER_LOCALITY = `govt-audit-scope-other-locality-${Date.now()}`;
const SECOND_LOCALITY = `govt-audit-scope-second-locality-${Date.now()}`;

async function makeProfile(displayName: string): Promise<string> {
  // profiles.id has no DB default (it mirrors auth.users.id in production) —
  // tests that don't need a real Supabase auth user supply their own uuid.
  const id = crypto.randomUUID();
  await db.insert(profiles).values({ id, role: "govt", displayName, accountType: "institutional" });
  return id;
}

const homonymUsers: string[] = [];

describe("fetchJurisdictionActorIds", () => {
  // The synthetic assignments this suite creates use localities (govt-audit-scope-*)
  // that do NOT resolve against ar_localities, so leaving them ACTIVE trips the
  // govt-assignments-locality-integrity fitness sweep (#758). Delete them by the
  // locality pattern — this also drains rows left by earlier interrupted runs.
  // Profiles are cleaned best-effort (they own no audit rows in this suite).
  afterAll(async () => {
    await db
      .delete(govtAssignments)
      .where(like(govtAssignments.jurisdictionLocality, "govt-audit-scope-%"));
    // The homonym case uses real catalogue names; its rows go by user id.
    if (homonymUsers.length > 0) {
      await db.delete(govtAssignments).where(inArray(govtAssignments.userId, homonymUsers));
    }
    await db
      .delete(profiles)
      .where(like(profiles.displayName, "govt-audit-scope%"))
      .catch(() => {});
  });

  it("returns [] without querying when jurisdictions is empty", async () => {
    expect(await fetchJurisdictionActorIds([])).toEqual([]);
  });

  it("returns the actor of an active assignment matching the jurisdiction", async () => {
    const activeUserId = await makeProfile("govt-audit-scope active");
    await db.insert(govtAssignments).values({
      userId: activeUserId,
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
    });

    const result = await fetchJurisdictionActorIds([
      { province: TEST_PROVINCE, locality: TEST_LOCALITY },
    ]);

    expect(result).toContain(activeUserId);
  });

  it("excludes a revoked assignment in the same jurisdiction", async () => {
    const revokedUserId = await makeProfile("govt-audit-scope revoked");
    await db.insert(govtAssignments).values({
      userId: revokedUserId,
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
      revokedAt: new Date(),
    });

    const result = await fetchJurisdictionActorIds([
      { province: TEST_PROVINCE, locality: TEST_LOCALITY },
    ]);

    expect(result).not.toContain(revokedUserId);
  });

  it("excludes an active assignment in a different locality", async () => {
    const otherUserId = await makeProfile("govt-audit-scope other-locality");
    await db.insert(govtAssignments).values({
      userId: otherUserId,
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: OTHER_LOCALITY,
    });

    const result = await fetchJurisdictionActorIds([
      { province: TEST_PROVINCE, locality: TEST_LOCALITY },
    ]);

    expect(result).not.toContain(otherUserId);
  });

  it("de-dupes a user matching two queried jurisdiction tuples", async () => {
    const dualUserId = await makeProfile("govt-audit-scope dual-jurisdiction");
    await db.insert(govtAssignments).values([
      {
        userId: dualUserId,
        jurisdictionProvince: TEST_PROVINCE,
        jurisdictionLocality: TEST_LOCALITY,
      },
      {
        userId: dualUserId,
        jurisdictionProvince: TEST_PROVINCE,
        jurisdictionLocality: SECOND_LOCALITY,
      },
    ]);

    const result = await fetchJurisdictionActorIds([
      { province: TEST_PROVINCE, locality: TEST_LOCALITY },
      { province: TEST_PROVINCE, locality: SECOND_LOCALITY },
    ]);

    expect(result.filter((id) => id === dualUserId)).toHaveLength(1);
  });

  // localidades-por-id verify S3: on the id path a unit grant's peers are the
  // operators granted a row of the unit, not everyone holding the same NAME.
  // Mechita (Alberti) and Mechita (Bragado) share the pair "Buenos Aires /
  // Mechita"; the Bragado unit's viewer must not count Alberti's operator.
  it("a unit grant on the id path matches peers by catalogue row, never a homonym", async () => {
    const ids = (await db.execute(sql`
      select indec_id, id::text as id from public.ar_localities
       where indec_id in ('06021030', '06112080') and removed_at is null
    `)) as unknown as Array<{ indec_id: string; id: string }>;
    const alberti = ids.find((r) => r.indec_id === "06021030")?.id;
    const bragado = ids.find((r) => r.indec_id === "06112080")?.id;
    expect(alberti && bragado, "both Mechita rows must be in the catalogue").toBeTruthy();

    const albertiPeer = await makeProfile("govt-audit-scope homonym alberti");
    const bragadoPeer = await makeProfile("govt-audit-scope homonym bragado");
    homonymUsers.push(albertiPeer, bragadoPeer);
    await db.insert(govtAssignments).values([
      {
        userId: albertiPeer,
        jurisdictionProvince: TEST_PROVINCE,
        jurisdictionLocality: "Mechita",
        localityId: alberti,
      },
      {
        userId: bragadoPeer,
        jurisdictionProvince: TEST_PROVINCE,
        jurisdictionLocality: "Mechita",
        localityId: bragado,
      },
    ]);

    const byUnit = await fetchJurisdictionActorIds([
      {
        province: TEST_PROVINCE,
        locality: "Mechita",
        place: { path: "locality", provinceCode: "AR-B", localityIds: [bragado as string] },
      },
    ]);
    expect(byUnit).toContain(bragadoPeer);
    expect(byUnit).not.toContain(albertiPeer);

    // A legacy grant (no place) keeps the name pair: both are its peers.
    const byName = await fetchJurisdictionActorIds([
      { province: TEST_PROVINCE, locality: "Mechita" },
    ]);
    expect(byName).toEqual(expect.arrayContaining([albertiPeer, bragadoPeer]));
  });
});

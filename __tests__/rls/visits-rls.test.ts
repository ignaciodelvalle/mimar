// RLS — public.visits (migration 0273, vet-visit-record).
//
// WHAT THIS DEFENDS
// -----------------
// A visit row says "this vet saw this pet at this clinic, at home or in the
// clinic, between these times". It is read by two kinds of caller and no one
// else: an active member of the visit's organization, and the pet's active
// titular. Every write is server-side over Drizzle (BYPASSRLS), so the
// PostgREST surface is SELECT-only.
//
// The membership branch goes through public.caller_is_active_org_member, a
// SECURITY DEFINER helper, because any policy that subqueries
// organization_memberships as `authenticated` hits that table's
// self-referential peers policy and raises "infinite recursion detected". The
// positive member probe below is what proves the helper route works at all.
//
// SHAPE: statements run the way PostgREST runs them — `SET LOCAL ROLE
// authenticated` with spoofed `request.jwt.claims`, inside a transaction that
// ends with the statement. Grants are read from the catalog, never probed by
// calling a function as a role that lacks EXECUTE. Every deny is paired with a
// positive control on the same row, so a policy that denies everybody cannot
// pass this file.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, visits } from "@/db";
import { pgErrorCode } from "@/lib/infra/db-errors";
import {
  type VisitFixtures,
  addMembership,
  addOwnership,
  insertVisit,
  makeOrg,
  makePet,
  makeProfile,
  newVisitFixtures,
  teardownVisitFixtures,
} from "../_helpers/visit-fixtures";

const fx: VisitFixtures = newVisitFixtures();

const ids = {
  owner: "",
  member: "",
  leftMember: "",
  otherOrgMember: "",
  exOwner: "",
  stranger: "",
  org: "",
  otherOrg: "",
  pet: "",
  visit: "",
};

async function asRole<T = Record<string, unknown>>(
  role: "authenticated" | "anon",
  userId: string | null,
  statement: ReturnType<typeof sql>,
): Promise<T[]> {
  return db.transaction(async (tx) => {
    const claims = userId ? { sub: userId, role } : { role };
    await tx.execute(sql`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`);
    await tx.execute(
      role === "anon" ? sql`SET LOCAL ROLE anon` : sql`SET LOCAL ROLE authenticated`,
    );
    return (await tx.execute(statement)) as unknown as T[];
  });
}

async function visibleVisitIds(userId: string): Promise<string[]> {
  const rows = await asRole<{ id: string }>(
    "authenticated",
    userId,
    sql`SELECT id::text AS id FROM public.visits WHERE pet_id = ${ids.pet}::uuid`,
  );
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  ids.owner = await makeProfile(fx, "titular");
  ids.member = await makeProfile(fx, "vet");
  ids.leftMember = await makeProfile(fx, "ex-miembro");
  ids.otherOrgMember = await makeProfile(fx, "otra-clinica");
  ids.exOwner = await makeProfile(fx, "ex-titular");
  ids.stranger = await makeProfile(fx, "extrano");

  ids.org = await makeOrg(fx, "A");
  ids.otherOrg = await makeOrg(fx, "B");
  await addMembership(ids.org, ids.member);
  await addMembership(ids.org, ids.leftMember, { left: true });
  await addMembership(ids.otherOrg, ids.otherOrgMember);

  ids.pet = await makePet(fx, "RLS");
  await addOwnership(ids.pet, ids.exOwner, { ended: true });
  await addOwnership(ids.pet, ids.owner);

  ids.visit = await insertVisit({
    petId: ids.pet,
    organizationId: ids.org,
    vetUserId: ids.member,
    modality: "clinic",
  });
});

afterAll(async () => {
  await teardownVisitFixtures(fx);
});

describe("visits — catalog shape", () => {
  it("RLS is enabled and the only policy is a SELECT TO authenticated", async () => {
    const [{ rls }] = (await db.execute(
      sql`SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'public.visits'::regclass`,
    )) as unknown as Array<{ rls: boolean }>;
    expect(rls).toBe(true);

    const policies = (await db.execute(sql`
      SELECT policyname, cmd, array_to_string(roles, ',') AS roles
        FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'visits'
    `)) as unknown as Array<{ policyname: string; cmd: string; roles: string }>;
    expect(policies).toEqual([
      {
        policyname: "visits read by org member or pet titular",
        cmd: "SELECT",
        roles: "authenticated",
      },
    ]);
  });

  it("anon holds no table privilege on visits", async () => {
    const [row] = (await db.execute(sql`
      SELECT has_table_privilege('anon', 'public.visits', 'SELECT') AS sel,
             has_table_privilege('anon', 'public.visits', 'INSERT') AS ins,
             has_table_privilege('anon', 'public.visits', 'UPDATE') AS upd,
             has_table_privilege('anon', 'public.visits', 'DELETE') AS del
    `)) as unknown as Array<{ sel: boolean; ins: boolean; upd: boolean; del: boolean }>;
    expect(row).toEqual({ sel: false, ins: false, upd: false, del: false });
  });

  it("the membership helper is a caller-only definer function, not executable by anon", async () => {
    const [row] = (await db.execute(sql`
      SELECT p.prosecdef AS definer,
             p.proconfig @> ARRAY['search_path=""'] AS pinned,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'caller_is_active_org_member'
    `)) as unknown as Array<{
      definer: boolean;
      pinned: boolean;
      anon_exec: boolean;
      auth_exec: boolean;
    }>;
    expect(row).toEqual({ definer: true, pinned: true, anon_exec: false, auth_exec: true });
  });

  it("pet_events has no INSERT policy for anon or authenticated (condition_at_intake_recorded included)", async () => {
    const rows = (await db.execute(sql`
      SELECT policyname
        FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'pet_events'
         AND cmd IN ('INSERT', 'ALL')
         AND (roles && ARRAY['anon', 'authenticated', 'public']::name[])
    `)) as unknown as Array<{ policyname: string }>;
    expect(rows).toEqual([]);
  });
});

describe("visits — reads", () => {
  it("POSITIVE: the pet's active titular reads the visit", async () => {
    expect(await visibleVisitIds(ids.owner)).toEqual([ids.visit]);
  });

  it("POSITIVE: an active member of the visit's organization reads it", async () => {
    expect(await visibleVisitIds(ids.member)).toEqual([ids.visit]);
  });

  it("NEGATIVE: a member of ANOTHER organization reads nothing", async () => {
    expect(await visibleVisitIds(ids.otherOrgMember)).toEqual([]);
  });

  it("NEGATIVE: a member who LEFT the organization reads nothing", async () => {
    expect(await visibleVisitIds(ids.leftMember)).toEqual([]);
  });

  it("NEGATIVE: a former titular (ended ownership) reads nothing", async () => {
    expect(await visibleVisitIds(ids.exOwner)).toEqual([]);
  });

  it("NEGATIVE: a stranger reads nothing", async () => {
    expect(await visibleVisitIds(ids.stranger)).toEqual([]);
  });

  it("NEGATIVE: anon is refused before any row is looked at", async () => {
    let code: string | null = null;
    let rows: unknown[] = [];
    try {
      rows = await asRole("anon", null, sql`SELECT id FROM public.visits`);
    } catch (err) {
      code = pgErrorCode(err) ?? "unknown";
    }
    expect(rows).toEqual([]);
    expect(code).toBe("42501");
  });
});

describe("visits — writes are closed to PostgREST", () => {
  it("an org member cannot INSERT a visit", async () => {
    let code: string | null = null;
    try {
      await asRole(
        "authenticated",
        ids.member,
        sql`INSERT INTO public.visits (pet_id, organization_id, vet_user_id)
            VALUES (${ids.pet}::uuid, ${ids.org}::uuid, ${ids.member}::uuid)`,
      );
    } catch (err) {
      code = pgErrorCode(err) ?? "unknown";
    }
    expect(code).toBe("42501");
  });

  it("an org member cannot UPDATE or DELETE the visit (zero rows, row unchanged)", async () => {
    for (const statement of [
      sql`UPDATE public.visits SET modality = 'home' WHERE id = ${ids.visit}::uuid RETURNING id`,
      sql`DELETE FROM public.visits WHERE id = ${ids.visit}::uuid RETURNING id`,
    ]) {
      let rows: unknown[] = [];
      try {
        rows = await asRole("authenticated", ids.member, statement);
      } catch (err) {
        expect(pgErrorCode(err)).toBe("42501");
      }
      expect(rows).toEqual([]);
    }
    const [row] = await db
      .select({ modality: visits.modality })
      .from(visits)
      .where(eq(visits.id, ids.visit));
    expect(row).toEqual({ modality: "clinic" });
  });
});

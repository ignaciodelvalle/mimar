// RLS — public.organizations and public.organization_coverage (0278 + 0280).
//
// WHAT THIS DEFENDS
// -----------------
// Until 0278, "Verified orgs are publicly readable" (0086) let anyone holding
// the publishable key read the WHOLE ROW of every verified organization over
// PostgREST: email, phone, CUIT, website and the coordinates — even with
// disclose_address = false, which for a rescue run from a home is a person's
// address. No app code reads organizations through PostgREST.
//
// 0278 tried to cut that at the GRANT (SELECT (id, verified)) under an anon
// row policy. scripts/deploy-provision.ts re-grants ALL on every public table
// after replaying the migrations, so on a freshly provisioned database the
// whole row was readable again. 0280 moves the guarantee to RLS: NO policy on
// organizations admits anon, and the organization_coverage policy asks the
// SECURITY DEFINER helper public.org_is_verified instead of sub-selecting
// organizations. This file therefore asserts the behaviour UNDER A
// RE-GRANTED TABLE — the provisioner's state — not the local grants.
//
// SHAPE: statements run the way PostgREST runs them — `SET LOCAL ROLE` with
// spoofed `request.jwt.claims`, inside a transaction. The re-grant probes run
// `GRANT ALL ... TO anon, authenticated` as the connection's own role FIRST,
// in the same transaction, and the transaction is always rolled back, so the
// grant never outlives the probe. Every deny is paired with a positive control
// on the same rows, so a migration that denied everybody could not pass.
//
// PRE-FLIGHT: local Supabase stack with 0278 and 0280 applied, .env.local
// loaded.

import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, organizationCoverage, organizations } from "@/db";
import { pgErrorCode } from "@/lib/infra/db-errors";
import {
  type VisitFixtures,
  addMembership,
  makeProfile,
  newVisitFixtures,
  teardownVisitFixtures,
} from "../_helpers/visit-fixtures";

const fx: VisitFixtures = newVisitFixtures();

const ids = {
  verifiedOrg: "",
  unverifiedOrg: "",
  member: "",
  stranger: "",
};

type Role = "anon" | "authenticated";

/** Thrown to force the rollback of a probe transaction; carries its result. */
class Rollback<T> extends Error {
  constructor(readonly result: T) {
    super("rollback");
  }
}

/**
 * Run `statement` as `role`, optionally after the provisioner's blanket
 * re-grant (applied as the connection's role, inside the transaction). The
 * transaction is ALWAYS rolled back.
 */
async function asRole<T = Record<string, unknown>>(
  role: Role,
  userId: string | null,
  statement: ReturnType<typeof sql>,
  opts: { regrant?: boolean } = {},
): Promise<T[]> {
  try {
    await db.transaction(async (tx) => {
      if (opts.regrant) {
        await tx.execute(
          sql`GRANT ALL ON public.organizations, public.organization_coverage TO anon, authenticated`,
        );
      }
      const claims = userId ? { sub: userId, role } : { role };
      await tx.execute(
        sql`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`,
      );
      await tx.execute(
        role === "anon" ? sql`SET LOCAL ROLE anon` : sql`SET LOCAL ROLE authenticated`,
      );
      throw new Rollback((await tx.execute(statement)) as unknown as T[]);
    });
  } catch (err) {
    if (err instanceof Rollback) return err.result as T[];
    throw err;
  }
  throw new Error("unreachable: the probe transaction must roll back");
}

async function errorCodeAs(
  role: Role,
  userId: string | null,
  statement: ReturnType<typeof sql>,
  opts: { regrant?: boolean } = {},
): Promise<{ code: string | null; rows: unknown[] }> {
  try {
    const rows = await asRole(role, userId, statement, opts);
    return { code: null, rows };
  } catch (err) {
    return { code: pgErrorCode(err) ?? "unknown", rows: [] };
  }
}

function fixtureOrgIds() {
  return sql`ARRAY[${ids.verifiedOrg}::uuid, ${ids.unverifiedOrg}::uuid]`;
}

async function visibleOrgRows(
  role: Role,
  userId: string | null,
  opts: { regrant?: boolean } = {},
): Promise<Array<Record<string, unknown>>> {
  return asRole(
    role,
    userId,
    sql`SELECT * FROM public.organizations WHERE id = ANY(${fixtureOrgIds()})`,
    opts,
  );
}

async function visibleCoverageOrgIds(
  role: Role,
  userId: string | null,
  opts: { regrant?: boolean } = {},
): Promise<string[]> {
  const rows = await asRole<{ organization_id: string }>(
    role,
    userId,
    sql`SELECT organization_id::text AS organization_id FROM public.organization_coverage
         WHERE organization_id = ANY(${fixtureOrgIds()})`,
    opts,
  );
  return rows.map((r) => r.organization_id).sort();
}

async function makeOrgRow(label: string, verified: boolean): Promise<string> {
  const lower = `${label}-${fx.suffix}`.toLowerCase();
  const [row] = await db
    .insert(organizations)
    .values({
      publicToken: `ORG-RLS-${fx.suffix}-${label}`,
      legalName: `Rescate ${label} ${fx.suffix}`,
      displayName: `Rescate ${label} ${fx.suffix}`,
      orgType: "rescue_network",
      email: `rls-${lower}@example.test`,
      phone: "+54 11 5555-0000",
      cuit: `30-${fx.suffix}-${label}`,
      website: "https://example.test",
      verified,
      verifiedAt: verified ? new Date() : null,
      // A rescue run from a home: the coordinates are a person's address and
      // the org asked for them NOT to be shown.
      discloseAddress: false,
      locationLat: "-34.6037000",
      locationLng: "-58.3816000",
      jurisdictionProvince: "CABA",
    })
    .returning({ id: organizations.id });
  fx.orgIds.push(row.id);
  await db.insert(organizationCoverage).values({
    organizationId: row.id,
    jurisdictionProvince: "CABA",
    jurisdictionLocality: `Barrio ${label} ${fx.suffix}`,
  });
  return row.id;
}

beforeAll(async () => {
  ids.member = await makeProfile(fx, "org-miembro");
  ids.stranger = await makeProfile(fx, "org-extrano");
  ids.verifiedOrg = await makeOrgRow("V", true);
  ids.unverifiedOrg = await makeOrgRow("U", false);
  await addMembership(ids.unverifiedOrg, ids.member);
});

afterAll(async () => {
  await teardownVisitFixtures(fx);
});

describe("organizations — catalog shape (0280)", () => {
  it("the only policy on organizations is the member SELECT; none admits anon or PUBLIC", async () => {
    const rows = (await db.execute(sql`
      SELECT policyname, cmd, array_to_string(roles, ',') AS roles,
             coalesce(qual, '') LIKE '%caller_is_active_org_member(%' AS via_helper
        FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'organizations'
       ORDER BY policyname
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      {
        policyname: "Members can read their own org",
        cmd: "SELECT",
        roles: "authenticated",
        via_helper: true,
      },
    ]);
  });

  it("the coverage policies ask helpers and never read the organizations table", async () => {
    const rows = (await db.execute(sql`
      SELECT policyname, array_to_string(roles, ',') AS roles,
             coalesce(qual, '') ~ '\\morganizations\\M' AS reads_organizations,
             coalesce(qual, '') LIKE '%org_is_verified(%' AS via_org_is_verified,
             coalesce(qual, '') LIKE '%organization_memberships%' AS recursive
        FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'organization_coverage'
       ORDER BY policyname
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      {
        policyname: "Coverage readable when parent org is verified",
        roles: "anon,authenticated",
        reads_organizations: false,
        via_org_is_verified: true,
        recursive: false,
      },
      {
        policyname: "Members can read their org coverage",
        roles: "authenticated",
        reads_organizations: false,
        via_org_is_verified: false,
        recursive: false,
      },
    ]);
  });

  it("org_is_verified is a definer function with a pinned search_path, executable by anon", async () => {
    const [row] = (await db.execute(sql`
      SELECT p.prosecdef AS definer,
             p.proconfig @> ARRAY['search_path=""'] AS pinned,
             p.provolatile::text AS volatility,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'org_is_verified'
    `)) as unknown as Array<Record<string, unknown>>;
    expect(row).toEqual({ definer: true, pinned: true, volatility: "s", anon_exec: true });
  });
});

describe("organizations — the leak stays closed under a re-granted table (provisioner state)", () => {
  it("NEGATIVE: anon holding table-level SELECT reads ZERO rows, verified org included", async () => {
    expect(await visibleOrgRows("anon", null, { regrant: true })).toEqual([]);
  });

  it("NEGATIVE: an authenticated stranger holding table-level SELECT reads zero rows", async () => {
    expect(await visibleOrgRows("authenticated", ids.stranger, { regrant: true })).toEqual([]);
  });

  it("POSITIVE: a member holding table-level SELECT reads their own org, and only it", async () => {
    const rows = await visibleOrgRows("authenticated", ids.member, { regrant: true });
    expect(rows.map((r) => r.id)).toEqual([ids.unverifiedOrg]);
  });

  it("POSITIVE: under the re-grant anon still reads coverage of the verified org only", async () => {
    expect(await visibleCoverageOrgIds("anon", null, { regrant: true })).toEqual([ids.verifiedOrg]);
  });

  it("the re-grant probe really grants (non-vacuity): the transaction saw SELECT on organizations", async () => {
    const rows = await asRole<{ sel: boolean }>(
      "anon",
      null,
      sql`SELECT has_table_privilege('public.organizations', 'SELECT') AS sel`,
      { regrant: true },
    );
    expect(rows).toEqual([{ sel: true }]);
  });
});

describe("organizations — local grants (0278) still refuse the private columns", () => {
  it("NEGATIVE: every contact / location column is refused to anon on the verified org", async () => {
    for (const col of ["email", "phone", "cuit", "location_lat", "location_lng"]) {
      const { code, rows } = await errorCodeAs(
        "anon",
        null,
        sql`SELECT ${sql.identifier(col)} FROM public.organizations WHERE id = ${ids.verifiedOrg}::uuid`,
      );
      // 42501 from the 0278 column grant, or zero rows from RLS (0280) — never
      // the value.
      expect(rows, col).toEqual([]);
      expect([null, "42501"], col).toContain(code);
    }
  });

  it("NEGATIVE: without a re-grant anon reads no row of organizations at all", async () => {
    const { rows } = await errorCodeAs(
      "anon",
      null,
      sql`SELECT id FROM public.organizations WHERE id = ANY(${fixtureOrgIds()})`,
    );
    expect(rows).toEqual([]);
  });
});

describe("organizations — writes are closed to PostgREST", () => {
  for (const [role, who] of [
    ["anon", "anon"],
    ["authenticated", "member"],
  ] as const) {
    it(`${who} cannot INSERT, UPDATE or DELETE organizations, even with a re-granted table`, async () => {
      const userId = role === "anon" ? null : ids.member;
      for (const regrant of [false, true]) {
        const insert = await errorCodeAs(
          role,
          userId,
          sql`INSERT INTO public.organizations (public_token, legal_name, display_name, org_type, email)
              VALUES (${`ORG-RLS-${fx.suffix}-X`}, 'x', 'x', 'shelter', 'x@example.test')`,
          { regrant },
        );
        expect(insert.code).toBe("42501");
        for (const statement of [
          sql`UPDATE public.organizations SET verified = true WHERE id = ${ids.unverifiedOrg}::uuid RETURNING id`,
          sql`DELETE FROM public.organizations WHERE id = ${ids.unverifiedOrg}::uuid RETURNING id`,
        ]) {
          const { code, rows } = await errorCodeAs(role, userId, statement, { regrant });
          // Without the grant: 42501. With it: RLS has no write policy, so the
          // statement touches zero rows.
          expect(rows).toEqual([]);
          expect([null, "42501"]).toContain(code);
        }
      }
      const [row] = await db
        .select({ verified: organizations.verified })
        .from(organizations)
        .where(inArray(organizations.id, [ids.unverifiedOrg]));
      expect(row).toEqual({ verified: false });
    });
  }
});

describe("the legitimate caller-role read paths still work", () => {
  it("POSITIVE: anon reads the coverage of the verified org, not of the unverified one", async () => {
    expect(await visibleCoverageOrgIds("anon", null)).toEqual([ids.verifiedOrg]);
  });

  it("POSITIVE: an authenticated stranger reads verified coverage (no recursion error)", async () => {
    expect(await visibleCoverageOrgIds("authenticated", ids.stranger)).toEqual([ids.verifiedOrg]);
  });

  it("POSITIVE: a member reads their own UNVERIFIED org's coverage, plus the verified one", async () => {
    expect(await visibleCoverageOrgIds("authenticated", ids.member)).toEqual(
      [ids.verifiedOrg, ids.unverifiedOrg].sort(),
    );
  });
});

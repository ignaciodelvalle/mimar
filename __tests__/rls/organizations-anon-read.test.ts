// RLS — public.organizations and public.organization_coverage (migration 0278).
//
// WHAT THIS DEFENDS
// -----------------
// Until 0278, "Verified orgs are publicly readable" (0086) let anyone holding
// the publishable key read the WHOLE ROW of every verified organization over
// PostgREST: email, phone, CUIT, website and the coordinates — even with
// disclose_address = false, which for a rescue run from a home is a person's
// address. No app code reads organizations through PostgREST; the only
// caller-role reader is the organization_coverage policy, which sub-selects
// `o.id` and `o.verified`.
//
// 0278 cuts the surface at the GRANT, because a policy chooses rows and cannot
// hide columns: anon and authenticated keep SELECT on (id, verified) and
// nothing else, the broad policy becomes "Verified org ids are publicly
// readable", and the two member policies go through
// public.caller_is_active_org_member (they used to recurse into
// organization_memberships' peers policy, which made EVERY authenticated read
// of either table raise).
//
// SHAPE: statements run the way PostgREST runs them — `SET LOCAL ROLE` with
// spoofed `request.jwt.claims`, inside a transaction that ends with the
// statement (same helper shape as visits-rls.test.ts). Every deny is paired
// with a positive control on the same rows, so a migration that denied
// everybody could not pass this file.
//
// PRE-FLIGHT: local Supabase stack with 0278 applied, .env.local loaded.

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

/** The only columns a caller role may read on organizations after 0278. */
const PUBLIC_COLUMNS = ["id", "verified"] as const;

type Role = "anon" | "authenticated";

async function asRole<T = Record<string, unknown>>(
  role: Role,
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

/** Run as a role and return the pg error code, or null if it succeeded. */
async function errorCodeAs(
  role: Role,
  userId: string | null,
  statement: ReturnType<typeof sql>,
): Promise<{ code: string | null; rows: unknown[] }> {
  try {
    const rows = await asRole(role, userId, statement);
    return { code: null, rows };
  } catch (err) {
    return { code: pgErrorCode(err) ?? "unknown", rows: [] };
  }
}

function fixtureOrgIds() {
  return sql`ARRAY[${ids.verifiedOrg}::uuid, ${ids.unverifiedOrg}::uuid]`;
}

async function visibleOrgIds(role: Role, userId: string | null): Promise<string[]> {
  const rows = await asRole<{ id: string }>(
    role,
    userId,
    sql`SELECT id::text AS id FROM public.organizations
         WHERE id = ANY(${fixtureOrgIds()}) ORDER BY id`,
  );
  return rows.map((r) => r.id).sort();
}

async function visibleCoverageOrgIds(role: Role, userId: string | null): Promise<string[]> {
  const rows = await asRole<{ organization_id: string }>(
    role,
    userId,
    sql`SELECT organization_id::text AS organization_id FROM public.organization_coverage
         WHERE organization_id = ANY(${fixtureOrgIds()})`,
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

describe("organizations — catalog shape (0278)", () => {
  it("anon and authenticated hold NO table-level privilege on organizations", async () => {
    const rows = (await db.execute(sql`
      SELECT r AS role, p AS privilege
        FROM unnest(ARRAY['anon', 'authenticated']) AS r
        CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
       WHERE has_table_privilege(r, 'public.organizations', p)
    `)) as unknown as Array<{ role: string; privilege: string }>;
    expect(rows).toEqual([]);
  });

  it("their only column privilege is SELECT on (id, verified)", async () => {
    const rows = (await db.execute(sql`
      SELECT r AS role, a.attname::text AS col, p AS privilege
        FROM pg_attribute a
        CROSS JOIN unnest(ARRAY['anon', 'authenticated']) AS r
        CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p
       WHERE a.attrelid = 'public.organizations'::regclass
         AND a.attnum > 0 AND NOT a.attisdropped
         AND has_column_privilege(r, a.attrelid, a.attnum, p)
       ORDER BY 1, 2, 3
    `)) as unknown as Array<{ role: string; col: string; privilege: string }>;
    expect(rows).toEqual([
      { role: "anon", col: "id", privilege: "SELECT" },
      { role: "anon", col: "verified", privilege: "SELECT" },
      { role: "authenticated", col: "id", privilege: "SELECT" },
      { role: "authenticated", col: "verified", privilege: "SELECT" },
    ]);
  });

  it("the policies are the four 0278 leaves, and none sub-selects organization_memberships", async () => {
    const rows = (await db.execute(sql`
      SELECT tablename, policyname, cmd, array_to_string(roles, ',') AS roles,
             coalesce(qual, '') LIKE '%organization_memberships%' AS recursive
        FROM pg_policies
       WHERE schemaname = 'public' AND tablename IN ('organizations', 'organization_coverage')
       ORDER BY tablename, policyname
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      {
        tablename: "organization_coverage",
        policyname: "Coverage readable when parent org is verified",
        cmd: "SELECT",
        roles: "anon,authenticated",
        recursive: false,
      },
      {
        tablename: "organization_coverage",
        policyname: "Members can read their org coverage",
        cmd: "SELECT",
        roles: "authenticated",
        recursive: false,
      },
      {
        tablename: "organizations",
        policyname: "Members can read their own org",
        cmd: "SELECT",
        roles: "authenticated",
        recursive: false,
      },
      {
        tablename: "organizations",
        policyname: "Verified org ids are publicly readable",
        cmd: "SELECT",
        roles: "anon,authenticated",
        recursive: false,
      },
    ]);
  });

  it("organization_coverage keeps SELECT and carries no caller-role write grant", async () => {
    const rows = (await db.execute(sql`
      SELECT r AS role, p AS privilege, has_table_privilege(r, 'public.organization_coverage', p) AS held
        FROM unnest(ARRAY['anon', 'authenticated']) AS r
        CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
       ORDER BY 1, 2
    `)) as unknown as Array<{ role: string; privilege: string; held: boolean }>;
    const held = rows.filter((r) => r.held).map((r) => `${r.role}:${r.privilege}`);
    expect(held).toEqual(["anon:SELECT", "authenticated:SELECT"]);
  });
});

describe("organizations — anon reads (the leak 0278 closes)", () => {
  it("POSITIVE: anon reads (id, verified) of the verified org, and only of it", async () => {
    expect(await visibleOrgIds("anon", null)).toEqual([ids.verifiedOrg]);
  });

  it("NEGATIVE: `select *` as anon is refused (what PostgREST sends for ?select=*)", async () => {
    const { code, rows } = await errorCodeAs(
      "anon",
      null,
      sql`SELECT * FROM public.organizations WHERE id = ${ids.verifiedOrg}::uuid`,
    );
    expect(rows).toEqual([]);
    expect(code).toBe("42501");
  });

  it("NEGATIVE: every column outside (id, verified) is refused to anon, one by one", async () => {
    const columns = (await db.execute(sql`
      SELECT attname::text AS col FROM pg_attribute
       WHERE attrelid = 'public.organizations'::regclass AND attnum > 0 AND NOT attisdropped
       ORDER BY attnum
    `)) as unknown as Array<{ col: string }>;
    const privateColumns = columns
      .map((c) => c.col)
      .filter((c) => !(PUBLIC_COLUMNS as readonly string[]).includes(c));

    // Non-vacuity: the leak was about these, so they must be in the sweep.
    expect(privateColumns).toEqual(
      expect.arrayContaining([
        "email",
        "phone",
        "cuit",
        "website",
        "location_lat",
        "location_lng",
        "personeria_juridica_number",
      ]),
    );

    const readable: string[] = [];
    for (const col of privateColumns) {
      const { code } = await errorCodeAs(
        "anon",
        null,
        sql`SELECT ${sql.identifier(col)} FROM public.organizations WHERE id = ${ids.verifiedOrg}::uuid`,
      );
      if (code !== "42501") readable.push(`${col} (${code ?? "read OK"})`);
    }
    expect(readable, "columns anon can still read on a verified org").toEqual([]);
  });

  it("NEGATIVE: an authenticated stranger cannot read the verified org's contact or location either", async () => {
    for (const col of ["email", "phone", "cuit", "location_lat", "location_lng"]) {
      const { code } = await errorCodeAs(
        "authenticated",
        ids.stranger,
        sql`SELECT ${sql.identifier(col)} FROM public.organizations WHERE id = ${ids.verifiedOrg}::uuid`,
      );
      expect(code, col).toBe("42501");
    }
  });
});

describe("organizations — writes are closed to PostgREST", () => {
  for (const [role, who] of [
    ["anon", "anon"],
    ["authenticated", "member"],
  ] as const) {
    it(`${who} cannot INSERT, UPDATE, DELETE or TRUNCATE organizations`, async () => {
      const userId = role === "anon" ? null : ids.member;
      const statements = [
        sql`INSERT INTO public.organizations (public_token, legal_name, display_name, org_type, email)
            VALUES (${`ORG-RLS-${fx.suffix}-X`}, 'x', 'x', 'shelter', 'x@example.test')`,
        sql`UPDATE public.organizations SET verified = true WHERE id = ${ids.unverifiedOrg}::uuid`,
        sql`DELETE FROM public.organizations WHERE id = ${ids.unverifiedOrg}::uuid`,
        sql`TRUNCATE public.organizations CASCADE`,
      ];
      for (const statement of statements) {
        const { code } = await errorCodeAs(role, userId, statement);
        expect(code).toBe("42501");
      }
      const [row] = await db
        .select({ verified: organizations.verified })
        .from(organizations)
        .where(inArray(organizations.id, [ids.unverifiedOrg]));
      expect(row).toEqual({ verified: false });
    });
  }

  it("anon cannot INSERT, UPDATE or DELETE organization_coverage", async () => {
    for (const statement of [
      sql`INSERT INTO public.organization_coverage (organization_id, jurisdiction_province)
          VALUES (${ids.verifiedOrg}::uuid, 'CABA')`,
      sql`UPDATE public.organization_coverage SET is_primary = true
           WHERE organization_id = ${ids.verifiedOrg}::uuid`,
      sql`DELETE FROM public.organization_coverage WHERE organization_id = ${ids.verifiedOrg}::uuid`,
    ]) {
      const { code } = await errorCodeAs("anon", null, statement);
      expect(code).toBe("42501");
    }
  });
});

describe("the legitimate caller-role read paths still work", () => {
  it("POSITIVE: anon reads the coverage of the verified org, not of the unverified one", async () => {
    expect(await visibleCoverageOrgIds("anon", null)).toEqual([ids.verifiedOrg]);
  });

  it("POSITIVE: an authenticated stranger reads verified coverage (no recursion error any more)", async () => {
    expect(await visibleCoverageOrgIds("authenticated", ids.stranger)).toEqual([ids.verifiedOrg]);
  });

  it("POSITIVE: a member reads their own UNVERIFIED org's coverage, plus the verified one", async () => {
    expect(await visibleCoverageOrgIds("authenticated", ids.member)).toEqual(
      [ids.verifiedOrg, ids.unverifiedOrg].sort(),
    );
  });

  it("POSITIVE: a member reads their own unverified org's (id, verified); a stranger does not", async () => {
    expect(await visibleOrgIds("authenticated", ids.member)).toEqual(
      [ids.verifiedOrg, ids.unverifiedOrg].sort(),
    );
    expect(await visibleOrgIds("authenticated", ids.stranger)).toEqual([ids.verifiedOrg]);
  });
});

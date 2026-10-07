// RLS — public.service_offerings (migration 0279).
//
// WHAT THIS DEFENDS
// -----------------
// Until 0279, "service_offerings read approved publicly" (0086) handed anyone
// holding the publishable key the WHOLE ROW of every approved offering:
// provider_user_id, reviewed_by_user_id / reviewed_at and rejection_reason
// among it. No app code reads service_offerings through PostgREST — the
// catalogue, search and booking are server-rendered over Drizzle — so 0279
// leaves anon with nothing, and authenticated with SELECT on (id,
// organization_id, provider_user_id): exactly what the appointments and
// service_schedule_rules policies sub-select.
//
// The org-member policy now goes through public.caller_is_active_org_member;
// its direct subquery on organization_memberships recursed into that table's
// peers policy, so every authenticated read raised. The positive member probe
// below is what proves the helper route works.
//
// SHAPE: same as visits-rls.test.ts — `SET LOCAL ROLE` with spoofed
// `request.jwt.claims` inside a transaction that ends with the statement.
// Every deny is paired with a positive control on the same rows.
//
// PRE-FLIGHT: local Supabase stack with 0279 applied, .env.local loaded.

import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, serviceOfferings } from "@/db";
import { pgErrorCode } from "@/lib/infra/db-errors";
import {
  type VisitFixtures,
  addMembership,
  makeOrg,
  makeProfile,
  newVisitFixtures,
  teardownVisitFixtures,
} from "../_helpers/visit-fixtures";

const fx: VisitFixtures = newVisitFixtures();
const offeringIds: string[] = [];

const ids = {
  provider: "",
  reviewer: "",
  member: "",
  stranger: "",
  org: "",
  providerOffering: "",
  orgOffering: "",
};

/** The only columns a caller role may read after 0279 — authenticated only. */
const AUTHENTICATED_COLUMNS = ["id", "organization_id", "provider_user_id"] as const;

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

function fixtureOfferingIds() {
  return sql`ARRAY[${ids.providerOffering}::uuid, ${ids.orgOffering}::uuid]`;
}

async function visibleOfferingIds(userId: string): Promise<string[]> {
  const rows = await asRole<{ id: string }>(
    "authenticated",
    userId,
    sql`SELECT id::text AS id FROM public.service_offerings WHERE id = ANY(${fixtureOfferingIds()})`,
  );
  return rows.map((r) => r.id).sort();
}

async function makeOffering(
  label: string,
  owner: { organizationId: string } | { providerUserId: string },
): Promise<string> {
  const [row] = await db
    .insert(serviceOfferings)
    .values({
      publicToken: `OFR-RLS-${fx.suffix}-${label}`,
      ...owner,
      serviceKind: "vaccination",
      displayName: `Vacunacion ${label} ${fx.suffix}`,
      // Approved and reviewed: exactly the rows the 0086 policy handed anon.
      status: "approved",
      reviewedAt: new Date(),
      reviewedByUserId: ids.reviewer,
      rejectionReason: `Motivo interno ${fx.suffix}`,
    })
    .returning({ id: serviceOfferings.id });
  offeringIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  ids.provider = await makeProfile(fx, "so-proveedor");
  ids.reviewer = await makeProfile(fx, "so-revisor");
  ids.member = await makeProfile(fx, "so-miembro");
  ids.stranger = await makeProfile(fx, "so-extrano");
  ids.org = await makeOrg(fx, "SO");
  await addMembership(ids.org, ids.member);
  ids.providerOffering = await makeOffering("P", { providerUserId: ids.provider });
  ids.orgOffering = await makeOffering("O", { organizationId: ids.org });
});

afterAll(async () => {
  if (offeringIds.length > 0) {
    await db.delete(serviceOfferings).where(inArray(serviceOfferings.id, offeringIds));
  }
  await teardownVisitFixtures(fx);
});

describe("service_offerings — catalog shape (0279)", () => {
  it("anon and authenticated hold NO table-level privilege", async () => {
    const rows = (await db.execute(sql`
      SELECT r AS role, p AS privilege
        FROM unnest(ARRAY['anon', 'authenticated']) AS r
        CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p
       WHERE has_table_privilege(r, 'public.service_offerings', p)
    `)) as unknown as Array<{ role: string; privilege: string }>;
    expect(rows).toEqual([]);
  });

  it("anon holds no column privilege; authenticated holds SELECT on the three sub-selected columns", async () => {
    const rows = (await db.execute(sql`
      SELECT r AS role, a.attname::text AS col, p AS privilege
        FROM pg_attribute a
        CROSS JOIN unnest(ARRAY['anon', 'authenticated']) AS r
        CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p
       WHERE a.attrelid = 'public.service_offerings'::regclass
         AND a.attnum > 0 AND NOT a.attisdropped
         AND has_column_privilege(r, a.attrelid, a.attnum, p)
       ORDER BY 1, 2, 3
    `)) as unknown as Array<{ role: string; col: string; privilege: string }>;
    expect(rows).toEqual(
      [...AUTHENTICATED_COLUMNS].sort().map((col) => ({
        role: "authenticated",
        col,
        privilege: "SELECT",
      })),
    );
  });

  it("the policies are the provider and org-member SELECTs, TO authenticated, non-recursive", async () => {
    const rows = (await db.execute(sql`
      SELECT policyname, cmd, array_to_string(roles, ',') AS roles,
             coalesce(qual, '') LIKE '%organization_memberships%' AS recursive
        FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'service_offerings'
       ORDER BY policyname
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      {
        policyname: "service_offerings read by org members",
        cmd: "SELECT",
        roles: "authenticated",
        recursive: false,
      },
      {
        policyname: "service_offerings read by provider vet",
        cmd: "SELECT",
        roles: "authenticated",
        recursive: false,
      },
    ]);
  });
});

describe("service_offerings — reads", () => {
  it("NEGATIVE: anon is refused before any row is looked at, whatever it selects", async () => {
    for (const col of ["id", "display_name", "provider_user_id", "rejection_reason"]) {
      const { code, rows } = await errorCodeAs(
        "anon",
        null,
        sql`SELECT ${sql.identifier(col)} FROM public.service_offerings WHERE id = ANY(${fixtureOfferingIds()})`,
      );
      expect(rows, col).toEqual([]);
      expect(code, col).toBe("42501");
    }
  });

  it("NEGATIVE: an authenticated stranger sees no approved offering any more", async () => {
    expect(await visibleOfferingIds(ids.stranger)).toEqual([]);
  });

  it("POSITIVE: the provider vet reads their own offering", async () => {
    expect(await visibleOfferingIds(ids.provider)).toEqual([ids.providerOffering]);
  });

  it("POSITIVE: an active org member reads their org's offering (no recursion error any more)", async () => {
    expect(await visibleOfferingIds(ids.member)).toEqual([ids.orgOffering]);
  });

  it("NEGATIVE: even the provider cannot read reviewer, review time or rejection reason", async () => {
    for (const col of ["reviewed_by_user_id", "reviewed_at", "rejection_reason", "status"]) {
      const { code } = await errorCodeAs(
        "authenticated",
        ids.provider,
        sql`SELECT ${sql.identifier(col)} FROM public.service_offerings WHERE id = ${ids.providerOffering}::uuid`,
      );
      expect(code, col).toBe("42501");
    }
  });

  it("the provider-vet sub-select on service_schedule_rules is not refused by the column grant", async () => {
    // "schedule_rules read by provider vet" sub-selects service_offerings.id
    // WHERE provider_user_id = auth.uid(); that is why authenticated keeps
    // those columns. The table's OTHER policy ("read by org members") raised
    // 42P17 (infinite recursion) until 0285 routed it through
    // caller_is_active_org_member, so the read now has to succeed outright.
    await db.execute(sql`
      INSERT INTO public.service_schedule_rules
        (service_offering_id, days_of_week, start_time_local, end_time_local, effective_from)
      VALUES (${ids.providerOffering}::uuid, ARRAY[1], '09:00', '10:00', current_date)
    `);
    const { code, rows } = await errorCodeAs(
      "authenticated",
      ids.provider,
      sql`SELECT service_offering_id::text AS id FROM public.service_schedule_rules
           WHERE service_offering_id = ${ids.providerOffering}::uuid`,
    );
    expect(code).toBeNull();
    expect(rows).toEqual([{ id: ids.providerOffering }]);
  });
});

describe("service_offerings — writes are closed to PostgREST", () => {
  for (const [role, who] of [
    ["anon", "anon"],
    ["authenticated", "provider"],
  ] as const) {
    it(`${who} cannot INSERT, UPDATE, DELETE or TRUNCATE service_offerings`, async () => {
      const userId = role === "anon" ? null : ids.provider;
      for (const statement of [
        sql`INSERT INTO public.service_offerings (public_token, provider_user_id, service_kind, display_name)
            VALUES (${`OFR-RLS-${fx.suffix}-X`}, ${ids.provider}::uuid, 'vaccination', 'x')`,
        sql`UPDATE public.service_offerings SET status = 'archived' WHERE id = ${ids.providerOffering}::uuid`,
        sql`DELETE FROM public.service_offerings WHERE id = ${ids.providerOffering}::uuid`,
        sql`TRUNCATE public.service_offerings CASCADE`,
      ]) {
        const { code } = await errorCodeAs(role, userId, statement);
        expect(code).toBe("42501");
      }
      const [row] = await db
        .select({ status: serviceOfferings.status })
        .from(serviceOfferings)
        .where(inArray(serviceOfferings.id, [ids.providerOffering]));
      expect(row).toEqual({ status: "approved" });
    });
  }
});

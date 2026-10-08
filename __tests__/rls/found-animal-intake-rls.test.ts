// RLS — public.org_found_animal_intake (migration 0292, P4).
//
// WHAT THIS DEFENDS
// -----------------
// An organization says whether it receives found animals, and the contact it
// publishes for it. Only an ACTIVE ADMIN of that organization may write it
// through PostgREST; an active member may read it; nobody else may do either,
// anon least of all (the public reads one server-side projection). There is
// no DELETE: turning it off is `accepting = false`.
//
// And every change is audited, by the table's own trigger, whichever path
// wrote it: a PostgREST write is attributed to auth.uid(), a Drizzle write to
// the transaction-local app.actor_user_id, and a write with neither is refused.
//
// SHAPE: statements run the way PostgREST runs them — `SET LOCAL ROLE
// authenticated` with spoofed `request.jwt.claims`, inside a transaction that
// ends with the statement. Every deny is paired with a positive control on the
// same row, so a policy that denies everybody cannot pass this file.

import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLog, db, orgFoundAnimalIntake } from "@/db";
import { pgErrorCode } from "@/lib/infra/db-errors";

import {
  type FoundAnimalFixtures,
  addMembership,
  makeOrg,
  makeProfile,
  newFoundAnimalFixtures,
  setIntake,
  teardownFoundAnimalFixtures,
} from "../_helpers/found-animal-fixtures";

const fx: FoundAnimalFixtures = newFoundAnimalFixtures("P4RLS");

const ids = {
  admin: "",
  member: "",
  leftAdmin: "",
  otherOrgAdmin: "",
  stranger: "",
  org: "",
  otherOrg: "",
  freshOrg: "",
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

async function errorCodeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return pgErrorCode(err) ?? "unknown";
  }
}

async function readRow(orgId: string) {
  const [row] = await db
    .select()
    .from(orgFoundAnimalIntake)
    .where(eq(orgFoundAnimalIntake.organizationId, orgId));
  return row ?? null;
}

async function auditRows(orgId: string) {
  return db
    .select({ actor: auditLog.actorUserId, payload: auditLog.payload })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "org_found_animal_intake_changed"),
        eq(auditLog.targetOrganizationId, orgId),
      ),
    )
    .orderBy(desc(auditLog.performedAt));
}

function updateStatement(orgId: string, status: string) {
  return sql`UPDATE public.org_found_animal_intake SET capacity_status = ${status}
              WHERE organization_id = ${orgId}::uuid RETURNING organization_id::text AS id`;
}

beforeAll(async () => {
  ids.admin = await makeProfile(fx, "admin");
  ids.member = await makeProfile(fx, "miembro");
  ids.leftAdmin = await makeProfile(fx, "ex-admin");
  ids.otherOrgAdmin = await makeProfile(fx, "admin-otra");
  ids.stranger = await makeProfile(fx, "extrano");

  ids.org = await makeOrg(fx, { label: "A" });
  ids.otherOrg = await makeOrg(fx, { label: "B" });
  ids.freshOrg = await makeOrg(fx, { label: "C" });
  for (const org of [ids.org, ids.freshOrg]) {
    await addMembership(org, ids.admin, { role: "admin" });
    await addMembership(org, ids.member, { role: "member" });
    await addMembership(org, ids.leftAdmin, { role: "admin", left: true });
  }
  await addMembership(ids.otherOrg, ids.otherOrgAdmin, { role: "admin" });

  await setIntake(ids.org, ids.admin, { capacityStatus: "recibimos" });
});

afterAll(async () => {
  await teardownFoundAnimalFixtures(fx);
});

describe("org_found_animal_intake — catalog shape", () => {
  it("RLS is on; SELECT for members, INSERT/UPDATE for admins, all TO authenticated, no DELETE", async () => {
    const [{ rls }] = (await db.execute(
      sql`SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'public.org_found_animal_intake'::regclass`,
    )) as unknown as Array<{ rls: boolean }>;
    expect(rls).toBe(true);

    const policies = (await db.execute(sql`
      SELECT policyname, cmd, array_to_string(roles, ',') AS roles
        FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'org_found_animal_intake'
       ORDER BY cmd
    `)) as unknown as Array<{ policyname: string; cmd: string; roles: string }>;
    expect(policies).toEqual([
      {
        policyname: "found animal intake inserted by org admin",
        cmd: "INSERT",
        roles: "authenticated",
      },
      {
        policyname: "found animal intake read by org member",
        cmd: "SELECT",
        roles: "authenticated",
      },
      {
        policyname: "found animal intake updated by org admin",
        cmd: "UPDATE",
        roles: "authenticated",
      },
    ]);
  });

  it("anon holds no privilege; authenticated holds no DELETE or TRUNCATE", async () => {
    const [row] = (await db.execute(sql`
      SELECT has_table_privilege('anon', 'public.org_found_animal_intake', 'SELECT') AS anon_sel,
             has_table_privilege('anon', 'public.org_found_animal_intake', 'INSERT') AS anon_ins,
             has_table_privilege('anon', 'public.org_found_animal_intake', 'UPDATE') AS anon_upd,
             has_table_privilege('authenticated', 'public.org_found_animal_intake', 'DELETE') AS auth_del,
             has_table_privilege('authenticated', 'public.org_found_animal_intake', 'TRUNCATE') AS auth_trunc
    `)) as unknown as Array<Record<string, boolean>>;
    expect(row).toEqual({
      anon_sel: false,
      anon_ins: false,
      anon_upd: false,
      auth_del: false,
      auth_trunc: false,
    });
  });
});

describe("org_found_animal_intake — reads", () => {
  const readStatement = (orgId: string) =>
    sql`SELECT organization_id::text AS id FROM public.org_found_animal_intake WHERE organization_id = ${orgId}::uuid`;

  it("an active admin and an active member read their org's row", async () => {
    expect(await asRole("authenticated", ids.admin, readStatement(ids.org))).toHaveLength(1);
    expect(await asRole("authenticated", ids.member, readStatement(ids.org))).toHaveLength(1);
  });

  it("a former admin, another org's admin and a stranger read nothing", async () => {
    for (const who of [ids.leftAdmin, ids.otherOrgAdmin, ids.stranger]) {
      expect(await asRole("authenticated", who, readStatement(ids.org))).toEqual([]);
    }
  });

  it("anon cannot read the table at all", async () => {
    expect(await errorCodeOf(asRole("anon", null, readStatement(ids.org)))).toBe("42501");
  });
});

describe("org_found_animal_intake — writes", () => {
  it("an active admin updates the row, and the trigger audits it as that admin", async () => {
    const updated = await asRole<{ id: string }>(
      "authenticated",
      ids.admin,
      updateStatement(ids.org, "consultar"),
    );
    expect(updated).toEqual([{ id: ids.org }]);
    expect((await readRow(ids.org))?.capacityStatus).toBe("consultar");

    const [latest] = await auditRows(ids.org);
    expect(latest.actor).toBe(ids.admin);
    expect(latest.payload).toMatchObject({
      org_id: ids.org,
      before_values: { capacity_status: "recibimos", accepting: true },
      after_values: { capacity_status: "consultar", accepting: true },
    });
  });

  it("a member, a former admin, another org's admin and a stranger update nothing", async () => {
    for (const who of [ids.member, ids.leftAdmin, ids.otherOrgAdmin, ids.stranger]) {
      expect(await asRole("authenticated", who, updateStatement(ids.org, "sin_lugar"))).toEqual([]);
    }
    expect((await readRow(ids.org))?.capacityStatus).toBe("consultar");
  });

  it("an admin cannot move the row to another organization", async () => {
    const code = await errorCodeOf(
      asRole(
        "authenticated",
        ids.admin,
        sql`UPDATE public.org_found_animal_intake SET organization_id = ${ids.otherOrg}::uuid
             WHERE organization_id = ${ids.org}::uuid`,
      ),
    );
    expect(code).not.toBeNull();
    expect((await readRow(ids.org))?.organizationId).toBe(ids.org);
  });

  it("only an active admin of THAT org may insert its row", async () => {
    const insert = sql`INSERT INTO public.org_found_animal_intake (organization_id, accepting)
                       VALUES (${ids.freshOrg}::uuid, true)`;
    for (const who of [ids.member, ids.leftAdmin, ids.otherOrgAdmin, ids.stranger]) {
      expect(await errorCodeOf(asRole("authenticated", who, insert))).toBe("42501");
    }
    expect(await readRow(ids.freshOrg)).toBeNull();

    expect(await errorCodeOf(asRole("authenticated", ids.admin, insert))).toBeNull();
    expect((await readRow(ids.freshOrg))?.accepting).toBe(true);
    const [created] = await auditRows(ids.freshOrg);
    expect(created.actor).toBe(ids.admin);
    expect(created.payload).toMatchObject({
      before_values: null,
      after_values: { accepting: true },
    });
  });

  it("anon cannot insert, and nobody can delete", async () => {
    const insert = sql`INSERT INTO public.org_found_animal_intake (organization_id, accepting)
                       VALUES (${ids.otherOrg}::uuid, true)`;
    expect(await errorCodeOf(asRole("anon", null, insert))).toBe("42501");
    expect(
      await errorCodeOf(
        asRole(
          "authenticated",
          ids.admin,
          sql`DELETE FROM public.org_found_animal_intake WHERE organization_id = ${ids.org}::uuid`,
        ),
      ),
    ).toBe("42501");
    expect(await readRow(ids.org)).not.toBeNull();
  });
});

describe("org_found_animal_intake — every change is audited", () => {
  it("a re-save with nothing changed writes no audit row", async () => {
    const before = (await auditRows(ids.org)).length;
    await asRole("authenticated", ids.admin, updateStatement(ids.org, "consultar"));
    expect((await auditRows(ids.org)).length).toBe(before);
  });

  it("the Drizzle writer is attributed to the actor it names", async () => {
    await setIntake(ids.org, ids.member, { capacityStatus: "sin_lugar" });
    const [latest] = await auditRows(ids.org);
    expect(latest.actor).toBe(ids.member);
    expect(latest.payload).toMatchObject({ after_values: { capacity_status: "sin_lugar" } });
  });

  it("records THAT the published contact changed, never the value itself", async () => {
    await setIntake(ids.org, ids.admin, {
      capacityStatus: "sin_lugar",
      publicContactKind: "telefono",
      publicContactValue: "+54 11 4777-0199",
    });
    expect((await readRow(ids.org))?.publicContactValue).toBe("+54 11 4777-0199");
    const [latest] = await auditRows(ids.org);
    expect(latest.payload).toMatchObject({
      public_contact_value_changed: true,
      after_values: { public_contact_kind: "telefono", public_contact_published: true },
    });
    expect(JSON.stringify(latest.payload)).not.toContain("4777-0199");
  });

  it("records THAT the published hours changed, never the text itself", async () => {
    await setIntake(ids.org, ids.admin, {
      capacityStatus: "sin_lugar",
      publicContactKind: "telefono",
      publicContactValue: "+54 11 4777-0199",
      publicHours: "Sábados de 10 a 14 en la sede Norte",
    });
    const [latest] = await auditRows(ids.org);
    expect(latest.payload).toMatchObject({
      public_hours_changed: true,
      public_contact_value_changed: false,
      after_values: { public_hours_published: true },
    });
    expect(JSON.stringify(latest.payload)).not.toContain("sede Norte");
  });

  it("updated_at may move into the past, never into the future", async () => {
    const future = await asRole<{ fresh: boolean }>(
      "authenticated",
      ids.admin,
      sql`UPDATE public.org_found_animal_intake SET updated_at = now() + interval '365 days'
           WHERE organization_id = ${ids.org}::uuid
       RETURNING updated_at <= now() AS fresh`,
    );
    expect(future).toEqual([{ fresh: true }]);
    const past = await asRole<{ backdated: boolean }>(
      "authenticated",
      ids.admin,
      sql`UPDATE public.org_found_animal_intake SET updated_at = now() - interval '40 days'
           WHERE organization_id = ${ids.org}::uuid
       RETURNING updated_at < now() - interval '39 days' AS backdated`,
    );
    expect(past).toEqual([{ backdated: true }]);
  });

  it("a write with no accountable actor is refused", async () => {
    const code = await errorCodeOf(
      db
        .update(orgFoundAnimalIntake)
        .set({ capacityStatus: "recibimos" })
        .where(eq(orgFoundAnimalIntake.organizationId, ids.org)),
    );
    expect(code).toBe("42501");
    expect((await readRow(ids.org))?.capacityStatus).toBe("sin_lugar");
  });
});

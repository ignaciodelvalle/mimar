// RLS — appointments and service_schedule_rules org-member policies
// (migration 0285).
//
// WHAT THIS DEFENDS
// -----------------
// Until 0285, "appointments read by org members" and "schedule_rules read by
// org members" sub-selected organization_memberships directly, whose peers
// policy sub-selects itself: every authenticated SELECT on either table raised
// 42P17 (infinite recursion) — the owner's and the provider vet's included,
// because permissive policies are all planned. 0285 routes both through
// public.caller_is_active_org_member and keeps the declared authorization.
//
// SHAPE: the visits-rls.test.ts pattern — `SET LOCAL ROLE` with spoofed
// `request.jwt.claims`. Each caller shape the policies distinguish is probed
// over the same three appointments / rules (see
// __tests__/_helpers/scheduling-rls-fixtures.ts). Every deny is paired with a
// positive control on the same rows. A read that raises is a failure, never an
// empty result.
//
// SAME SEMANTICS: the last block evaluates the PRE-0285 predicates verbatim as
// the BYPASSRLS test role (no recursion there: RLS does not run) and requires
// the post-0285 RLS result to match them for every probe.
//
// PRE-FLIGHT: local Supabase stack with 0285 applied, .env.local loaded.

import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/db";
import {
  OFFERING_KEYS,
  type OfferingKey,
  type Probe,
  type SchedulingWorld,
  buildSchedulingWorld,
  runAs,
  teardownSchedulingWorld,
  visibleKeys,
} from "../_helpers/scheduling-rls-fixtures";

let world: SchedulingWorld;

beforeAll(async () => {
  world = await buildSchedulingWorld("RLS85");
});

afterAll(async () => {
  await teardownSchedulingWorld(world);
});

/** Who reads which appointment, per the three policies on the table. */
const APPOINTMENT_READERS: Record<Probe, OfferingKey[]> = {
  owner: ["org", "provider"], // owner_user_id
  owner2: ["other"], // owner_user_id
  member: ["org"], // active member of orgA
  leftMember: [], // left orgA
  otherMember: ["other"], // active member of orgB
  provider: ["provider"], // provides the offering
  stranger: [],
};

/** Who reads which schedule rule, per the two policies on the table. */
const RULE_READERS: Record<Probe, OfferingKey[]> = {
  owner: [], // booking an offering grants no rule read
  owner2: [],
  member: ["org"],
  leftMember: [],
  otherMember: ["other"],
  provider: ["provider"],
  stranger: [],
};

const PROBES = Object.keys(APPOINTMENT_READERS) as Probe[];

describe("appointments — who reads (0285)", () => {
  for (const probe of PROBES) {
    const expected = APPOINTMENT_READERS[probe];
    it(`${probe} reads ${expected.length === 0 ? "none" : expected.join(" + ")}`, async () => {
      expect(await visibleKeys(world, "appointments", "authenticated", world.users[probe])).toEqual(
        expected,
      );
    });
  }

  it("anon reads nothing", async () => {
    const { code, rows } = await runAs(
      "anon",
      null,
      sql`SELECT id FROM public.appointments WHERE id = ${world.appointment.org}::uuid`,
    );
    if (code !== null) expect(code).toBe("42501");
    expect(rows).toEqual([]);
  });
});

describe("service_schedule_rules — who reads (0285)", () => {
  for (const probe of PROBES) {
    const expected = RULE_READERS[probe];
    it(`${probe} reads ${expected.length === 0 ? "none" : expected.join(" + ")}`, async () => {
      expect(
        await visibleKeys(world, "service_schedule_rules", "authenticated", world.users[probe]),
      ).toEqual(expected);
    });
  }

  it("anon reads nothing", async () => {
    const { code, rows } = await runAs(
      "anon",
      null,
      sql`SELECT id FROM public.service_schedule_rules WHERE id = ${world.rule.org}::uuid`,
    );
    if (code !== null) expect(code).toBe("42501");
    expect(rows).toEqual([]);
  });
});

describe("no recursion (0285)", () => {
  it("an unscoped authenticated read of either table does not raise 42P17", async () => {
    for (const table of ["appointments", "service_schedule_rules"]) {
      const { code } = await runAs(
        "authenticated",
        world.users.stranger,
        sql`SELECT count(*) FROM ${sql.raw(`public.${table}`)}`,
      );
      expect(code, table).toBeNull();
    }
  });

  it("no policy on either table sub-selects organization_memberships", async () => {
    const rows = (await db.execute(sql`
      SELECT tablename::text || '.' || policyname::text AS policy
        FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename IN ('appointments', 'service_schedule_rules')
         AND coalesce(qual, '') LIKE '%organization_memberships%'
    `)) as unknown as { policy: string }[];
    expect(rows).toEqual([]);
  });
});

describe("same authorization as before 0285", () => {
  // The pre-0285 policy bodies, verbatim (0086 / 0137), OR-ed per table.
  // Evaluated as the BYPASSRLS test role with the probe's claims set, so
  // auth.uid() is the probe and no policy runs — the declared semantics.
  const OLD_APPOINTMENTS = sql.raw(`
    a.owner_user_id = auth.uid()
    OR a.organization_id IN (
      SELECT organization_id FROM public.organization_memberships
       WHERE user_id = auth.uid() AND left_at IS NULL)
    OR a.service_offering_id IN (
      SELECT id FROM public.service_offerings WHERE provider_user_id = auth.uid())`);
  const OLD_RULES = sql.raw(`
    r.service_offering_id IN (
      SELECT id FROM public.service_offerings
       WHERE organization_id IN (
         SELECT organization_id FROM public.organization_memberships
          WHERE user_id = auth.uid() AND left_at IS NULL))
    OR r.service_offering_id IN (
      SELECT id FROM public.service_offerings WHERE provider_user_id = auth.uid())`);

  async function declaredKeys(
    probe: Probe,
    table: "appointments" | "service_schedule_rules",
  ): Promise<OfferingKey[]> {
    const ids = table === "appointments" ? world.appointment : world.rule;
    const idList = sql.join(
      OFFERING_KEYS.map((k) => sql`${ids[k]}::uuid`),
      sql`, `,
    );
    const rows = await db.transaction(async (tx) => {
      const claims = JSON.stringify({ sub: world.users[probe], role: "authenticated" });
      await tx.execute(sql`SELECT set_config('request.jwt.claims', ${claims}, true)`);
      return (await tx.execute(
        table === "appointments"
          ? sql`SELECT a.id::text AS id FROM public.appointments a
                 WHERE a.id IN (${idList}) AND (${OLD_APPOINTMENTS})`
          : sql`SELECT r.id::text AS id FROM public.service_schedule_rules r
                 WHERE r.id IN (${idList}) AND (${OLD_RULES})`,
      )) as unknown as { id: string }[];
    });
    return OFFERING_KEYS.filter((k) => rows.some((r) => r.id === ids[k]));
  }

  for (const table of ["appointments", "service_schedule_rules"] as const) {
    it(`${table}: RLS after 0285 equals the pre-0285 predicates for every probe`, async () => {
      for (const probe of PROBES) {
        const declared = await declaredKeys(probe, table);
        const live = await visibleKeys(world, table, "authenticated", world.users[probe]);
        expect(live, `${table} as ${probe}`).toEqual(declared);
      }
    });
  }
});

describe("provisioning mirror (0285)", () => {
  it("db/scheduling_rls.sql carries both policy statements byte-identical to the migration", () => {
    const migration = readFileSync(
      "db/migrations/0285_scheduling_org_member_policies_no_recursion.sql",
      "utf8",
    );
    const mirror = readFileSync("db/scheduling_rls.sql", "utf8");
    const blocks = [
      ...migration.matchAll(
        /-- >>> scheduling_rls\.sql mirror: .+\n([\s\S]*?)-- <<< scheduling_rls\.sql mirror/g,
      ),
    ].map((m) => m[1]);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) expect(mirror).toContain(block);
  });
});

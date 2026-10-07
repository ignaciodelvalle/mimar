// RLS — appointments, service_schedule_rules and time_slots require aal2 of an
// institutional session (migration 0288, the 0231 house rule).
//
// WHAT THIS DEFENDS
// -----------------
// 0285 and 0286 gave the three scheduling tables a working "read by org
// members" policy and none of them the restrictive aal2 policy 0231 put on
// every institution-granting table. An active org member whose profile is
// account_type = 'institutional' could read their org's appointments, rules
// and slots with a password-only (aal1) token. 0288 adds the restrictive
// `caller_meets_institutional_aal()` policy to each.
//
// SHAPE: the scheduling-org-member-rls.test.ts pattern (`SET LOCAL ROLE` +
// spoofed `request.jwt.claims`, now with the `aal` claim), over the shared
// scheduling world (__tests__/_helpers/scheduling-rls-fixtures.ts) plus four
// institutional profiles this file adds. Every deny is paired with a positive
// control on the same rows: the same institutional member at aal2, and the
// personal-account member and provider vet at aal1.
//
// PRE-FLIGHT: local Supabase stack with 0288 applied, .env.local loaded.

import { readFileSync } from "node:fs";

import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, profiles } from "@/db";
import {
  type Aal,
  type OfferingKey,
  type SchedulingWorld,
  buildSchedulingWorld,
  teardownSchedulingWorld,
  visibleKeys,
} from "../_helpers/scheduling-rls-fixtures";
import { addMembership, makeProfile } from "../_helpers/visit-fixtures";

const TABLES = ["appointments", "service_schedule_rules", "time_slots"] as const;

let world: SchedulingWorld;
/** Active institutional-account member of orgA. */
let instMember: string;
/** Platform principals with no scheduling branch of their own. */
let govt: string;
let admin: string;
/** An institutional admin who is ALSO an active member of orgA. */
let adminMember: string;

beforeAll(async () => {
  world = await buildSchedulingWorld("RLS88");
  instMember = await makeProfile(world.fx, "RLS88-instMember");
  govt = await makeProfile(world.fx, "RLS88-govt");
  admin = await makeProfile(world.fx, "RLS88-admin");
  adminMember = await makeProfile(world.fx, "RLS88-adminMember");
  await db
    .update(profiles)
    .set({ accountType: "institutional" })
    .where(inArray(profiles.id, [instMember, govt, admin, adminMember]));
  await db
    .update(profiles)
    .set({ role: "govt" })
    .where(inArray(profiles.id, [govt]));
  await db
    .update(profiles)
    .set({ role: "admin" })
    .where(inArray(profiles.id, [admin, adminMember]));
  // The provider vet is a personal account with role 'vet', as in production.
  await db
    .update(profiles)
    .set({ role: "vet" })
    .where(inArray(profiles.id, [world.users.provider]));
  await addMembership(world.orgA, instMember);
  await addMembership(world.orgA, adminMember);
});

afterAll(async () => {
  await teardownSchedulingWorld(world);
});

/** What a caller reads on `table` at `aal`, as offering keys. */
const read = (table: (typeof TABLES)[number], userId: string, aal: Aal) =>
  visibleKeys(world, table, "authenticated", userId, aal);

describe("institutional org member — aal2 or nothing (0288)", () => {
  for (const table of TABLES) {
    it(`${table}: aal1 reads none, aal2 reads its org's row (positive control)`, async () => {
      expect(await read(table, instMember, "aal1")).toEqual([]);
      expect(await read(table, instMember, "aal2")).toEqual(["org"]);
    });

    it(`${table}: a token with no aal claim is treated as aal1`, async () => {
      expect(await visibleKeys(world, table, "authenticated", instMember)).toEqual([]);
    });

    it(`${table}: an admin who is also an org member is held to aal2 too`, async () => {
      expect(await read(table, adminMember, "aal1")).toEqual([]);
      expect(await read(table, adminMember, "aal2")).toEqual(["org"]);
    });
  }
});

describe("personal accounts are unaffected at aal1 (0288)", () => {
  const PERSONAL: Record<(typeof TABLES)[number], Record<string, OfferingKey[]>> = {
    appointments: { owner: ["org", "provider"], member: ["org"], provider: ["provider"] },
    service_schedule_rules: { owner: [], member: ["org"], provider: ["provider"] },
    time_slots: { owner: [], member: ["org"], provider: ["provider"] },
  };
  for (const table of TABLES) {
    for (const [probe, expected] of Object.entries(PERSONAL[table])) {
      it(`${table}: personal ${probe} at aal1 reads ${expected.join(" + ") || "none"}`, async () => {
        const userId = world.users[probe as "owner" | "member" | "provider"];
        expect(await read(table, userId, "aal1")).toEqual(expected);
      });
    }
  }

  it("the provider vet really is a personal account with role vet", async () => {
    const [row] = await db
      .select({ accountType: profiles.accountType, role: profiles.role })
      .from(profiles)
      .where(inArray(profiles.id, [world.users.provider]));
    expect(row).toEqual({ accountType: "personal", role: "vet" });
  });
});

describe("platform principals with no scheduling branch read nothing (0288)", () => {
  for (const table of TABLES) {
    for (const aal of ["aal1", "aal2"] as const) {
      it(`${table}: govt and admin at ${aal} read none`, async () => {
        expect(await read(table, govt, aal)).toEqual([]);
        expect(await read(table, admin, aal)).toEqual([]);
      });
    }
  }
});

describe("catalog (0288)", () => {
  it("each table carries the restrictive aal2 SELECT policy, TO authenticated", async () => {
    const rows = (await db.execute(sql`
      SELECT tablename::text AS t
        FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename IN ('appointments', 'service_schedule_rules', 'time_slots')
         AND cmd = 'SELECT'
         AND permissive = 'RESTRICTIVE'
         AND roles = ARRAY['authenticated']::name[]
         AND coalesce(qual, '') LIKE '%caller_meets_institutional_aal()%'
       ORDER BY 1
    `)) as unknown as { t: string }[];
    expect(rows.map((r) => r.t)).toEqual([...TABLES]);
  });

  it("db/scheduling_rls.sql carries the 0288 block byte-identical", () => {
    const migration = readFileSync("db/migrations/0288_scheduling_institutional_aal2.sql", "utf8");
    const mirror = readFileSync("db/scheduling_rls.sql", "utf8");
    const block = migration.match(
      /-- >>> scheduling_rls\.sql mirror: institutional aal2 \(0288\)\n([\s\S]*?)-- <<< scheduling_rls\.sql mirror/,
    )?.[1];
    expect(block).toBeDefined();
    expect(block).toContain("as restrictive for select to authenticated");
    expect(mirror).toContain(block);
  });

  it("db/scheduling_rls.sql no longer claims it is not applied", () => {
    const mirror = readFileSync("db/scheduling_rls.sql", "utf8");
    expect(mirror).not.toMatch(/DO NOT APPLY|No longer applied/);
    expect(mirror).toContain("scripts/deploy-provision.ts");
    const provision = readFileSync("scripts/deploy-provision.ts", "utf8");
    expect(provision).toContain('"db/scheduling_rls.sql"');
  });
});

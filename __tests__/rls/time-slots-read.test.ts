// RLS — public.time_slots (migration 0286).
//
// WHAT THIS DEFENDS
// -----------------
// Until 0286, "time_slots read publicly" (0086) was FOR SELECT TO anon,
// authenticated USING (true): the capacity and live bookings_count of every
// slot of every offering, to anyone holding the publishable key. Nobody read
// time_slots through PostgREST — owner search, booking, the org agenda and the
// owner's turnos all read it server-side over Drizzle — so 0286 narrows it to
// the audience of service_schedule_rules: the active members of the
// offering's organization and the provider vet, TO authenticated.
//
// SHAPE: the visits-rls.test.ts pattern (`SET LOCAL ROLE` + spoofed
// `request.jwt.claims`), over the shared scheduling world
// (__tests__/_helpers/scheduling-rls-fixtures.ts). Every deny is paired with
// a positive control on the same rows. The anon probe is also run under the
// grant deploy-provision re-applies (SELECT on every public table to anon),
// inside a rolled-back transaction: RLS has to hold whatever the grants are.
//
// PRE-FLIGHT: local Supabase stack with 0286 applied, .env.local loaded.

import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/db";
import { pgErrorCode } from "@/lib/infra/db-errors";
import {
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
  world = await buildSchedulingWorld("RLS86");
});

afterAll(async () => {
  await teardownSchedulingWorld(world);
});

/** Who reads which slot after 0286 — the same audience as the rules. */
const SLOT_READERS: Record<Probe, OfferingKey[]> = {
  owner: [], // booked "org" and "provider", reads them server-side only
  owner2: [], // booked "other"
  member: ["org"], // active member of orgA
  leftMember: [], // left orgA
  otherMember: ["other"], // active member of orgB (the other org)
  provider: ["provider"], // provides the offering
  stranger: [],
};

describe("time_slots — who reads (0286)", () => {
  for (const probe of Object.keys(SLOT_READERS) as Probe[]) {
    const expected = SLOT_READERS[probe];
    it(`${probe} reads ${expected.length === 0 ? "none" : expected.join(" + ")}`, async () => {
      expect(await visibleKeys(world, "time_slots", "authenticated", world.users[probe])).toEqual(
        expected,
      );
    });
  }

  it("an owner reads their own appointment on a slot they cannot read (positive control)", async () => {
    // The deny above is about time_slots, not about an owner who cannot see
    // their booking: the appointment row on that same slot is readable.
    expect(await visibleKeys(world, "time_slots", "authenticated", world.users.owner)).toEqual([]);
    expect(await visibleKeys(world, "appointments", "authenticated", world.users.owner)).toEqual([
      "org",
      "provider",
    ]);
  });

  it("a member of the other org reads its own org's slot, never orgA's", async () => {
    const keys = await visibleKeys(world, "time_slots", "authenticated", world.users.otherMember);
    expect(keys).toContain("other");
    expect(keys).not.toContain("org");
  });
});

describe("time_slots — anon (0286)", () => {
  it("anon reads nothing", async () => {
    const { code, rows } = await runAs(
      "anon",
      null,
      sql`SELECT id FROM public.time_slots WHERE id = ${world.slot.org}::uuid`,
    );
    if (code !== null) expect(code).toBe("42501");
    expect(rows).toEqual([]);
  });

  it("anon reads nothing even after the provisioner's re-grant of SELECT", async () => {
    // deploy-provision runs `grant ... on all tables in schema public to anon`
    // after the replay. Reproduce that grant inside a transaction that is
    // rolled back, and read as anon in the same transaction.
    class Rollback extends Error {}
    let seen: unknown[] | null = null;
    let code: string | null = null;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`GRANT SELECT ON public.time_slots TO anon`);
        await tx.execute(sql`SELECT set_config('request.jwt.claims', '{"role":"anon"}', true)`);
        await tx.execute(sql`SET LOCAL ROLE anon`);
        seen = (await tx.execute(
          sql`SELECT id FROM public.time_slots WHERE service_offering_id IN (
                ${world.offering.org}::uuid, ${world.offering.provider}::uuid,
                ${world.offering.other}::uuid)`,
        )) as unknown as unknown[];
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) code = pgErrorCode(err) ?? "unknown";
    }
    expect(code).toBeNull();
    expect(seen).toEqual([]);
  });
});

describe("time_slots — catalog (0286)", () => {
  it("no policy admits anon or PUBLIC, and none is unconditional", async () => {
    const rows = (await db.execute(sql`
      SELECT policyname::text AS policy
        FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'time_slots'
         AND (roles && ARRAY['anon', 'public']::name[]
              OR coalesce(btrim(qual), 'true') = 'true')
    `)) as unknown as { policy: string }[];
    expect(rows).toEqual([]);
  });

  it("db/scheduling_rls.sql carries the 0286 block byte-identical", () => {
    const migration = readFileSync("db/migrations/0286_time_slots_read_narrowed.sql", "utf8");
    const mirror = readFileSync("db/scheduling_rls.sql", "utf8");
    const block = migration.match(
      /-- >>> scheduling_rls\.sql mirror: time_slots \(0286\)\n([\s\S]*?)-- <<< scheduling_rls\.sql mirror/,
    )?.[1];
    expect(block).toBeDefined();
    expect(mirror).toContain(block);
    expect(mirror).not.toContain('"time_slots read publicly"\n  on public.time_slots');
  });
});

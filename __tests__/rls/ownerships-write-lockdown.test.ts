// RLS — `public.ownerships` has NO write surface through PostgREST.
// (RA-8 finding R1, migration 0163.)
//
// WHAT THIS DEFENDS
// -----------------
// `ownerships` is the root of the owner-side authorization graph: pets
// SELECT/UPDATE, pet_events SELECT and INSERT, and attachments all resolve
// "may this user act on this pet?" to "does an active ownerships row exist for
// (pet_id, auth.uid())" — with NO role filter. Migration 0086 shipped
//   with check (owner_user_id = auth.uid())
// as the INSERT gate, which pins the HOLDER but never the PET, so a single
// authenticated POST forged an active co_owner row on any pet in the country
// and inherited every one of those downstream grants — including append into
// the append-only spine, which cannot be undone.
//
// `ownerships_one_active_owner_per_pet` does NOT catch it: the index is partial
// (`WHERE role = 'owner'`), so co_owner / foster / caretaker are unconstrained.
//
// WHY DENY-ALL AND NOT A NARROWER POLICY: every legitimate writer of this table
// (createPet, accept-transfer, adoption, foster, intake, free-claim,
// chip-match, dispute resolution, decomiso, owner-return, seeds) writes over
// the Drizzle BYPASSRLS connection, which never consults RLS. Zero legitimate
// writers reach `ownerships` through PostgREST. So the attack probes below and
// the legitimate-path probe are not in tension: the first prove PostgREST is
// shut, the last proves the real creation path is untouched.
//
// PRE-FLIGHT: local Supabase stack + `pnpm seed:test` (owner@dim.test,
// vet@dim.test). A setup failure THROWS — it never degrades to a green skip
// (see matrix.test.ts P2.8 for why that rule exists).

import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petEvents, pets } from "@/db";
import { withMutationOverride } from "../_helpers/db-overrides";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SHARED_PASSWORD = "Test1234!";

const VICTIM = { email: "owner@dim.test", password: SHARED_PASSWORD };
const ATTACKER = { email: "vet@dim.test", password: SHARED_PASSWORD };

let attackerClient: SupabaseClient | null = null;
let attackerUserId = "";
let victimUserId = "";

// Fixtures, all self-provisioned so no assertion depends on seed drift.
let victimPetId: string | null = null;
let attackerPetId: string | null = null;
let attackerOwnershipId: string | null = null;
let setupError: string | null = null;

function suffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.toUpperCase().slice(-8);
}

async function createFixturePet(name: string, ownerUserId: string) {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `DIM-R1LK-${suffix()}`,
      name,
      species: "dog",
      sex: "male",
      potentiallyDangerousBreed: false,
    })
    .returning({ id: pets.id });
  const [own] = await db
    .insert(ownerships)
    .values({ petId: pet.id, ownerUserId, role: "owner" })
    .returning({ id: ownerships.id });
  return { petId: pet.id, ownershipId: own.id };
}

beforeAll(async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    setupError =
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY missing — no PostgREST to probe.";
    throw new Error(setupError);
  }

  const victimClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: victimAuth, error: victimErr } = await victimClient.auth.signInWithPassword(VICTIM);
  if (victimErr || !victimAuth.user) {
    setupError = `sign-in failed for ${VICTIM.email}: ${victimErr?.message ?? "no user"}. Run \`pnpm seed:test\`.`;
    throw new Error(setupError);
  }
  victimUserId = victimAuth.user.id;

  attackerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: attackerAuth, error: attackerErr } =
    await attackerClient.auth.signInWithPassword(ATTACKER);
  if (attackerErr || !attackerAuth.user) {
    setupError = `sign-in failed for ${ATTACKER.email}: ${attackerErr?.message ?? "no user"}. Run \`pnpm seed:test\`.`;
    throw new Error(setupError);
  }
  attackerUserId = attackerAuth.user.id;

  victimPetId = (await createFixturePet("R1 lockdown victim pet", victimUserId)).petId;

  // The attacker needs an ownership row of their OWN for the UPDATE-repoint
  // probe: the old UPDATE policy gated on `owner_user_id = auth.uid()` in both
  // USING and WITH CHECK, so holding ANY row was the whole prerequisite.
  const attackerFixture = await createFixturePet("R1 lockdown attacker pet", attackerUserId);
  attackerPetId = attackerFixture.petId;
  attackerOwnershipId = attackerFixture.ownershipId;
});

afterAll(async () => {
  for (const id of [victimPetId, attackerPetId]) {
    if (!id) continue;
    await db
      .delete(ownerships)
      .where(eq(ownerships.petId, id))
      .catch(() => {});
    await withMutationOverride(async (tx) => {
      await tx.delete(petEvents).where(eq(petEvents.petId, id));
    }).catch(() => {});
    await db
      .delete(pets)
      .where(eq(pets.id, id))
      .catch(() => {});
  }
});

function client(): SupabaseClient {
  if (setupError) throw new Error(setupError);
  if (!attackerClient) throw new Error("attacker client not provisioned");
  return attackerClient;
}

async function activeRowsFor(petId: string, userId: string): Promise<number> {
  const rows = await db
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, petId),
        eq(ownerships.ownerUserId, userId),
        isNull(ownerships.endedAt),
      ),
    );
  return rows.length;
}

describe("ownerships — PostgREST write surface is closed (RA-8 R1)", () => {
  it("has NO INSERT / UPDATE / DELETE policy reachable by anon or authenticated", async () => {
    const rows = (await db.execute(sql`
      select p.policyname, p.cmd, array_to_string(p.roles, ',') as roles
      from pg_policies p
      where p.schemaname = 'public'
        and p.tablename = 'ownerships'
        and p.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    `)) as unknown as Array<{ policyname: string; cmd: string; roles: string }>;

    const reachable = rows.filter((r) =>
      r.roles
        .split(",")
        .map((x) => x.trim())
        .some((x) => x === "anon" || x === "authenticated" || x === "public"),
    );
    expect(
      reachable,
      `ownerships is the root of the owner authorization graph — a write policy here grants pets/pet_events/attachments by transitivity. Offenders: ${reachable
        .map((r) => `${r.policyname} (${r.cmd}, ${r.roles})`)
        .join("; ")}`,
    ).toEqual([]);
  });

  it("keeps its correctly-scoped SELECT policy (the lockdown is writes-only)", async () => {
    const rows = (await db.execute(sql`
      select p.policyname, p.qual
      from pg_policies p
      where p.schemaname = 'public' and p.tablename = 'ownerships' and p.cmd = 'SELECT'
    `)) as unknown as Array<{ policyname: string; qual: string | null }>;
    expect(rows.length, "ownerships lost its SELECT policy too — that is over-correction").toBe(1);
    expect(rows[0].qual ?? "").toContain("auth.uid()");
  });

  // -------------------------------------------------------------------------
  // ATTACK — the reachable-today takeover
  // -------------------------------------------------------------------------

  it.each(["co_owner", "foster", "caretaker", "owner"] as const)(
    "rejects a self-granted `%s` ownership on someone else's pet",
    async (role) => {
      const petId = victimPetId as string;
      const { error, data } = await client()
        .from("ownerships")
        .insert({ pet_id: petId, owner_user_id: attackerUserId, role })
        .select("id");

      expect(
        (data ?? []).length,
        `PostgREST returned rows for a forged ${role} ownership — takeover is live`,
      ).toBe(0);
      expect(error, `forged ${role} insert was NOT rejected`).not.toBeNull();

      // The row must not exist even if PostgREST reported an error shape we
      // did not expect. Drizzle bypasses RLS, so this is the ground truth.
      expect(
        await activeRowsFor(petId, attackerUserId),
        `a forged ${role} ownership row LANDED in the table`,
      ).toBe(0);
    },
  );

  it("rejects repointing an ownership row the attacker legitimately holds at a victim pet", async () => {
    const { error, data } = await client()
      .from("ownerships")
      .update({ pet_id: victimPetId as string })
      .eq("id", attackerOwnershipId as string)
      .select("id");

    // NOTE on the shape of an UPDATE denial: with no UPDATE policy at all,
    // RLS removes the row from the statement's USING scope, so PostgREST
    // reports SUCCESS over ZERO affected rows rather than 42501. Row count +
    // the ground-truth read below are what prove the denial; asserting on
    // `error` here would assert the wrong thing.
    expect(error?.message ?? null, "unexpected PostgREST error shape").toBeNull();
    expect((data ?? []).length, "PostgREST applied the pet_id repoint").toBe(0);

    const [row] = await db
      .select({ petId: ownerships.petId })
      .from(ownerships)
      .where(eq(ownerships.id, attackerOwnershipId as string));
    expect(row.petId, "the ownership row was repointed at the victim pet").toBe(attackerPetId);
  });

  it("rejects self-promotion of an existing row to a higher role", async () => {
    await db
      .update(ownerships)
      .set({ role: "foster" })
      .where(eq(ownerships.id, attackerOwnershipId as string));

    const { data } = await client()
      .from("ownerships")
      .update({ role: "owner" })
      .eq("id", attackerOwnershipId as string)
      .select("id");
    expect((data ?? []).length, "PostgREST applied the role promotion").toBe(0);

    const [row] = await db
      .select({ role: ownerships.role })
      .from(ownerships)
      .where(eq(ownerships.id, attackerOwnershipId as string));
    expect(row.role, "the foster row promoted itself to owner").toBe("foster");

    await db
      .update(ownerships)
      .set({ role: "owner" })
      .where(eq(ownerships.id, attackerOwnershipId as string));
  });

  // -------------------------------------------------------------------------
  // LEGITIMATE PATHS — a policy that denies everything is not a fix
  // -------------------------------------------------------------------------

  it("still lets the attacker READ their own ownership rows through PostgREST", async () => {
    const { data, error } = await client()
      .from("ownerships")
      .select("id,pet_id")
      .eq("id", attackerOwnershipId as string);
    expect(error).toBeNull();
    expect((data ?? []).length, "own-row read broke — the SELECT policy was collateral").toBe(1);
  });

  it("still creates a co_owner row through the SERVER path (Drizzle, as every use-case does)", async () => {
    const petId = victimPetId as string;
    const [created] = await db
      .insert(ownerships)
      .values({ petId, ownerUserId: attackerUserId, role: "co_owner" })
      .returning({ id: ownerships.id });

    expect(created?.id, "the legitimate server-side co_owner insert was blocked").toBeTruthy();
    expect(await activeRowsFor(petId, attackerUserId)).toBe(1);

    await db.delete(ownerships).where(eq(ownerships.id, created.id));
  });

  it("still ends an ownership through the SERVER path (transfer/return set ended_at)", async () => {
    const id = attackerOwnershipId as string;
    const endedAt = new Date();
    await db.update(ownerships).set({ endedAt }).where(eq(ownerships.id, id));
    const [row] = await db
      .select({ endedAt: ownerships.endedAt })
      .from(ownerships)
      .where(eq(ownerships.id, id));
    expect(row.endedAt, "the legitimate server-side ended_at write was blocked").not.toBeNull();
    await db.update(ownerships).set({ endedAt: null }).where(eq(ownerships.id, id));
  });
});

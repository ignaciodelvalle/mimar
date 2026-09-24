// RLS — pet_tags SELECT-own behavior through PostgREST (migration 0169).
//
// The policy grants SELECT to the activating user or a current owner of the
// linked pet, TO authenticated. This probe proves the two live denials that
// the catalog-level coverage test cannot see:
//   1. cross-owner: an authenticated stranger reads ZERO of the victim's tag
//      rows (no serial/status oracle, no hash exposure);
//   2. anon: the role gets nothing at all (explicit TO authenticated).
//
// Writes are not probed here: pet_tags ships zero write policies, which the
// deny-all-shaped write posture inherits from RLS default-deny (and the
// coverage test pins the zero-write-policy fact at the catalog level).
//
// PRE-FLIGHT: local Supabase stack. Users are self-provisioned via the admin
// SDK — a setup failure THROWS, it never degrades to a green skip.

import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petTags, pets } from "@/db";
import { generateTagSerial } from "@/lib/infra/publicToken";
import { hashTagActivationCode } from "@/lib/utils/tag-code-hash";
import { withMutationOverride } from "../_helpers/db-overrides";
import { createFreshTestUser } from "../_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const VICTIM_EMAIL = "rls-tags-victim@dim-test.local";
const ATTACKER_EMAIL = "rls-tags-attacker@dim-test.local";
const PASS = "RlsTagsTest_2026!";
const TEST_LOTE = "TEST-LOTE-RLSTAGS";

let victimUserId: string;
let victimSerial: string;
let victimClient: SupabaseClient;
let attackerClient: SupabaseClient;

async function purgeUser(email: string) {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === email);
  if (!found) return;
  const owned = await db
    .select({ petId: ownerships.petId })
    .from(ownerships)
    .where(eq(ownerships.ownerUserId, found.id));
  await db.delete(petTags).where(eq(petTags.loteId, TEST_LOTE));
  await withMutationOverride(async (tx) => {
    for (const { petId } of owned) await tx.delete(pets).where(eq(pets.id, petId));
  });
  await admin.auth.admin.deleteUser(found.id);
}

beforeAll(async () => {
  if (!ANON_KEY) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY missing — no PostgREST to probe.");

  await purgeUser(VICTIM_EMAIL);
  await purgeUser(ATTACKER_EMAIL);

  const mk = async (email: string) => {
    const { data, error } = await createFreshTestUser(admin, {
      email,
      password: PASS,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
    return data.user.id;
  };
  victimUserId = await mk(VICTIM_EMAIL);
  await mk(ATTACKER_EMAIL);

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `DIM-RLST-${Date.now().toString(36).toUpperCase().slice(-4)}`,
      name: "RLS Tags Victim Pet",
      species: "dog",
      sex: "male",
      status: "active",
    })
    .returning({ id: pets.id });
  await db.insert(ownerships).values({ petId: pet.id, ownerUserId: victimUserId, role: "owner" });

  victimSerial = generateTagSerial();
  await db.insert(petTags).values({
    serial: victimSerial,
    activationCodeHash: hashTagActivationCode("RLSP-ROBE"),
    loteId: TEST_LOTE,
    status: "active",
    petId: pet.id,
    activatedByUserId: victimUserId,
    activatedAt: new Date(),
  });

  const signIn = async (email: string) => {
    const client = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await client.auth.signInWithPassword({ email, password: PASS });
    if (error) throw new Error(`sign-in ${email}: ${error.message}`);
    return client;
  };
  victimClient = await signIn(VICTIM_EMAIL);
  attackerClient = await signIn(ATTACKER_EMAIL);
}, 30_000);

afterAll(async () => {
  await purgeUser(VICTIM_EMAIL);
  await purgeUser(ATTACKER_EMAIL);
}, 30_000);

describe("pet_tags RLS (SELECT-own, TO authenticated)", () => {
  it("the owner reads their own tag row", async () => {
    const { data, error } = await victimClient
      .from("pet_tags")
      .select("serial,status")
      .eq("serial", victimSerial);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]).toMatchObject({ serial: victimSerial, status: "active" });
  });

  it("an authenticated stranger reads ZERO rows for the victim's serial", async () => {
    const { data, error } = await attackerClient
      .from("pet_tags")
      .select("serial,status,activation_code_hash")
      .eq("serial", victimSerial);
    // RLS filters, it does not error: empty set, no oracle.
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("anon reads nothing (policy is TO authenticated, not PUBLIC)", async () => {
    const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await anonClient.from("pet_tags").select("serial").limit(5);
    if (error) {
      // Depending on grants, anon may get a hard error — also a denial.
      expect(error).not.toBeNull();
    } else {
      expect(data).toEqual([]);
    }
  });
});

// RLS — `public.profiles` has NO write surface through PostgREST.
// (Fresh-review lens A01, migration 0211_profiles_lock_postgrest_writes.sql.)
//
// WHAT THIS DEFENDS
// -----------------
// `profiles` holds the three columns the authorization layer trusts without
// re-deriving them from anything: `role`, `account_type` and `deactivated_at`
// are read by `getProfileCached` (lib/infra/request-cache.ts:74-88) and turned
// into an authorization verdict by `loadActiveInstitutionalProfile`
// (lib/infra/auth-guards.ts:177-188), the function behind
// requireAdminOrGovtOrRedirect and every guard built on it.
//
// Migration 0086 shipped
//   create policy "Profiles updatable by self" ... for update to authenticated
//     using (id = auth.uid()) with check (id = auth.uid());
// which pins the ROW and never a COLUMN. One request signed with the caller's
// own JWT —
//   PATCH /rest/v1/profiles?id=eq.<self> {"role":"admin",
//                                         "account_type":"institutional"}
// — therefore minted a universal admin, and the same surface cleared
// `deactivated_at` (undoing an admin deactivation) and `deleted_at` (undoing an
// art. 16 erasure).
//
// Nothing else covered it: `applySchemaGrants` (scripts/deploy-provision.ts:
// 533-541) re-grants ALL on every public table to `authenticated` on every
// provision, so a column REVOKE undoes itself; the account_type↔role CHECK was
// dropped in migration 0016; there is no BEFORE UPDATE trigger on profiles; and
// write-path-matrix.test.ts looks for UNCONDITIONAL clauses, while
// `id = auth.uid()` is perfectly conditional. The defect was column scope, not
// row scope.
//
// WHY DENY-ALL AND NOT A NARROWER POLICY: every legitimate writer of this table
// (update-profile, upload-avatar, complete-identity, verify-dni, the admin
// decisions, the self-deactivations, vet-self-resign, claim-stub-profile,
// seeds) writes over the Drizzle BYPASSRLS connection, which never consults
// RLS; row creation is the `handle_new_user` trigger (security definer), which
// is why there never was an INSERT policy. Zero legitimate writers reach
// `profiles` through PostgREST — the only PostgREST callers anywhere in the
// tree are SELECT probes (e2e/cross-tenant-isolation.spec.ts:480,
// scripts/rls-smoke.ts:147). So the attack probes below and the
// legitimate-path probe are not in tension: the first prove PostgREST is shut,
// the last proves the real settings path is untouched.
//
// PRE-FLIGHT: local Supabase stack. This file provisions its OWN ephemeral
// personal owner (admin SDK + the handle_new_user trigger) so no assertion
// depends on seed drift, and it deletes it again in afterAll. A setup failure
// THROWS — it never degrades to a green skip (see matrix.test.ts P2.8 for why
// that rule exists).

import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLog, db, notifications, profiles } from "@/db";
import { updateProfileForUser } from "@/src/modules/pets/application/profile/update-profile";
import { setAuditMutationGucs } from "../_helpers/db-overrides";
import { createFreshTestUser } from "../_helpers/fresh-test-user";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const VICTIM_EMAIL = "profiles-lockdown-owner@dim-test.local";
const VICTIM_PASSWORD = "ProfilesLockdown_2026!";
const SEED_DISPLAY_NAME = "Profiles lockdown owner";

let ownerClient: SupabaseClient | null = null;
let ownerUserId = "";
let setupError: string | null = null;

function adminSdk(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function deleteTestUser(email: string): Promise<void> {
  const admin = adminSdk();
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === email);
  if (!found) return;

  await db.transaction(async (tx) => {
    await setAuditMutationGucs(tx);
    await tx.delete(auditLog).where(eq(auditLog.actorUserId, found.id));
    await tx.delete(auditLog).where(eq(auditLog.targetUserId, found.id));
  });
  await db.delete(notifications).where(eq(notifications.userId, found.id));
  await db.delete(profiles).where(eq(profiles.id, found.id));
  await admin.auth.admin.deleteUser(found.id);
}

/**
 * A PostgREST credential that never reached a policy returns an empty result
 * too — and an empty result is exactly what every probe below reads as
 * "denied". Scoring a rejected key as a denial is how the anon row of the RLS
 * matrix passed for months without evaluating a policy (matrix.test.ts:704).
 */
function assertCredentialReachedRls(error: { code?: string; message: string } | null): void {
  if (!error) return;
  const credentialRejected =
    error.code?.startsWith("PGRST30") || /JWT|API key/i.test(error.message);
  if (!credentialRejected) return;
  throw new Error(
    `The profiles probe never reached a policy — PostgREST rejected the CREDENTIAL (${error.code ?? "no code"}: ${error.message}). This is NOT a denial. Check NEXT_PUBLIC_SUPABASE_ANON_KEY against \`supabase status -o env\`.`,
  );
}

function client(): SupabaseClient {
  if (setupError) throw new Error(setupError);
  if (!ownerClient) throw new Error("owner client not provisioned");
  return ownerClient;
}

/** Ground truth: Drizzle bypasses RLS, so this is what actually landed. */
async function readProfile() {
  const [row] = await db
    .select({
      role: profiles.role,
      accountType: profiles.accountType,
      displayName: profiles.displayName,
      deactivatedAt: profiles.deactivatedAt,
      deletedAt: profiles.deletedAt,
    })
    .from(profiles)
    .where(eq(profiles.id, ownerUserId));
  if (!row) throw new Error(`profile row for ${ownerUserId} vanished mid-test`);
  return row;
}

beforeAll(async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    setupError =
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing — no PostgREST to probe.";
    throw new Error(setupError);
  }

  await deleteTestUser(VICTIM_EMAIL);

  const created = await createFreshTestUser(adminSdk(), {
    email: VICTIM_EMAIL,
    password: VICTIM_PASSWORD,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    setupError = `createUser(${VICTIM_EMAIL}) failed: ${created.error?.message ?? "no user"}`;
    throw new Error(setupError);
  }
  ownerUserId = created.data.user.id;

  // handle_new_user (security definer) creates the row as (owner, personal).
  // Pin the display name so the legitimate-path assertion has a known before.
  await db
    .update(profiles)
    .set({ displayName: SEED_DISPLAY_NAME })
    .where(eq(profiles.id, ownerUserId));

  const baseline = await readProfile();
  if (baseline.role !== "owner" || baseline.accountType !== "personal") {
    setupError = `fixture is not a personal owner: role=${baseline.role} account_type=${baseline.accountType}`;
    throw new Error(setupError);
  }

  ownerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authErr } = await ownerClient.auth.signInWithPassword({
    email: VICTIM_EMAIL,
    password: VICTIM_PASSWORD,
  });
  if (authErr || !auth.user) {
    setupError = `sign-in failed for ${VICTIM_EMAIL}: ${authErr?.message ?? "no user"}`;
    throw new Error(setupError);
  }

  // ANTI-VACUITY GATE. Every probe below reads "zero rows" as "denied", so the
  // session has to be proven capable of returning a row FIRST — through the
  // SELECT policy, on this exact table, with this exact key.
  const { data: seen, error: seenErr } = await ownerClient
    .from("profiles")
    .select("id")
    .eq("id", ownerUserId);
  assertCredentialReachedRls(seenErr);
  if ((seen ?? []).length !== 1) {
    setupError = `the signed-in owner cannot read its OWN profile row through PostgREST (rows=${(seen ?? []).length}) — every deny assertion in this file would be vacuous.`;
    throw new Error(setupError);
  }
}, 30_000);

afterAll(async () => {
  await deleteTestUser(VICTIM_EMAIL);
});

describe("profiles — PostgREST write surface is closed (migration 0211)", () => {
  it("has NO INSERT / UPDATE / DELETE policy reachable by anon or authenticated", async () => {
    const rows = (await db.execute(sql`
      select p.policyname, p.cmd, array_to_string(p.roles, ',') as roles
      from pg_policies p
      where p.schemaname = 'public'
        and p.tablename = 'profiles'
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
      `profiles carries role/account_type/deactivated_at, which auth-guards reads as an authorization verdict — a write policy here is a self-service admin grant. Offenders: ${reachable
        .map((r) => `${r.policyname} (${r.cmd}, ${r.roles})`)
        .join("; ")}`,
    ).toEqual([]);
  });

  it("keeps its correctly-scoped SELECT policy (the lockdown is writes-only)", async () => {
    const rows = (await db.execute(sql`
      select p.policyname, p.qual
      from pg_policies p
      where p.schemaname = 'public' and p.tablename = 'profiles' and p.cmd = 'SELECT'
    `)) as unknown as Array<{ policyname: string; qual: string | null }>;
    expect(rows.length, "profiles lost its SELECT policy too — that is over-correction").toBe(1);
    expect(rows[0].qual ?? "").toContain("auth.uid()");
  });

  // -------------------------------------------------------------------------
  // ATTACK — the reachable-today self-minted admin
  // -------------------------------------------------------------------------
  //
  // NOTE on the shape of an UPDATE denial: with no UPDATE policy at all, RLS
  // removes the row from the statement's USING scope, so PostgREST reports
  // SUCCESS over ZERO affected rows rather than 42501. Row count + the
  // ground-truth read are what prove the denial; asserting on `error` would
  // assert the wrong thing.

  it("rejects PATCHing own row to role=admin", async () => {
    const { data, error } = await client()
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", ownerUserId)
      .select("id");

    assertCredentialReachedRls(error);
    // With no UPDATE policy, RLS removes the row from the statement's scope and
    // PostgREST reports SUCCESS over ZERO rows. A 42501 here would mean the
    // GRANT is missing, not the policy: grants are volatile (re-applied on every
    // provision), so that would be a false green for the remedy under test.
    expect(error?.message ?? null, "unexpected PostgREST error shape").toBeNull();
    expect((data ?? []).length, "PostgREST applied the role escalation").toBe(0);
    expect((await readProfile()).role, "the owner promoted itself to admin").toBe("owner");
  });

  it("rejects PATCHing own row to account_type=institutional", async () => {
    const { data, error } = await client()
      .from("profiles")
      .update({ account_type: "institutional" })
      .eq("id", ownerUserId)
      .select("id");

    assertCredentialReachedRls(error);
    expect(error?.message ?? null, "unexpected PostgREST error shape").toBeNull();
    expect((data ?? []).length, "PostgREST applied the account_type change").toBe(0);
    expect(
      (await readProfile()).accountType,
      "the personal account made itself institutional",
    ).toBe("personal");
  });

  it("rejects PATCHing away a deactivation (deactivated_at → null)", async () => {
    await db
      .update(profiles)
      .set({ deactivatedAt: new Date() })
      .where(eq(profiles.id, ownerUserId));

    const { data, error } = await client()
      .from("profiles")
      .update({ deactivated_at: null })
      .eq("id", ownerUserId)
      .select("id");

    assertCredentialReachedRls(error);
    expect(error?.message ?? null, "unexpected PostgREST error shape").toBeNull();
    expect((data ?? []).length, "PostgREST applied the reactivation").toBe(0);
    expect(
      (await readProfile()).deactivatedAt,
      "a deactivated account reactivated itself through PostgREST",
    ).not.toBeNull();

    await db.update(profiles).set({ deactivatedAt: null }).where(eq(profiles.id, ownerUserId));
  });

  it("rejects PATCHing away an art. 16 erasure (deleted_at → null)", async () => {
    await db.update(profiles).set({ deletedAt: new Date() }).where(eq(profiles.id, ownerUserId));

    const { data, error } = await client()
      .from("profiles")
      .update({ deleted_at: null })
      .eq("id", ownerUserId)
      .select("id");

    assertCredentialReachedRls(error);
    expect(error?.message ?? null, "unexpected PostgREST error shape").toBeNull();
    expect((data ?? []).length, "PostgREST applied the un-erasure").toBe(0);
    expect(
      (await readProfile()).deletedAt,
      "an erased profile un-erased itself through PostgREST",
    ).not.toBeNull();

    await db.update(profiles).set({ deletedAt: null }).where(eq(profiles.id, ownerUserId));
  });

  it("rejects PATCHing even a harmless column (display_name) — the whole surface is shut", async () => {
    // This one pins the SHAPE of the remedy, not just its effect: a
    // column-scoped fix (REVOKE on role/account_type, or a narrower policy)
    // would leave this green while the deny-all this file asserts is gone. It
    // also documents the trade — the settings form writes through Drizzle, and
    // the next test proves it still does.
    const { data, error } = await client()
      .from("profiles")
      .update({ display_name: "patched-through-postgrest" })
      .eq("id", ownerUserId)
      .select("id");

    assertCredentialReachedRls(error);
    expect(error?.message ?? null, "unexpected PostgREST error shape").toBeNull();
    expect((data ?? []).length, "PostgREST applied a display_name write").toBe(0);
    expect((await readProfile()).displayName, "display_name was writable via PostgREST").toBe(
      SEED_DISPLAY_NAME,
    );
  });

  // -------------------------------------------------------------------------
  // LEGITIMATE PATHS — a policy that denies everything is not a fix
  // -------------------------------------------------------------------------

  it("still lets the owner READ their own profile through PostgREST", async () => {
    const { data, error } = await client()
      .from("profiles")
      .select("id,display_name")
      .eq("id", ownerUserId);
    expect(error).toBeNull();
    expect((data ?? []).length, "own-row read broke — the SELECT policy was collateral").toBe(1);
  });

  it("still updates the profile through the SERVER path (updateProfileForUser, Drizzle)", async () => {
    const NEW_NAME = "Profiles lockdown owner (renamed)";
    const result = await updateProfileForUser(ownerUserId, { displayName: NEW_NAME });
    expect(result, "the legitimate settings write was blocked by the lockdown").toEqual({
      ok: true,
    });

    const after = await readProfile();
    expect(after.displayName, "the server-side display_name write did not land").toBe(NEW_NAME);
    // The use case touches only what it was asked to touch — the columns the
    // attack probes aimed at are untouched by the legitimate path.
    expect(after.role).toBe("owner");
    expect(after.accountType).toBe("personal");
  });
});

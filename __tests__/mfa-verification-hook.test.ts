// public.hook_mfa_verification_attempt — migration 0232, serialised per account
// by 0233 (an advisory lock before the read, so two concurrent attempts cannot
// both read the same count).
//
// GoTrue calls this on EVERY factor verification, through the app or not, so it
// is the only ceiling on TOTP guesses that a caller posting straight to
// `/auth/v1/factors/{id}/verify` cannot step around (the app-side budget in
// mfa-actions.ts only sees the app's own attempts). It also refuses to finish an
// ENROLMENT unless the account signed in within the last 15 minutes.
//
// The function is exercised directly, with the payload GoTrue sends, against a
// real account and a real factor: whether the LOCAL GoTrue actually calls it
// depends on supabase/config.toml [auth.hook.mfa_verification_attempt] and a
// stack restart, which this file does not assume. What it pins is the decision
// the function returns and what it counts.

import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/db";

import { totpCode } from "./_helpers/aal2-session";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const GUESSER_EMAIL = "mfa-hook-guesser@dim-test.local";
const BYSTANDER_EMAIL = "mfa-hook-bystander@dim-test.local";
const PASSWORD = "MfaHookProbe_2026!";

let service: SupabaseClient;
let guesserId = "";
let bystanderId = "";
let unverifiedFactorId = "";
let verifiedFactorId = "";

type Decision = { decision?: string; message?: string };

async function hook(userId: string, factorId: string, valid: boolean): Promise<Decision> {
  const event = JSON.stringify({
    user_id: userId,
    factor_id: factorId,
    factor_type: "totp",
    valid,
  });
  const rows = (await db.execute(
    sql`select public.hook_mfa_verification_attempt(${event}::jsonb) as out`,
  )) as unknown as Array<{ out: Decision }>;
  return rows[0]?.out ?? {};
}

async function clearBuckets(userId: string): Promise<void> {
  await db.execute(
    sql`delete from public.rate_limit_buckets where bucket_key like ${`mfa_verify_fail:${userId}:%`}`,
  );
}

async function setLastSignIn(userId: string, minutesAgo: number): Promise<void> {
  await db.execute(
    sql`update auth.users set last_sign_in_at = now() - make_interval(mins => ${minutesAgo}) where id = ${userId}::uuid`,
  );
}

async function signedIn(email: string): Promise<SupabaseClient> {
  const c = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in ${email}: ${error.message}`);
  return c;
}

beforeAll(async () => {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    throw new Error("Supabase env missing — the MFA hook suite cannot provision its accounts");
  }
  service = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  for (const email of [GUESSER_EMAIL, BYSTANDER_EMAIL]) {
    const created = await createFreshTestUser(service, {
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw new Error(`createUser ${email} failed`);
    if (email === GUESSER_EMAIL) guesserId = created.data.user.id;
    else bystanderId = created.data.user.id;
  }

  // Two real factors on the guesser: one left unverified (an enrolment in
  // progress), one verified (what every later challenge is against).
  const c = await signedIn(GUESSER_EMAIL);
  const pending = await c.auth.mfa.enroll({ factorType: "totp", friendlyName: "hook-pending" });
  if (pending.error || !pending.data) throw new Error(`enroll: ${pending.error?.message}`);
  unverifiedFactorId = pending.data.id;
  const done = await c.auth.mfa.enroll({ factorType: "totp", friendlyName: "hook-done" });
  if (done.error || !done.data) throw new Error(`enroll: ${done.error?.message}`);
  const verified = await c.auth.mfa.challengeAndVerify({
    factorId: done.data.id,
    code: totpCode(done.data.totp.secret),
  });
  if (verified.error) throw new Error(`verify: ${verified.error.message}`);
  verifiedFactorId = done.data.id;
}, 60_000);

afterAll(async () => {
  for (const id of [guesserId, bystanderId]) {
    if (!id) continue;
    await clearBuckets(id);
    await service.auth.admin.deleteUser(id);
  }
});

describe("MFA verification hook — failure ceiling (0232)", () => {
  it("lets ten wrong codes through to GoTrue's own refusal, then rejects everything — a correct code included", async () => {
    await clearBuckets(guesserId);
    await setLastSignIn(guesserId, 0);
    for (let i = 0; i < 10; i++) {
      expect((await hook(guesserId, verifiedFactorId, false)).decision).toBe("continue");
    }
    const locked = await hook(guesserId, verifiedFactorId, true);
    expect(locked.decision, "a correct code after ten misses in the hour must be refused").toBe(
      "reject",
    );
    expect(locked.message).toMatch(/Demasiados códigos incorrectos/);
    expect((await hook(guesserId, verifiedFactorId, false)).decision).toBe("reject");
  });

  it("the ceiling is per ACCOUNT: another account is untouched", async () => {
    expect((await hook(bystanderId, verifiedFactorId, true)).decision).toBe("continue");
  });

  it("counts in rate_limit_buckets with an expiry, so the limiter's cleanup reaps it", async () => {
    const rows = (await db.execute(sql`
      select bucket_key, count, expires_at > now() as live
      from public.rate_limit_buckets
      where bucket_key like ${`mfa_verify_fail:${guesserId}:%`}
      order by bucket_key
    `)) as unknown as Array<{ bucket_key: string; count: number; live: boolean }>;
    expect(rows.map((r) => r.bucket_key.split(":")[2])).toEqual(["day", "hour"]);
    expect(rows.every((r) => r.live && r.count === 10)).toBe(true);
  });

  it("a correct code with no misses on file continues", async () => {
    await clearBuckets(guesserId);
    expect((await hook(guesserId, verifiedFactorId, true)).decision).toBe("continue");
  });
});

describe("MFA verification hook — attempts on one account are serialised (0233)", () => {
  it("a code that arrives while the tenth miss is still in flight waits for it, and is refused", async () => {
    await clearBuckets(guesserId);
    await setLastSignIn(guesserId, 0);
    for (let i = 0; i < 9; i++) await hook(guesserId, verifiedFactorId, false);

    // Transaction A: the tenth wrong code, counted but NOT committed yet.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let counted!: () => void;
    const inFlight = new Promise<void>((r) => {
      counted = r;
    });
    const tenthMiss = JSON.stringify({
      user_id: guesserId,
      factor_id: verifiedFactorId,
      factor_type: "totp",
      valid: false,
    });
    const txA = db.transaction(async (tx) => {
      await tx.execute(sql`select public.hook_mfa_verification_attempt(${tenthMiss}::jsonb)`);
      counted();
      await held;
    });
    await inFlight;

    // B: a CORRECT code on another connection. Read-then-decide without the
    // per-account lock sees 9 misses (A is uncommitted) and lets it through;
    // with the lock it waits for A, sees 10, and refuses.
    const b = hook(guesserId, verifiedFactorId, true);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await txA;
    expect((await b).decision).toBe("reject");
  });
});

describe("MFA verification hook — enrolment freshness (0232)", () => {
  it("rejects finishing an enrolment when the account last signed in 20 minutes ago", async () => {
    await clearBuckets(guesserId);
    await setLastSignIn(guesserId, 20);
    const out = await hook(guesserId, unverifiedFactorId, true);
    expect(out.decision).toBe("reject");
    expect(out.message).toMatch(/hace menos de 15 minutos/);
  });

  it("lets it finish when the sign-in is five minutes old", async () => {
    await setLastSignIn(guesserId, 5);
    expect((await hook(guesserId, unverifiedFactorId, true)).decision).toBe("continue");
  });

  it("does not apply freshness to a challenge against an already-verified factor", async () => {
    await setLastSignIn(guesserId, 24 * 60);
    expect((await hook(guesserId, verifiedFactorId, true)).decision).toBe("continue");
  });
});

describe("MFA verification hook — who may call it", () => {
  it("is executable by supabase_auth_admin and by neither anon nor authenticated", async () => {
    const rows = (await db.execute(sql`
      select
        has_function_privilege('supabase_auth_admin', 'public.hook_mfa_verification_attempt(jsonb)', 'EXECUTE') as auth_admin,
        has_function_privilege('authenticated', 'public.hook_mfa_verification_attempt(jsonb)', 'EXECUTE') as authed,
        has_function_privilege('anon', 'public.hook_mfa_verification_attempt(jsonb)', 'EXECUTE') as anon
    `)) as unknown as Array<{ auth_admin: boolean; authed: boolean; anon: boolean }>;
    expect(rows[0]).toEqual({ auth_admin: true, authed: false, anon: false });
  });
});

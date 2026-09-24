// Second factor for the INSTITUTIONAL SEED ACCOUNTS in test harnesses (T2-S6).
//
// Since T2-S6 every admin / govt / national account must pass TOTP before any
// portal or action. The e2e suite and the QA scripts sign in as those seed
// accounts, so they need a factor whose secret they know. This module gives each
// such account one, and gives callers the codes.
//
// WHY NOT A FIXED SECRET. GoTrue generates the TOTP secret itself at enrolment
// and has no API to supply one (admin.mfa has list/delete only). Writing a known
// secret straight into auth.mfa_factors would couple the harness to GoTrue's
// private schema and to whether its column encryption is on. So the harness
// enrols like a person does — through the account's own session: enroll →
// challengeAndVerify with a code computed from the returned secret — and keeps
// the secret in a gitignored store file (e2e/.auth/, next to Playwright's own
// state). The app is not told anything and has no bypass.
//
// IDEMPOTENT across runs and processes:
//   · store has a secret for (project URL, user id, factor id) and GoTrue still
//     lists that factor as verified → reuse it, no enrolment.
//   · anything else (fresh DB, new user id, a factor enrolled by somebody else
//     whose secret we do not know) → delete the account's factors with the
//     service-role admin API, enrol a new one, store it.
//   · a lock file serialises enrolment between parallel Playwright workers, so
//     two workers never delete each other's fresh factor.
//
// LOCAL / CI ONLY by construction: it needs the service-role key to clear an
// unknown factor, and it rewrites the factor of whatever account it is pointed
// at. Pointing it at a shared environment where a PERSON uses the same account
// would replace that person's authenticator — so ensureSeedTotp REFUSES any
// Supabase URL whose host is not the local machine (assertLocalSupabaseUrl).
// The e2e guard in e2e/_mfa.ts checks the PAGE's host, which says nothing
// about where NEXT_PUBLIC_SUPABASE_URL points; the refusal has to live here,
// where the service key is used, so every caller gets it.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type SupabaseClient, createClient } from "@supabase/supabase-js";

import { secondsLeftInStep, totp } from "./totp";

export type SeedMfaEnv = {
  supabaseUrl: string;
  anonKey: string;
  /** Needed only to clear a factor whose secret the store does not hold. */
  serviceRoleKey?: string;
};

type StoreEntry = { secret: string; factorId: string };
type Store = Record<string, StoreEntry>;

export const TOTP_STORE_PATH = resolve(
  process.env.E2E_TOTP_STORE ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../../e2e/.auth/totp-secrets.json"),
);
const LOCK_PATH = `${TOTP_STORE_PATH}.lock`;

export function seedMfaEnvFromProcess(): SeedMfaEnv {
  return {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

/** Hosts where the harness owns the stack and may rewrite an account's factors. */
export const LOCAL_SUPABASE_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

/**
 * Throw unless `supabaseUrl` points at the local machine. `who` names the caller
 * in the message. An unparseable URL is refused too.
 */
export function assertLocalSupabaseUrl(supabaseUrl: string, who: string): void {
  let host: string | null = null;
  try {
    host = new URL(supabaseUrl).hostname;
  } catch {
    host = null;
  }
  if (host === null || !LOCAL_SUPABASE_HOSTS.has(host)) {
    throw new Error(
      `${who}: refusing to manage MFA factors on a non-local Supabase (${host ?? "unparseable URL"}); this harness is local/CI only`,
    );
  }
}

function storeKey(env: SeedMfaEnv, userId: string): string {
  return `${env.supabaseUrl}|${userId}`;
}

function readStore(): Store {
  if (!existsSync(TOTP_STORE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(TOTP_STORE_PATH, "utf8")) as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  mkdirSync(dirname(TOTP_STORE_PATH), { recursive: true });
  writeFileSync(TOTP_STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  const deadline = Date.now() + 60_000;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(LOCK_PATH, "wx");
    } catch {
      if (Date.now() > deadline) {
        // A crashed holder leaves the file behind; a minute is far longer than
        // one enrolment, so take it over rather than hang the suite.
        rmSync(LOCK_PATH, { force: true });
        continue;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    closeSync(fd);
    rmSync(LOCK_PATH, { force: true });
  }
}

function anonClient(env: SeedMfaEnv): SupabaseClient {
  return createClient(env.supabaseUrl, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * Verify a challenge, riding out GoTrue refusing a code it has just accepted
 * (replay inside one 30-second step): on a refusal, wait for the next step and
 * try once more with the fresh code.
 */
export async function verifyWithSecret(
  client: SupabaseClient,
  factorId: string,
  secret: string,
): Promise<void> {
  const first = await client.auth.mfa.challengeAndVerify({ factorId, code: totp(secret) });
  if (!first.error) return;
  await new Promise((r) => setTimeout(r, (secondsLeftInStep() + 1) * 1000));
  const second = await client.auth.mfa.challengeAndVerify({ factorId, code: totp(secret) });
  if (second.error) throw new Error(`seed-mfa: TOTP verify failed: ${second.error.message}`);
}

type FactorRef = { id: string; status: string };

/**
 * Remove every factor of the account. A VERIFIED one can only go through the
 * service-role admin API (removing it at aal1 is refused, rightly); unverified
 * ones the account removes itself.
 */
async function clearFactors(
  env: SeedMfaEnv,
  client: SupabaseClient,
  who: { userId: string; email: string; password: string },
  all: ReadonlyArray<FactorRef>,
): Promise<void> {
  if (all.length === 0) return;
  if (!all.some((f) => f.status === "verified")) {
    for (const f of all) await client.auth.mfa.unenroll({ factorId: f.id });
    return;
  }
  if (!env.serviceRoleKey) {
    throw new Error(
      `seed-mfa: ${who.email} has a verified factor whose secret this harness does not hold, and no SUPABASE_SERVICE_ROLE_KEY to clear it.`,
    );
  }
  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  for (const f of all) {
    const { error } = await admin.auth.admin.mfa.deleteFactor({ userId: who.userId, id: f.id });
    if (error) {
      throw new Error(`seed-mfa: could not clear factor of ${who.email}: ${error.message}`);
    }
  }
  // Deleting a verified factor may change what this session is; sign in again.
  await client.auth.signInWithPassword({ email: who.email, password: who.password });
}

/**
 * The TOTP secret of `email`'s verified factor, enrolling one if needed.
 * The account must be one the harness owns (a seed account on a local/CI stack).
 */
export type SeedTotp = {
  secret: string;
  /**
   * A factor was enrolled (verified) by THIS call. GoTrue then ends every other
   * aal1 session of the account — measured: the browser that had just typed
   * the password was bounced to the sign-in page. A caller holding such a
   * session must sign in again before answering the challenge.
   */
  enrolledNow: boolean;
};

export async function ensureSeedTotpSecret(
  env: SeedMfaEnv,
  email: string,
  password: string,
): Promise<string> {
  return (await ensureSeedTotp(env, email, password)).secret;
}

export async function ensureSeedTotp(
  env: SeedMfaEnv,
  email: string,
  password: string,
): Promise<SeedTotp> {
  assertLocalSupabaseUrl(env.supabaseUrl, "seed-mfa");
  return withLock(async () => {
    const client = anonClient(env);
    const { data: signIn, error: signInError } = await client.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError || !signIn.user) {
      throw new Error(`seed-mfa: sign-in failed for ${email}: ${signInError?.message}`);
    }
    const userId = signIn.user.id;
    const key = storeKey(env, userId);
    const store = readStore();
    const known = store[key];

    const { data: listed } = await client.auth.mfa.listFactors();
    const verified = listed?.totp ?? [];
    if (known && verified.some((f) => f.id === known.factorId)) {
      await client.auth.signOut({ scope: "local" });
      return { secret: known.secret, enrolledNow: false };
    }

    // Unknown or stale: clear every factor of the account, then enrol afresh.
    await clearFactors(env, client, { userId, email, password }, listed?.all ?? []);

    const { data: enrolled, error: enrolError } = await client.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `e2e-${Date.now()}`,
    });
    if (enrolError || !enrolled) {
      throw new Error(`seed-mfa: enrol failed for ${email}: ${enrolError?.message}`);
    }
    await verifyWithSecret(client, enrolled.id, enrolled.totp.secret);

    writeStore({ ...readStore(), [key]: { secret: enrolled.totp.secret, factorId: enrolled.id } });
    await client.auth.signOut({ scope: "local" });
    return { secret: enrolled.totp.secret, enrolledNow: true };
  });
}

/**
 * Is this signed-in client's account an institutional principal?
 *
 * Read with the SERVICE ROLE when the key is present, because the profile read
 * must not depend on the very assurance level this is deciding about: once RLS
 * requires aal2 for institutional sessions (the mfa-harden change), an aal1
 * client may see no profile row at all and would be misread as personal.
 * Without the key it falls back to the account's own read, and a verified
 * factor on the account (which only institutional accounts can enrol) also
 * counts.
 */
export async function isInstitutionalSession(
  client: SupabaseClient,
  env: SeedMfaEnv = seedMfaEnvFromProcess(),
): Promise<boolean> {
  const { data: userData } = await client.auth.getUser();
  const user = userData.user;
  if (!user) return false;
  if ((user.factors ?? []).some((f) => f.status === "verified")) return true;
  const reader = env.serviceRoleKey
    ? createClient(env.supabaseUrl, env.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : client;
  const { data } = await reader
    .from("profiles")
    .select("account_type, role")
    .eq("id", user.id)
    .maybeSingle();
  const row = data as { account_type?: string; role?: string } | null;
  return (
    row?.account_type === "institutional" ||
    row?.role === "admin" ||
    row?.role === "govt" ||
    row?.role === "national"
  );
}

/**
 * For API-driven scripts: after `client` signed in with a password, bring its
 * session to aal2 when the account is institutional (no-op otherwise). The
 * client's session then carries the aal2 token every cookie/bearer built from
 * it needs.
 */
export async function upgradeSeedSessionToAal2(
  client: SupabaseClient,
  email: string,
  password: string,
  env: SeedMfaEnv = seedMfaEnvFromProcess(),
): Promise<void> {
  if (!(await isInstitutionalSession(client, env))) return;
  const { secret, enrolledNow } = await ensureSeedTotp(env, email, password);
  // A fresh enrolment ended this client's aal1 session (see SeedTotp).
  if (enrolledNow) {
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(`seed-mfa: re-sign-in failed for ${email}: ${error.message}`);
  }
  const { data: listed } = await client.auth.mfa.listFactors();
  const factor = listed?.totp?.[0];
  if (!factor) throw new Error(`seed-mfa: ${email} has no verified factor after enrolment`);
  await verifyWithSecret(client, factor.id, secret);
}

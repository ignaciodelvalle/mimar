// Raise a signed-in test client to an `aal2` session, the way a person does it.
//
// Since migration 0231 an institutional principal (admin, govt, national) whose
// token is not `aal2` reads nothing through PostgREST on the institution-
// granting tables, and `pii.caller_is_admin` refuses it. A test that signs in an
// institutional account with a password therefore holds an `aal1` token and is
// now — correctly — the attacker the migration closes out. Tests that exercise
// the LEGITIMATE institutional path must pass the second factor first.
//
// HOW. Through the account's own session, with nothing the app does not also
// do: enrol a TOTP factor, compute the current code from the secret GoTrue
// returns (RFC 6238, below), `challengeAndVerify` — which rewrites the client's
// in-memory session with the aal2 token GoTrue mints. Then the temporary factor
// is DELETED with the service-role admin API, so the account is left exactly as
// it was found (no factor → the app still sends it to /mfa/configurar). The
// aal2 access token keeps working for PostgREST until it expires (an hour on
// the local stack): PostgREST checks the signature and `exp`, never GoTrue's
// factor table.
//
// A FACTOR SOMEBODY ELSE LEFT. GoTrue refuses a NEW enrolment from an aal1
// session when the account already has a verified factor ("AAL2 required to
// enroll a new factor", measured on local GoTrue v2.188.1). Two owners exist:
//   · this helper, after a run that died between verify and delete — its
//     factors carry TEMP_FACTOR_PREFIX and are removed on sight;
//   · the e2e MFA seed (scripts/lib/seed-mfa.ts on pilot/t2-auth), which keeps
//     the secret in a gitignored store. When that store holds a live secret for
//     the account it is USED, and nothing is deleted. Otherwise the unknown
//     factor is removed, which is exactly what that seed itself does with a
//     factor whose secret it does not hold — it re-enrols on its next run.
//
// LOCAL / CI ONLY. It deletes factors of whatever account it is handed; it must
// never be pointed at an environment where a person uses the account — so it
// refuses a NEXT_PUBLIC_SUPABASE_URL whose host is not the local machine, with
// the same check the e2e seed uses (assertLocalSupabaseUrl).
//
// SERIALISED across vitest workers with a lock file: two files elevating the
// same seed account at once would each see the other's freshly verified factor
// and be refused the enrolment.

import { createHmac } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { type SupabaseClient, createClient } from "@supabase/supabase-js";

import { assertLocalSupabaseUrl } from "@/scripts/lib/seed-mfa";

export const TEMP_FACTOR_PREFIX = "rls-aal2-";

const LOCK_PATH = join(tmpdir(), "dim-aal2-session.lock");
const LOCK_STALE_MS = 60_000;
const E2E_TOTP_STORE = resolve(
  process.env.E2E_TOTP_STORE ?? resolve(process.cwd(), "e2e/.auth/totp-secrets.json"),
);

// ---------------------------------------------------------------------------
// RFC 6238 (TOTP, SHA-1, 6 digits, 30 s) over an RFC 4648 base32 secret.
// ---------------------------------------------------------------------------

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error(`aal2-session: invalid base32 character ${JSON.stringify(ch)}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(secret: string, at: number = Date.now()): string {
  const counter = Math.floor(at / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}

function msToNextStep(at: number = Date.now()): number {
  return 30_000 - (at % 30_000);
}

// ---------------------------------------------------------------------------

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_STALE_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(LOCK_PATH, "wx");
    } catch {
      if (Date.now() > deadline) {
        // A crashed holder leaves the file; one elevation takes seconds.
        rmSync(LOCK_PATH, { force: true });
        continue;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  try {
    return await fn();
  } finally {
    closeSync(fd);
    rmSync(LOCK_PATH, { force: true });
  }
}

type StoreEntry = { secret: string; factorId: string };

function storedSecret(supabaseUrl: string, userId: string): StoreEntry | null {
  if (!existsSync(E2E_TOTP_STORE)) return null;
  try {
    const store = JSON.parse(readFileSync(E2E_TOTP_STORE, "utf8")) as Record<string, StoreEntry>;
    return store[`${supabaseUrl}|${userId}`] ?? null;
  } catch {
    return null;
  }
}

/** challengeAndVerify, riding out one replay refusal inside a 30 s step. */
async function verifyWith(client: SupabaseClient, factorId: string, secret: string) {
  const first = await client.auth.mfa.challengeAndVerify({ factorId, code: totpCode(secret) });
  if (!first.error) return;
  await new Promise((r) => setTimeout(r, msToNextStep() + 1_000));
  const second = await client.auth.mfa.challengeAndVerify({ factorId, code: totpCode(secret) });
  if (second.error) throw new Error(`aal2-session: TOTP verify failed: ${second.error.message}`);
}

/** The `aal` claim of the client's current access token. */
export async function sessionAal(client: SupabaseClient): Promise<string | null> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  return typeof payload.aal === "string" ? payload.aal : null;
}

/**
 * Raise `client` (already signed in with a password) to aal2. The service-role
 * client it builds from the environment is used ONLY to list and delete factors.
 */
export async function elevateToAal2(client: SupabaseClient): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      "aal2-session: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — cannot manage factors",
    );
  }
  assertLocalSupabaseUrl(supabaseUrl, "aal2-session");
  const serviceClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await client.auth.getUser();
  const userId = userData.user?.id;
  if (userErr || !userId) {
    throw new Error(`aal2-session: client is not signed in (${userErr?.message ?? "no user"})`);
  }

  await withLock(async () => {
    const listed = await serviceClient.auth.admin.mfa.listFactors({ userId });
    if (listed.error) throw new Error(`aal2-session: listFactors: ${listed.error.message}`);
    let factors = listed.data.factors;

    for (const f of factors) {
      if ((f.friendly_name ?? "").startsWith(TEMP_FACTOR_PREFIX)) {
        await serviceClient.auth.admin.mfa.deleteFactor({ userId, id: f.id });
      }
    }
    factors = factors.filter((f) => !(f.friendly_name ?? "").startsWith(TEMP_FACTOR_PREFIX));

    const verified = factors.filter((f) => f.status === "verified");
    const stored = storedSecret(supabaseUrl, userId);
    if (stored && verified.some((f) => f.id === stored.factorId)) {
      await verifyWith(client, stored.factorId, stored.secret);
      return;
    }
    for (const f of factors) {
      await serviceClient.auth.admin.mfa.deleteFactor({ userId, id: f.id });
    }

    const enrolled = await client.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `${TEMP_FACTOR_PREFIX}${Date.now()}`,
    });
    if (enrolled.error || !enrolled.data) {
      throw new Error(`aal2-session: enroll failed: ${enrolled.error?.message ?? "no data"}`);
    }
    try {
      await verifyWith(client, enrolled.data.id, enrolled.data.totp.secret);
    } finally {
      await serviceClient.auth.admin.mfa.deleteFactor({ userId, id: enrolled.data.id });
    }
  });

  const aal = await sessionAal(client);
  if (aal !== "aal2") throw new Error(`aal2-session: session is ${aal ?? "unreadable"}, not aal2`);
}

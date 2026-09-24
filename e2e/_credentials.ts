// e2e/_credentials.ts
//
// The one password every e2e login uses. Locally it is the literal every
// seed script writes — harmless, because it never leaves a throwaway local
// Postgres. Against a REMOTE origin (playwright.staging.config.ts →
// https://dim-staging.vercel.app, or an ad-hoc STAGING_URL run) that same
// literal is published in this public repo, so a remote run instead reads
// E2E_STAGING_PASSWORD from the environment and refuses to run without it
// (C4b, 2026-09-23).
//
// E2E_STAGING_PASSWORD is the rotated password of EXACTLY the eight accounts
// in ROTATED_E2E_ACCOUNTS below (scripts/ops/rotate-staging-e2e-password.ts
// sets it on those eight and nowhere else). Typing it into any OTHER account
// on a remote target is refused before the password field is touched — see
// remoteLoginRefusal. The institutional ones (admin@, govt@, …) are locked on
// staging and owe a second factor e2e never enrols remotely (e2e/_mfa.ts).
//
// Detection mirrors e2e/_mfa.ts's LOCAL_HOSTS check: the hostname actually
// being signed into (from the page's current URL, or from the Supabase
// project URL for a direct Auth API call) — never a guess made once at
// import time, since the very same spec file runs under both
// playwright.config.ts (local) and playwright.staging.config.ts (remote).
//
// This module is PURE (no @playwright/test import) so vitest can pin it:
// __tests__/e2e-credentials-remote.test.ts.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The literal every seed script writes locally. Never use this directly for a remote login. */
export const LOCAL_LITERAL_PASSWORD = "Test1234!";

/**
 * The eight staging accounts whose password the rotation script sets to
 * E2E_STAGING_PASSWORD. scripts/ops/rotate-staging-e2e-password.ts keeps its
 * own copy in plain sight on purpose; a unit test pins the two as equal.
 */
export const ROTATED_E2E_ACCOUNTS = [
  "owner@dim.test",
  "owner2@dim.test",
  "orgadmin@dim.test",
  "alejo@dim.test",
  "vet@dim.test",
  "lilian@dim.test",
  "graciela@dim.test",
  "carla@dim.test",
] as const;

const ROTATED = new Set<string>(ROTATED_E2E_ACCOUNTS);

function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

/** Is this URL on the local machine? Parsed, never substring-matched; unparseable → not local. */
export function isLocalOrigin(url: string): boolean {
  try {
    return isLocalHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Why a login as `email` on the origin of `pageUrl` must NOT happen — or null
 * when it may. Local: always allowed. Remote: only the rotated accounts, the
 * only ones E2E_STAGING_PASSWORD is the password of. Call it BEFORE typing
 * anything into the login form.
 */
export function remoteLoginRefusal(pageUrl: string, email: string): string | null {
  if (isLocalOrigin(pageUrl)) return null;
  if (ROTATED.has(email.toLowerCase())) return null;
  let host = pageUrl;
  try {
    host = new URL(pageUrl).host;
  } catch {
    // keep the raw string for the message
  }
  return `${email} is not one of the rotated e2e accounts; e2e never signs into it on a remote target (${host})`;
}

function requireStagingPassword(hostname: string): string {
  const fromEnv = process.env.E2E_STAGING_PASSWORD;
  if (!fromEnv || fromEnv.trim() === "") {
    throw new Error(
      [
        `E2E_STAGING_PASSWORD is not set (or is blank), and the target (${hostname}) is not local.`,
        "The local seed literal is published in this public repo (scripts/seed-test-users.ts)",
        "and must never be used to log into a real staging account.",
        "Set E2E_STAGING_PASSWORD (the rotated password for the e2e staging accounts) and re-run.",
      ].join(" "),
    );
  }
  if (fromEnv === LOCAL_LITERAL_PASSWORD) {
    throw new Error(
      `E2E_STAGING_PASSWORD equals the published local seed literal; refusing to use it against ${hostname}. Rotate with scripts/ops/rotate-staging-e2e-password.ts.`,
    );
  }
  return fromEnv;
}

/**
 * The password for `email` on `hostname`, or a thrown refusal. Remote: only a
 * rotated account may receive E2E_STAGING_PASSWORD — that is the one account
 * set it is the password of, and typing it into any other account (a locked
 * institutional one, a reserved seed persona) is the same leak the rotation
 * closed, one account over. The refusal is checked BEFORE the env var is read,
 * so a spec that forgot its skip fails loudly instead of typing it anywhere.
 */
function resolvePassword(url: string, email: string): string {
  const { hostname } = new URL(url);
  if (isLocalHostname(hostname)) return LOCAL_LITERAL_PASSWORD;
  const refusal = remoteLoginRefusal(url, email);
  if (refusal) throw new Error(refusal);
  return requireStagingPassword(hostname);
}

/**
 * Resolves the login password for `email` on the origin a Playwright page
 * currently sits on. Call this AFTER navigating to the sign-in route (or any
 * page on the target origin) so `pageUrl` reflects the real host. The account
 * is REQUIRED: on a remote origin a non-rotated account throws (pair it with
 * e2e/_mfa.ts's skipUnlessRemoteLoginAllowed to skip instead of fail).
 */
export function passwordForPage(pageUrl: string, email: string): string {
  return resolvePassword(pageUrl, email);
}

/**
 * Resolves the login password for `email` against a Supabase project URL —
 * for specs that sign in directly via `@supabase/supabase-js` (e.g.
 * `signInWithPassword`) instead of driving the app's own login page. Same
 * refusal as passwordForPage for a non-rotated account on a remote project.
 */
export function passwordForSupabaseUrl(supabaseUrl: string, email: string): string {
  return resolvePassword(supabaseUrl, email);
}

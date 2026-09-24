#!/usr/bin/env tsx
/**
 * rotate-staging-e2e-password.ts — rotate the shared password of the 8
 * staging accounts the nightly e2e suite signs into, store it as the
 * E2E_STAGING_PASSWORD GitHub Actions secret, and end every session those
 * accounts had. The password is never printed, written to a file, or put on
 * a command line.
 *
 * WHY THIS EXISTS (C4b, 2026-09-23)
 * ----------------------------------
 * `playwright.staging.config.ts` (via `dim-interno:.github/workflows/e2e-nightly.yml`)
 * logs into 8 REAL staging accounts — owner@, owner2@, orgadmin@, alejo@,
 * vet@, lilian@, graciela@, carla@ (all @dim.test) — which used to share the
 * literal password every seed writes locally, published in this public repo.
 * `e2e/_credentials.ts` now refuses that literal against any non-local target
 * and reads `E2E_STAGING_PASSWORD` instead; this script gives that secret a
 * value nobody but Actions ever sees.
 *
 * WHAT IT DOES, IN THIS ORDER (the logic lives in ./_rotate-e2e-password.ts,
 * where each step's reason is written out and a unit test pins the order)
 * -------------------------------------------------------------------------
 *   0. Refuses any target but the staging project (ref agnwyifsdxxoznodutgq).
 *   1. Checks `gh` is installed, authenticated, and can list the Actions
 *      secrets of --repo. Not ready → exits before touching any account.
 *   2. Resolves all 8 accounts (read-only). One missing → exits, nothing
 *      changed.
 *   DRY RUN (the default) stops here.
 *   3. --apply: generates 32 random bytes (base64url) and sets them on the 8
 *      accounts via the Auth Admin API, stopping at the first failure and
 *      naming the accounts already changed.
 *   4. Only after all 8 succeeded: spawns
 *      `gh secret set E2E_STAGING_PASSWORD --repo <repo>` with the password
 *      on its STDIN, and checks gh's exit code.
 *   5. Ends every existing session of the 8 accounts. The Admin API password
 *      update does NOT revoke sessions already issued, so this signs each
 *      account in once with the new password and calls
 *      `auth.admin.signOut(jwt, "global")` — supabase-js's supported way to
 *      end all of a user's sessions (it needs a JWT of that user; there is no
 *      by-user-id variant). If that fails for any account, the script prints
 *      the fallback SQL for staging:
 *        delete from auth.sessions where user_id in
 *          (select id from auth.users where email in (...));
 *      WHAT STEP 5 DOES NOT DO: an ACCESS token (JWT) already issued stays
 *      valid until it expires (~1 h, the project's JWT expiry). Ending a
 *      session revokes its refresh token, so it cannot be RENEWED, but a
 *      stateless JWT already in someone's hands is still accepted until its
 *      `exp`. Treat the hour after a rotation as still exposed.
 *
 * PARTIAL FAILURE: re-run the same command. Every run generates a new
 * password, sets it on all 8 wherever the previous run stopped, re-sets the
 * secret and revokes every session. The one state a failed run can leave —
 * some or all accounts on a password nobody holds — is exactly what a re-run
 * fixes; until then the nightly fails its logins, loudly, and nothing leaks.
 *
 * USAGE (Ignacio only — Ignacio-gated, like every write against a remote
 * project in this repo)
 * -----------------------------------------------------------------------
 *   Dry run (checks gh + target + the 8 accounts, changes nothing):
 *     node --env-file=.env.staging.local --import tsx \
 *       scripts/ops/rotate-staging-e2e-password.ts --repo ignaciodelvalle/dim-interno
 *
 *   Apply:
 *     node --env-file=.env.staging.local --import tsx \
 *       scripts/ops/rotate-staging-e2e-password.ts --repo ignaciodelvalle/dim-interno --apply
 *
 *   The secret lives in the PRIVATE companion repository since 2026-09-24:
 *   the staging nightlies that read it moved there from this public one.
 *   No pipe: the script calls gh itself. Nothing it prints is secret.
 *   (Documented in e2e/README.md next to E2E_STAGING_PASSWORD.)
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the
 * environment (e.g. `--env-file=.env.staging.local`, the convention
 * `scripts/ops/apply-ops-sql.ts` uses). Never reads DATABASE_URL: Auth API
 * only, no direct Postgres connection.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import { type SupabaseClient, createClient } from "@supabase/supabase-js";

import {
  type GhCheck,
  type GhSetResult,
  type RotationDeps,
  parseCliArgs,
  runRotation,
  stagingTargetProblem,
} from "./_rotate-e2e-password";

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

type RunResult = { exitCode: number; stdout: string; stderr: string };

/** Runs `gh` without a shell; `input` (if any) goes to its stdin and nowhere else. */
function runGh(args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("gh", args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ exitCode: 127, stdout: "", stderr: String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => resolve({ exitCode: 127, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    // No trailing newline: gh stores stdin verbatim.
    child.stdin?.end(input ?? "");
  });
}

async function checkGh(repo: string): Promise<GhCheck> {
  const version = await runGh(["--version"]);
  if (version.exitCode !== 0)
    return { ok: false, reason: "the gh CLI is not installed or not on PATH" };
  const auth = await runGh(["auth", "status"]);
  if (auth.exitCode !== 0)
    return { ok: false, reason: "gh is not authenticated (run `gh auth login`)" };
  const list = await runGh(["secret", "list", "--repo", repo]);
  if (list.exitCode !== 0) {
    return {
      ok: false,
      reason: `gh cannot list the Actions secrets of ${repo}: ${list.stderr.trim() || `exit ${list.exitCode}`}`,
    };
  }
  return { ok: true };
}

async function setSecret(repo: string, name: string, password: string): Promise<GhSetResult> {
  const r = await runGh(["secret", "set", name, "--repo", repo], password);
  return { exitCode: r.exitCode, stderr: r.stderr };
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if ("error" in parsed) fail(parsed.error);

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  const targetProblem = stagingTargetProblem(SUPABASE_URL);
  if (targetProblem) fail(`Refusing to run: ${targetProblem}`);
  if (!SERVICE_ROLE_KEY) {
    fail(
      "Missing SUPABASE_SERVICE_ROLE_KEY. Run with --env-file=.env.staging.local (see the header).",
    );
  }

  const clientOptions = { auth: { autoRefreshToken: false, persistSession: false } };
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, clientOptions);

  const deps: RotationDeps = {
    checkGh,
    async findUserId(email) {
      let page = 1;
      while (true) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw new Error(`listUsers failed on page ${page}: ${error.message}`);
        const hit = data.users.find((u) => u.email === email);
        if (hit) return hit.id;
        if (data.users.length < 200) return null;
        page++;
      }
    },
    async setPassword(userId, password) {
      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) throw new Error(error.message);
    },
    setSecret,
    async revokeSessions(email, password) {
      // A throwaway client per account, so no session is shared or persisted.
      const userClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, clientOptions);
      const { data, error } = await userClient.auth.signInWithPassword({ email, password });
      if (error || !data.session)
        throw new Error(`sign-in failed: ${error?.message ?? "no session"}`);
      const out = await admin.auth.admin.signOut(data.session.access_token, "global");
      if (out.error) throw new Error(`signOut failed: ${out.error.message}`);
    },
    generatePassword: () => randomBytes(32).toString("base64url"),
    log: (m) => console.error(m),
  };

  console.error(`Target: ${SUPABASE_URL} (staging)`);
  console.error(`Repo:   ${parsed.repo}`);
  const outcome = await runRotation(deps, parsed);
  process.exit(outcome.status === "done" || outcome.status === "dry-run" ? 0 : 1);
}

main().catch((err) => {
  // The password lives only inside runRotation; an escaped error here comes
  // from setup (client creation, argv) and cannot carry it.
  console.error(err?.stack ?? err);
  process.exit(1);
});

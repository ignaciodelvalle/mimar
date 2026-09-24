/**
 * _rotate-e2e-password.ts — the pure core of
 * scripts/ops/rotate-staging-e2e-password.ts.
 *
 * Everything with a side effect (the Supabase Admin API, the `gh` CLI, the
 * random generator, the log) comes in through `RotationDeps`, so the ORDER of
 * operations — the part that decides whether a failure leaves the secret and
 * the accounts out of sync — is pinned by __tests__/rotate-staging-e2e-
 * password.test.ts without touching a real project or a real repo.
 *
 * The order, and why each step sits where it does (security review of C4b,
 * 2026-09-23):
 *
 *   1. `gh` is installed, authenticated and can see the repo's secrets —
 *      checked BEFORE any account is touched. A rotation whose new password
 *      then cannot be stored leaves eight accounts on a value nobody holds.
 *   2. All eight accounts are resolved to ids — still read-only, so a missing
 *      account aborts with nothing changed.
 *   3. The eight passwords are set, stopping at the first failure. The report
 *      names exactly which accounts already carry the new value.
 *   4. ONLY after all eight succeeded is the password handed to
 *      `gh secret set` (on its stdin, never argv, never a file, never stdout).
 *      A failed `gh` is reported with its exit code.
 *   5. Every existing session of the eight accounts is revoked. The Admin
 *      API's password update does not end sessions already issued, so without
 *      this step whoever held a session under the OLD (published) password
 *      would keep it.
 *
 * Recovery from ANY partial failure is the same: run the script again. It
 * generates a new password, sets it on all eight regardless of where the last
 * run stopped, stores it, and revokes every session.
 *
 * Nothing in here ever logs the password — not on success, not in an error.
 */

/** The staging project. The script refuses any other target. */
export const STAGING_PROJECT_REF = "agnwyifsdxxoznodutgq";

/** The name of the GitHub Actions secret the nightly e2e job reads. */
export const SECRET_NAME = "E2E_STAGING_PASSWORD";

/**
 * The exact 8 accounts the nightly e2e suite (playwright.staging.config.ts)
 * signs into on staging. Named in plain sight here on purpose — a script that
 * rotates real credentials should show its targets to whoever reviews it. A
 * unit test pins this list equal to ROTATED_E2E_ACCOUNTS in e2e/_credentials.ts.
 */
export const E2E_ACCOUNTS = [
  "owner@dim.test",
  "owner2@dim.test",
  "orgadmin@dim.test",
  "alejo@dim.test",
  "vet@dim.test",
  "lilian@dim.test",
  "graciela@dim.test",
  "carla@dim.test",
] as const;

export type CliOptions = { apply: boolean; repo: string };

/** `owner/name`, GitHub's own charset. */
const REPO_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Parses argv; returns an error message instead of throwing. */
export function parseCliArgs(argv: readonly string[]): CliOptions | { error: string } {
  let apply = false;
  let repo: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--repo") {
      repo = argv[i + 1] ?? null;
      i++;
    } else if (arg.startsWith("--repo=")) repo = arg.slice("--repo=".length);
    else return { error: `Unknown argument: ${arg}` };
  }
  if (!repo)
    return {
      error:
        "--repo <owner>/<name> is required (the repo whose secret to set — today ignaciodelvalle/dim-interno).",
    };
  if (!REPO_SHAPE.test(repo))
    return { error: `--repo must look like <owner>/<name>, got "${repo}".` };
  return { apply, repo };
}

/**
 * The project ref of a Supabase API URL (`https://<ref>.supabase.co`), or
 * null for anything else — a custom domain, a local stack, garbage.
 */
export function projectRefFromSupabaseUrl(url: string): string | null {
  let hostname: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
  return hostname.match(/^([a-z0-9]{20})\.supabase\.co$/)?.[1] ?? null;
}

/** Why `url` is not the staging project, or null when it is. */
export function stagingTargetProblem(url: string): string | null {
  if (!url) return "NEXT_PUBLIC_SUPABASE_URL is not set.";
  const ref = projectRefFromSupabaseUrl(url);
  if (ref === null) {
    return `${url} is not a Supabase project API URL (https://<ref>.supabase.co).`;
  }
  if (ref !== STAGING_PROJECT_REF) {
    return `${url} is project ${ref}, not staging (${STAGING_PROJECT_REF}). This script rotates staging ONLY.`;
  }
  return null;
}

export type GhCheck = { ok: true } | { ok: false; reason: string };
export type GhSetResult = { exitCode: number; stderr: string };

export type RotationDeps = {
  /** gh installed + authenticated + can list the repo's Actions secrets. */
  checkGh(repo: string): Promise<GhCheck>;
  findUserId(email: string): Promise<string | null>;
  setPassword(userId: string, password: string): Promise<void>;
  /** `gh secret set <name> --repo <repo>` with `password` on stdin. */
  setSecret(repo: string, name: string, password: string): Promise<GhSetResult>;
  /** Ends every session of the account (global sign-out). */
  revokeSessions(email: string, password: string): Promise<void>;
  generatePassword(): string;
  /** Progress/diagnostics. Never receives the password. */
  log(message: string): void;
};

export type RotationOutcome =
  | { status: "dry-run" }
  | { status: "gh-unavailable"; reason: string }
  | { status: "account-missing"; missing: string[] }
  | { status: "rotation-failed"; failedAt: string; rotated: string[]; reason: string }
  | { status: "secret-failed"; exitCode: number; reason: string }
  | { status: "revoke-failed"; failed: string[] }
  | { status: "done" };

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Scrubs `secret` out of a message before it is logged. Defence in depth: no
 * dependency is expected to echo the password back, but an error string is
 * the one place a value could come back uninvited.
 */
export function scrub(message: string, secret: string): string {
  return secret ? message.split(secret).join("[redacted]") : message;
}

export async function runRotation(deps: RotationDeps, opts: CliOptions): Promise<RotationOutcome> {
  const { log } = deps;

  // 1. gh first — before anything is read, let alone written.
  const gh = await deps.checkGh(opts.repo);
  if (!gh.ok) {
    log(`gh is not ready: ${gh.reason}. No account was touched.`);
    return { status: "gh-unavailable", reason: gh.reason };
  }
  log(`gh OK — can manage Actions secrets of ${opts.repo}.`);

  // 2. Resolve every account (read-only).
  const ids = new Map<string, string>();
  const missing: string[] = [];
  for (const email of E2E_ACCOUNTS) {
    const id = await deps.findUserId(email);
    if (id) ids.set(email, id);
    else missing.push(email);
  }
  if (missing.length > 0) {
    log(`Missing on the target: ${missing.join(", ")}. No account was touched.`);
    return { status: "account-missing", missing };
  }
  log(`All ${E2E_ACCOUNTS.length} accounts found.`);

  if (!opts.apply) {
    log("DRY RUN — no password was generated and nothing was changed. Re-run with --apply.");
    return { status: "dry-run" };
  }

  // 3. Rotate, abort on the first failure.
  const password = deps.generatePassword();
  const rotated: string[] = [];
  for (const email of E2E_ACCOUNTS) {
    try {
      await deps.setPassword(ids.get(email) as string, password);
    } catch (err) {
      const reason = scrub(errMessage(err), password);
      log(
        `FAILED on ${email}: ${reason}. Already rotated (now on a password nobody holds): ${
          rotated.length ? rotated.join(", ") : "none"
        }. The GitHub secret was NOT changed. Re-run the script: it rotates all ${E2E_ACCOUNTS.length} again and sets the secret.`,
      );
      return { status: "rotation-failed", failedAt: email, rotated, reason };
    }
    rotated.push(email);
    log(`  OK  ${email}`);
  }

  // 4. Store the secret — only now that all eight hold it.
  const set = await deps.setSecret(opts.repo, SECRET_NAME, password);
  if (set.exitCode !== 0) {
    const reason = scrub(set.stderr.trim() || "(no stderr)", password);
    log(
      `gh secret set exited ${set.exitCode}: ${reason}. All ${E2E_ACCOUNTS.length} accounts carry a password the secret does NOT hold — the nightly will fail its logins. Re-run the script (it rotates all ${E2E_ACCOUNTS.length} again and re-sets the secret).`,
    );
    return { status: "secret-failed", exitCode: set.exitCode, reason };
  }
  log(`Secret ${SECRET_NAME} set on ${opts.repo}.`);

  // 5. End every session issued before the rotation.
  const failed: string[] = [];
  for (const email of E2E_ACCOUNTS) {
    try {
      await deps.revokeSessions(email, password);
      log(`  sessions revoked  ${email}`);
    } catch (err) {
      failed.push(email);
      log(`  sessions NOT revoked  ${email}: ${scrub(errMessage(err), password)}`);
    }
  }
  if (failed.length > 0) {
    log(
      `Passwords rotated and secret set, but old sessions of ${failed.join(", ")} may still be live. Revoke them with SQL on staging: ${revokeSessionsSql(failed)}`,
    );
    return { status: "revoke-failed", failed };
  }

  log(`Done: ${E2E_ACCOUNTS.length} accounts rotated, secret set, every prior session revoked.`);
  return { status: "done" };
}

/**
 * The manual fallback for step 5: deleting an account's rows from
 * auth.sessions ends them (auth.refresh_tokens cascade on session_id). Emails
 * come only from E2E_ACCOUNTS, never from input.
 */
export function revokeSessionsSql(emails: readonly string[]): string {
  const list = emails.map((e) => `'${e.replace(/'/g, "''")}'`).join(", ");
  return `delete from auth.sessions where user_id in (select id from auth.users where email in (${list}));`;
}

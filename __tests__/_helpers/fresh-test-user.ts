// Create a fixture auth user that survives the residue of a run that died.
//
// Why this exists: test files create auth users with FIXED emails
// (`br-flow-admin@dim-test.local`, ...) and clean them up in `afterAll`. A run
// that is killed or crashes mid-flight never reaches `afterAll`, so the users
// stay behind, and the next run's `createUser` answers "A user with this email
// address has already been registered" — the file reports BROKEN before a
// single assertion runs. On 2026-09-18 one dead run left ~70 of them and four
// files broke on the next gate.
//
// Most files DID try to guard against this, by looking the email up first with
// `auth.admin.listUsers()` and deleting or reusing the match. That guard is
// silently truncated: `listUsers()` without arguments returns only the FIRST
// PAGE (50 users). Once the local database holds more than 50 auth users —
// seeds plus any residue — a leftover past page one is invisible to the lookup,
// and the create that follows fails anyway.
//
// The repair is to make the create itself idempotent: try it; if GoTrue says
// the email is taken, find the stale user by paging through EVERY user, delete
// it with the same `deleteUser` call test cleanups use, and create it again.
// The return shape is exactly `createUser`'s, so call sites keep their own
// error handling unchanged.
//
// Hard guard: it refuses any email outside `@dim-test.local`, before any
// network call, so it can never delete a seeded `@dim.test` account or
// anything real.
//
// `deleteTestUser` below closes the OTHER half of the same class of bug:
// `public.profiles` carries NO foreign key to `auth.users` (by design — see
// migration history), so `client.auth.admin.deleteUser(id)` alone removes
// the auth user and leaves the profile row behind — active, with whatever
// role/accountType the test last set. Two fixture emails
// (`uc-cd-admin@dim-test.local`, `tag-issuer-admin@dim-test.local`) did
// exactly this every run, each leaking an ACTIVE `role='admin'` profile
// (`accountType='institutional'`, `is_system=false`, `deactivated_at` NULL)
// that `admin-institutional.test.ts`'s last-human-admin floor then counted
// as a real operator. Their local `purgeUser*` helpers also called
// `listUsers()` with no pagination, so past the first 50 (or 200) auth users
// the lookup could miss the target entirely and skip cleanup altogether —
// the same truncation bug `findUserIdByEmail` below already guards against
// for `createFreshTestUser`.
import type { AdminUserAttributes, User, UserResponse } from "@supabase/supabase-js";
import { sql } from "drizzle-orm";

import { pgErrorCode } from "@/lib/infra/db-errors";
import { assertLocalSupabaseUrl } from "@/scripts/lib/seed-mfa";

export const TEST_USER_EMAIL_SUFFIX = "@dim-test.local";

/**
 * LOCAL-HOST GUARD (T3-R4, 2026-09-22, security review). Both functions
 * below delete and recreate auth users by email — safe ONLY because the
 * `@dim-test.local` suffix check in `assertTestEmail` means they can never
 * touch a seeded `@dim.test` or real account, but that check says nothing
 * about WHICH DATABASE is on the other end of `client`. A caller that built
 * `client` from a misconfigured environment — the same class of mistake
 * `.env.staging.local` sometimes loading only half its keys has already
 * produced in this repo — would run this against a remote project, where
 * `@dim-test.local` could be a real account that happens to share the
 * suffix. `assertLocalSupabaseUrl` is the same refusal `aal2-session.ts`
 * already applies for the identical reason (managing MFA factors), reading
 * `NEXT_PUBLIC_SUPABASE_URL` rather than anything derived from `client`
 * itself — supabase-js exposes no public accessor for the URL a client was
 * built with, so the env var is the only thing both this helper and the
 * client construction site agree on. `__tests__/setup-env.ts` forces this
 * variable to the local stack for EVERY vitest project (unit and db), so in
 * practice this refuses only a deliberately-misconfigured environment
 * variable, never an ordinary local run.
 */
function assertLocalTestDatabase(who: string): void {
  assertLocalSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", who);
}

/** The slice of the admin API this helper touches — any supabase-js client fits. */
export interface AdminAuthClient {
  auth: {
    admin: {
      createUser(attributes: AdminUserAttributes): Promise<UserResponse>;
      deleteUser(id: string): Promise<UserResponse>;
      listUsers(params?: { page?: number; perPage?: number }): Promise<
        | { data: { users: User[] }; error: null }
        | { data: { users: [] }; error: { message: string } }
      >;
    };
  };
}

const PER_PAGE = 1000;
const MAX_PAGES = 50;

function assertTestEmail(email: unknown): string {
  if (typeof email !== "string" || !email.toLowerCase().endsWith(TEST_USER_EMAIL_SUFFIX)) {
    throw new Error(
      `createFreshTestUser refuses ${JSON.stringify(email)}: only ${TEST_USER_EMAIL_SUFFIX} fixture users may be removed and recreated`,
    );
  }
  return email.toLowerCase();
}

function isEmailTaken(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  return error.code === "email_exists" || /already been registered/i.test(error.message ?? "");
}

async function findUserIdByEmail(client: AdminAuthClient, email: string): Promise<string | null> {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw new Error(`createFreshTestUser: listUsers page ${page}: ${error.message}`);
    const users = data.users;
    const found = users.find((u) => u.email?.toLowerCase() === email);
    if (found) return found.id;
    if (users.length < PER_PAGE) return null;
  }
  return null;
}

/**
 * `client.auth.admin.createUser(attributes)`, except that a leftover user with
 * the same `@dim-test.local` email is deleted and the create retried once.
 */
export async function createFreshTestUser(
  client: AdminAuthClient,
  attributes: AdminUserAttributes,
): Promise<UserResponse> {
  const email = assertTestEmail(attributes.email);
  assertLocalTestDatabase("createFreshTestUser");

  const first = await client.auth.admin.createUser(attributes);
  if (!isEmailTaken(first.error)) return first;

  const staleId = await findUserIdByEmail(client, email);
  if (staleId) {
    const removed = await client.auth.admin.deleteUser(staleId);
    if (removed.error) {
      // Typically a foreign key from a row the dead run left behind. Surface
      // it by name rather than retrying into the same "already registered".
      throw new Error(
        `createFreshTestUser: stale ${email} (${staleId}) could not be deleted: ${removed.error.message}`,
      );
    }
  }
  return client.auth.admin.createUser(attributes);
}

/** The slice of `db`/a transaction this helper needs — any Drizzle handle fits. */
export interface FixtureDbExecutor {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

/**
 * Deletes a `@dim-test.local` fixture user COMPLETELY: the auth user AND its
 * `public.profiles` row (or, if a foreign key blocks that delete, an
 * irreversible soft-deactivation instead — see below). Use this in place of
 * a local `purgeUser`/`purgeUserByEmail` that calls only
 * `auth.admin.deleteUser`.
 *
 * Looks the user up with FULL pagination via `findUserIdByEmail` (never a
 * bare `listUsers()`, which silently truncates at the first page). If no
 * matching auth user exists, this is a no-op — there is nothing left to
 * clean up by this route (see module header: without an auth user, a
 * leftover profile can no longer be found by email at all, since
 * `public.profiles` has no email column of its own).
 *
 * Deletes the `public.profiles` row first. Some rows can't be deleted
 * outright — an append-only table (e.g. `pet_events`, `audit_log`'s
 * immutable rows) still pointing at the profile blocks the DELETE with a
 * foreign-key violation (SQLSTATE 23503). In that case this falls back to
 * setting `deactivated_at = now()` AND `deleted_at = now()` on the row
 * instead of throwing — irreversible, and enough that the profile can never
 * again be counted as an active admin/govt/vet operator (every "active
 * operator" query in this codebase filters on `deactivated_at IS NULL`).
 * Only then is the auth user deleted.
 */
export async function deleteTestUser(
  client: AdminAuthClient,
  db: FixtureDbExecutor,
  email: string,
): Promise<void> {
  const normalized = assertTestEmail(email);
  assertLocalTestDatabase("deleteTestUser");
  const userId = await findUserIdByEmail(client, normalized);
  if (!userId) return;

  try {
    await db.execute(sql`delete from public.profiles where id = ${userId}::uuid`);
  } catch (err) {
    if (pgErrorCode(err) !== "23503") throw err;
    await db.execute(sql`
      update public.profiles
      set deactivated_at = now(), deleted_at = now()
      where id = ${userId}::uuid
    `);
  }

  const removed = await client.auth.admin.deleteUser(userId);
  if (removed.error) {
    throw new Error(
      `deleteTestUser: auth delete for ${normalized} (${userId}) failed: ${removed.error.message}`,
    );
  }
}

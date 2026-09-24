import "server-only";

import { createClient as createSdkClient } from "@supabase/supabase-js";

// Service-role admin client — bypasses Row Level Security.
//
// The service-role key must NEVER appear in logs, error messages, or bundles.
//
// Import rule (corrected 2026-08-04 — the previous comment said "ONLY import
// this module from app/actions/admin-institutional.ts", which stopped being
// true long ago: the transfers repository, the invite flow, the admin detail
// page and the adoption review page all import it legitimately). A stale
// restriction is worse than none, because a security reviewer reads it as an
// enforced invariant and stops looking.
//
// The real rule: this module may be imported ONLY from server-side code that
// has already authorized the caller, and every use must be justified by data
// that genuinely lives outside Postgres — in practice `auth.users`, whose
// email column has no Drizzle mirror on purpose (no PII duplication, and
// erasure has one place to happen). Reaching for it to skip an RLS policy is
// always wrong; add the policy instead.
//
// Module-level cache is safe here because the service-role client has no
// per-request session state (unlike the cookie-bound server.ts client).

let cached: ReturnType<typeof createSdkClient> | null = null;

export function createAdminClient(): ReturnType<typeof createSdkClient> {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Supabase admin client not configured: missing env vars.");
  }

  cached = createSdkClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return cached;
}

// Bound the enumeration so a misbehaving backend can never loop forever.
// 50 pages × 200/page = 10k auth users, far beyond v1 institutional volume.
const AUTH_USERS_PER_PAGE = 200;
const AUTH_USERS_MAX_PAGES = 50;

/**
 * Build a complete `userId → email` map by paging through ALL auth users (C21).
 *
 * The admin rosters previously called `listUsers({ perPage: 200 })` once, which
 * silently truncated at 200 users — beyond that the email column came back blank
 * for the unseen users. This pages until a short page is returned (or the page
 * cap is hit), so every operator's email is present regardless of total volume.
 *
 * `supabase` is typed loosely to avoid importing the SDK's generated client type
 * here; the caller passes the result of `createAdminClient()`.
 */
export async function buildAuthEmailMap(
  supabase: ReturnType<typeof createSdkClient>,
): Promise<Map<string, string>> {
  const emailMap = new Map<string, string>();
  for (let page = 1; page <= AUTH_USERS_MAX_PAGES; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: AUTH_USERS_PER_PAGE,
    });
    if (error) break;
    const users = data?.users ?? [];
    for (const u of users) {
      emailMap.set(u.id, u.email ?? "");
    }
    // A short (or empty) page means we've reached the end of the list.
    if (users.length < AUTH_USERS_PER_PAGE) break;
  }
  return emailMap;
}

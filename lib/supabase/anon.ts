// Supabase client for a caller with NO credential yet — the password grant.
//
// WHY THIS EXISTS ALONGSIDE bearer.ts
// ---------------------------------------------------------------------------
// `bearer.ts` turns an `Authorization: Bearer <jwt>` header into a client that
// can answer WHO the caller is. This file covers the moment BEFORE that: a
// native client posting an email and a password to `/api/v1/auth/login` or
// `/auth/signup` carries no credential at all, and the two web factories are
// both wrong for it —
//
//   · `@/lib/supabase/server` (SSR) reads and WRITES cookies. Used from a route
//     handler serving a native client it would mint a session cookie nobody
//     will ever send back, and on Vercel it would attach a `Set-Cookie` to a
//     JSON response the app parses and discards. A phone has no cookie jar; the
//     tokens go in the body.
//   · `@/lib/supabase/client` (browser) persists to `localStorage`, which does
//     not exist here, and would be shared process-wide if it did.
//
// So: a per-request SDK client with no storage and no refresh timer, whose only
// job is to carry ONE credential exchange and then be discarded.
//
// THE SAME KEY CHOICE bearer.ts MAKES, FOR THE SAME REASON
// ---------------------------------------------------------------------------
// The ANON key, never the service-role key. The service key bypasses RLS, and
// `signInWithPassword` on a service-role client is a password check wearing an
// RLS-bypassing client that the handler then holds. `lib/supabase/admin.ts` is
// the only place the service key belongs and is deliberately not imported here.
//
// AND WHAT IT DOES NOT DO. It does not decide anything. The credential check is
// GoTrue's; whether the resulting account may act is `requireLiveUser`'s, from
// the database. Authorization is 100% DB-resolved (zero `auth.jwt()` across 276
// RLS policies) and nothing here reads a claim.

import { type SupabaseClient, createClient as createSdkClient } from "@supabase/supabase-js";

/**
 * A per-request, credential-free Supabase client.
 *
 * Build one, perform one exchange, let it go. It is NOT a module singleton: a
 * warm serverless container reuses the module scope across requests, and a
 * client that has just signed someone in holds that session in memory. Sharing
 * it is how one caller's session answers another caller's question.
 */
export function createAnonClient(): SupabaseClient {
  return createSdkClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    {
      auth: {
        // No storage to persist to, no browser to refresh for. Leaving either
        // on is how one request's session leaks into the next.
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
}

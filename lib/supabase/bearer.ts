// Supabase client for NON-COOKIE callers — a request that carries its
// credential in an `Authorization: Bearer <jwt>` header instead of the SSR
// auth cookies.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// PO decision 2026-08-19: the native app talks to OUR OWN `/api/v1` with a
// bearer token — it does NOT talk to Supabase directly. So this factory is not
// "the native data client"; it is the narrow adapter that turns a bearer header
// into something `requireLiveUser()` can resolve, so a bearer request and a
// cookie request are gated by the SAME guard rather than by two guards that
// drift apart. No route consumes it yet; Track 2 is its first caller.
//
// THE INVARIANT IT MUST NOT BREAK
// ---------------------------------------------------------------------------
// Authorization is 100% DB-resolved (zero `auth.jwt()` across 276 RLS policies).
// This file therefore does exactly one thing with the token: hand it to Supabase
// so `auth.getUser()` can validate it and answer WHO the caller is. It never
// decodes it, never reads a claim, and never lets a claim decide what the caller
// may do — that answer comes from the database, in requireLiveUser and in RLS.
//
// KEY CHOICE
// ---------------------------------------------------------------------------
// The ANON key, never the service-role key. The service-role key bypasses RLS;
// pairing it with a caller-supplied Authorization header would hand a bearer
// client RLS-bypassing reach in one line. lib/supabase/admin.ts is the only
// place the service key belongs, and it is deliberately not imported here.

import { type SupabaseClient, createClient as createSdkClient } from "@supabase/supabase-js";

export type BearerParseFailureReason =
  // No Authorization header at all (or blank). Callers answer 401.
  | "MISSING"
  // Present but not a usable `Bearer <token>`: wrong scheme, empty token, or a
  // token containing whitespace. Kept distinct from MISSING so a client bug
  // ("we sent the raw JWT with no scheme") is distinguishable from an
  // unauthenticated request in logs and in the response body.
  | "MALFORMED";

export type BearerTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: BearerParseFailureReason };

export type BearerClientResult =
  | { ok: true; supabase: SupabaseClient; token: string }
  | { ok: false; reason: BearerParseFailureReason };

// RFC 7235 §2.1: `credentials = auth-scheme [ 1*SP token68 ]`, and the scheme is
// case-insensitive. token68 excludes whitespace, so a "token" with a space in it
// is malformed rather than a token that happens to contain one.
const BEARER_RE = /^bearer\s+(\S+)\s*$/i;

/**
 * Parse an `Authorization` header value into its bearer token.
 *
 * Exported separately from the factory so a route handler can distinguish
 * MISSING from MALFORMED without constructing a client it is about to discard.
 */
export function parseBearerToken(
  authorizationHeader: string | null | undefined,
): BearerTokenResult {
  const raw = authorizationHeader?.trim() ?? "";
  if (raw === "") return { ok: false, reason: "MISSING" };

  const match = raw.match(BEARER_RE);
  if (!match) return { ok: false, reason: "MALFORMED" };

  return { ok: true, token: match[1] };
}

/**
 * Build a per-request Supabase client authenticated by the caller's bearer
 * token, or say why the header could not be used.
 *
 * Usage (Track 2):
 *
 *   const client = createClientFromBearer(request.headers.get("authorization"));
 *   if (!client.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
 *   const gate = await requireLiveUser({ supabase: client.supabase });
 *   if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 401 });
 */
export function createClientFromBearer(
  authorizationHeader: string | null | undefined,
): BearerClientResult {
  const parsed = parseBearerToken(authorizationHeader);
  if (!parsed.ok) return parsed;

  const supabase = createSdkClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    {
      global: { headers: { Authorization: `Bearer ${parsed.token}` } },
      auth: {
        // A per-request server client has no storage to persist to and no
        // browser to refresh for. Leaving either on is how one request's session
        // leaks into the next in a warm serverless container.
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );

  return { ok: true, supabase, token: parsed.token };
}

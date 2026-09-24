// Read the claims of an access token GoTrue has ALREADY validated.
//
// Three consumers ask the credential about itself, never about authority:
//
//   · operator-shift.ts — WHEN this session was authenticated (`amr[].timestamp`).
//   · the recovery form (password-reset/update-password.ts) — HOW it was
//     authenticated: only a session minted by the recovery flow (`amr` method
//     `recovery` for the PKCE link, `otp` for the token-hash or six-digit code;
//     measured on local GoTrue v2.188.1) may set a password without the current
//     one.
//   · MFA enforcement (live-user.ts) — the assurance level the session reached
//     (`aal`: `aal1` after a password, `aal2` after a verified TOTP challenge).
//
// None of these is an AUTHORIZATION read in the sense live-user.ts forbids: what a
// caller may do is still answered by the database. These describe the credential
// itself, and the credential is the only thing that knows.
//
// PRECONDITION, and it is the whole safety argument: every token handed to this
// module MUST be one `supabase.auth.getUser()` has just round-tripped to GoTrue.
// Nothing here verifies a signature. Decoding an unvalidated cookie would be
// trusting the client.

type ClaimsSource = {
  auth: { getSession(): Promise<{ data: { session: { access_token?: string } | null } }> };
};

/**
 * Decode a JWT's payload segment WITHOUT verifying it.
 *
 * Private on purpose: nothing outside this module may reach a decode-without-
 * verify. `atob` rather than `Buffer` so the module stays usable from the Edge
 * runtime. Returns null on anything unexpected.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  const payload = segments[1];
  if (!payload) return null;
  try {
    // base64url → base64, then pad to a multiple of 4.
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const json = atob(padded);
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The payload of a token `getUser()` has just validated, or null.
 *
 * See the module header for the precondition.
 */
export function verifiedTokenClaims(
  accessToken: string | null | undefined,
): Record<string, unknown> | null {
  if (!accessToken) return null;
  return decodeJwtPayload(accessToken);
}

/**
 * The claims of the session behind a request, AFTER `getUser()` accepted it.
 *
 * Two sources, picked by path: the bearer path already holds the raw token; the
 * cookie path reads it back from the SSR client with `getSession()`, which does
 * not re-validate — and does not need to, because `getUser()` has just accepted
 * the same cookie. Only `access_token` is read; `session.user` is ignored.
 *
 * Swallows its own failure (an SDK shape change, a mocked client without
 * `getSession`) and answers null. What null MEANS is each caller's decision, and
 * each one states it at its call site.
 */
export async function verifiedSessionClaims(
  supabase: ClaimsSource,
  accessToken?: string,
): Promise<Record<string, unknown> | null> {
  if (accessToken) return verifiedTokenClaims(accessToken);
  try {
    const { data } = await supabase.auth.getSession();
    return verifiedTokenClaims(data.session?.access_token);
  } catch {
    return null;
  }
}

/** One `amr` entry in GoTrue's `{ method, timestamp }` shape. */
export type AuthMethodReference = { method: string; timestamp: number | null };

/**
 * The authentication methods this session recorded, in GoTrue's shape.
 *
 * RFC-8176's plain `string[]` form is accepted too (no timestamps), so a claim
 * shape change degrades to "methods known, instants unknown" instead of to
 * nothing.
 */
export function authMethodReferences(
  claims: Record<string, unknown> | null,
): AuthMethodReference[] {
  if (!claims || !Array.isArray(claims.amr)) return [];
  const out: AuthMethodReference[] = [];
  for (const entry of claims.amr) {
    if (typeof entry === "string") {
      out.push({ method: entry, timestamp: null });
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    if (typeof method !== "string") continue;
    const ts =
      typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
        ? timestamp
        : null;
    out.push({ method, timestamp: ts });
  }
  return out;
}

/**
 * The Authenticator Assurance Level the session reached, or null when the token
 * does not say. GoTrue emits `aal1` or `aal2`; anything else is null.
 */
export function assuranceLevel(claims: Record<string, unknown> | null): "aal1" | "aal2" | null {
  const aal = claims?.aal;
  return aal === "aal1" || aal === "aal2" ? aal : null;
}

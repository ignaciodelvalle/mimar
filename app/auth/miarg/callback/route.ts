// Mi Argentina OIDC callback route — Wave 5 Item 25a scaffold.
//
// This route is the SHAPE of the Mi Argentina OAuth2/OIDC callback.
// It is safe to ship as a stub: when the OIDC env vars are absent the gate
// returns a 404 response and the route is invisible. No real OIDC connection
// is implemented here — that is Item 25b, gated on owner credentials.
//
// WHAT THIS STUB DOES:
//   - Returns 404 when MIARG_OIDC_ISSUER / CLIENT_ID are not set (gate=false).
//   - Returns 501 with a clear TODO message when the gate is enabled but the
//     real implementation is not yet wired.
//
// WHAT 25b NEEDS TO ADD (in this file only):
//   1. Validate `state` parameter (CSRF protection).
//   2. Exchange `code` for tokens via getMiArgOidcConfig().tokenEndpoint.
//   3. Verify id_token JWK signature against issuer's JWKS.
//   4. Call upsertProfileFromMiArgClaims(userId, claims).
//   5. Set the DIM session (Supabase Auth session via exchange or manual setSession).
//   6. Redirect to the role-based landing page.
//
// The callback route URL must match MIARG_OIDC_REDIRECT_URI env var and the
// registration in the Mi Argentina developer portal.

import { type NextRequest, NextResponse } from "next/server";

import { isMiArgOidcEnabled } from "@/lib/infra/miarg-oidc";

// @no-auth-required: feature-flagged stub for the Mi Argentina OIDC callback,
// which — like app/auth/callback — will BE the authentication boundary, running
// before any session exists. Today it holds no logic to protect: it 404s when
// the OIDC env vars are absent (the shipped state) and 501s when they are set.
// When 25b lands, the `state` + `id_token` verification listed in the header is
// this route's authorization check, and this marker's reason must be rewritten
// to name it rather than describe a stub.
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Gate: return 404 when OIDC is not configured so the route is invisible
  // to scanners and the email/password flow is completely unaffected.
  if (!isMiArgOidcEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // TODO(25b): implement the full OIDC callback flow. Steps documented in
  // the file header above. The `code` and `state` params are available via:
  const _code = request.nextUrl.searchParams.get("code");
  const _state = request.nextUrl.searchParams.get("state");

  // Until 25b lands, return a clearly-labeled 501 so a misconfigured env
  // produces a developer-readable error rather than a silent 404.
  return NextResponse.json(
    {
      error: "not_implemented",
      message:
        "Mi Argentina OIDC callback is scaffolded but not yet implemented (Item 25b). " +
        "Set MIARG_OIDC_* env vars only after the real implementation lands.",
    },
    { status: 501 },
  );
}

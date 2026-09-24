// Mi Argentina OIDC scaffold — Wave 5 Item 25a.
//
// This module defines the OIDC integration SHAPE for Mi Argentina so that
// Item 25b (the real connection) can drop in real credentials and wire the
// callback without touching any other file.
//
// WHAT IS STUBBED (25a — safe to ship):
//   - Environment variable names and validation.
//   - Claim shape / TypeScript types expected from Mi Argentina.
//   - The `isMiArgOidcEnabled()` gate (controls the entire OIDC path).
//   - Profile-upsert signature from OIDC claims.
//
// WHAT IS NOT IMPLEMENTED (TODO 25b — gated on owner credentials):
//   - Real HTTP redirect to Mi Argentina authorization endpoint.
//   - PKCE code-verifier / state generation and validation.
//   - Token exchange (authorization_code → access_token + id_token).
//   - JWK verification of the id_token.
//   - Real `handleMiArgCallback()` end-to-end path.
//
// GATE: when MIARG_OIDC_ISSUER / MIARG_OIDC_CLIENT_ID are absent the gate
// returns false and the email/password flow is completely unchanged. The OIDC
// path is invisible to users until the env vars are set.

// ============================================================================
// Environment gate
// ============================================================================

/**
 * Returns true when all required Mi Argentina OIDC env vars are present.
 * When false the entire OIDC path is skipped and email/password auth is used.
 */
export function isMiArgOidcEnabled(): boolean {
  return !!(
    process.env.MIARG_OIDC_ISSUER &&
    process.env.MIARG_OIDC_CLIENT_ID &&
    process.env.MIARG_OIDC_CLIENT_SECRET &&
    process.env.MIARG_OIDC_REDIRECT_URI
  );
}

// ============================================================================
// OIDC configuration (read from env)
// ============================================================================

export interface MiArgOidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Authorization endpoint — derived from issuer unless overridden. */
  authorizationEndpoint: string;
  /** Token endpoint — derived from issuer unless overridden. */
  tokenEndpoint: string;
}

/**
 * Reads Mi Argentina OIDC configuration from environment variables.
 * Throws if the gate is not enabled — call isMiArgOidcEnabled() first.
 *
 * Env vars:
 *   MIARG_OIDC_ISSUER             — OIDC issuer base URL (e.g. https://auth.miargentina.gob.ar)
 *   MIARG_OIDC_CLIENT_ID          — OAuth2 client ID issued by Mi Argentina
 *   MIARG_OIDC_CLIENT_SECRET      — OAuth2 client secret (keep in Vercel env secrets)
 *   MIARG_OIDC_REDIRECT_URI       — Callback URL registered with Mi Argentina
 *   MIARG_OIDC_AUTH_ENDPOINT      — Override authorization endpoint (optional)
 *   MIARG_OIDC_TOKEN_ENDPOINT     — Override token endpoint (optional)
 */
export function getMiArgOidcConfig(): MiArgOidcConfig {
  const issuer = process.env.MIARG_OIDC_ISSUER;
  const clientId = process.env.MIARG_OIDC_CLIENT_ID;
  const clientSecret = process.env.MIARG_OIDC_CLIENT_SECRET;
  const redirectUri = process.env.MIARG_OIDC_REDIRECT_URI;

  if (!issuer || !clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Mi Argentina OIDC is not configured. Set MIARG_OIDC_ISSUER, " +
        "MIARG_OIDC_CLIENT_ID, MIARG_OIDC_CLIENT_SECRET, MIARG_OIDC_REDIRECT_URI.",
    );
  }

  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    authorizationEndpoint: process.env.MIARG_OIDC_AUTH_ENDPOINT ?? `${issuer}/oauth2/authorize`,
    tokenEndpoint: process.env.MIARG_OIDC_TOKEN_ENDPOINT ?? `${issuer}/oauth2/token`,
  };
}

// ============================================================================
// Claim shape (what Mi Argentina returns in the id_token)
// ============================================================================

/**
 * Claims expected from Mi Argentina's id_token / userinfo endpoint.
 * Field names are illustrative — will be confirmed against the real spec in 25b.
 *
 * TODO(25b): validate against the actual Mi Argentina OIDC discovery document
 * and update field names to match the real claim set.
 */
export interface MiArgClaims {
  /** Stable opaque subject identifier — the FK to Mi Argentina identity. */
  sub: string;
  /** User's legal full name (may differ from display_name they chose in DIM). */
  name?: string;
  /** Whether DNI has been verified by Mi Argentina. */
  dni_verified?: boolean;
  /**
   * HMAC-SHA256 hash of the DNI using our pepper, OR the raw DNI (if Mi Argentina
   * delivers it). In 25b: if Mi Argentina delivers the raw DNI, we hash it here
   * before persisting. We never store the raw value.
   */
  dni?: string;
  /** Email address from Mi Argentina (may differ from Supabase Auth email). */
  email?: string;
}

// ============================================================================
// Profile upsert from OIDC claims (signature only — TODO 25b implement body)
// ============================================================================

/**
 * Upserts a DIM profile from verified Mi Argentina OIDC claims.
 *
 * Called from the OIDC callback route after token exchange + JWK verification.
 * Sets `miarg_sub`, `identity_source='miarg'`, `dni_hash`, `dni_last4`,
 * `dni_verified=true`, `dni_verified_at=now()`.
 *
 * TODO(25b): implement the body once real claims are confirmed.
 * The signature is final — the callback route (app/auth/miarg/callback/route.ts)
 * calls this and does not need to change when 25b lands.
 */
export async function upsertProfileFromMiArgClaims(
  _userId: string,
  _claims: MiArgClaims,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // TODO(25b): implement. Steps:
  //   1. Validate `claims.sub` is present.
  //   2. If claims.dni is present, compute hashDni(claims.dni) and dniLast4(claims.dni).
  //   3. db.update(profiles).set({ miargSub, identitySource: 'miarg', dniHash, dniLast4,
  //        dniVerified: claims.dni_verified ?? false, dniVerifiedAt: new Date() })
  //      .where(eq(profiles.id, userId))
  //   4. Handle 23505 on miarg_sub (already linked to another account).
  throw new Error(
    "upsertProfileFromMiArgClaims is not implemented — pending Mi Argentina credentials (Item 25b).",
  );
}

// DNI hashing helper — Wave 5 Item 25a.
//
// No DNI in plaintext rule (Ley 25.326 / Mi Argentina premise): the application
// never stores a DNI number in cleartext after migration 0106. Instead it stores:
//   - `dni_hash`  — HMAC-SHA256(dni, DNI_HASH_PEPPER) hex — equality-matching only.
//   - `dni_last4` — right(dni, 4) — human disambiguation in operator UI only.
//
// Pepper: DNI_HASH_PEPPER env var (server-side only, never shipped to the client).
// For local development and tests use DNI_HASH_PEPPER="dim-test-pepper-v1".
// The production value MUST be a secret set in the deployment environment /
// KMS — if it is leaked the hash table can be reversed via rainbow table for
// the finite Argentine DNI space (7–8 digits).
//
// TODO(25b): once the Mi Argentina OIDC callback lands, `verifyDniForUser` and
// `completeIdentityAction` will be replaced by the OAuth claim path. The helper
// here stays — the same HMAC logic is used in both the legacy and OIDC paths.

import { createHmac } from "node:crypto";

// Fallback pepper for local development / tests. MUST NOT be used in prod.
const DEV_TEST_PEPPER = "dim-test-pepper-v1";

function getPepper(): string {
  const pepper = process.env.DNI_HASH_PEPPER;
  // Fail closed in production (deploy-readiness audit 2026-07-04 B1; residual
  // closed 2026-07-04): the dev pepper is PUBLIC (committed above), and the
  // Argentine DNI space is small enough (7-8 digits) that a known pepper makes
  // every stored hash reversible by rainbow table. Silently falling back would
  // poison every hash written until someone noticed — better to refuse to boot
  // the identity path.
  //
  // Fail closed on a REAL production DEPLOYMENT (Vercel or self-hosted), not
  // merely NODE_ENV=production: `next start` for local QA runs in production
  // mode against the LOCAL Supabase and must be allowed to use the dev pepper.
  // A real deploy talks to a REMOTE database, so key the gate on that — this
  // keeps "any prod host" fail-closed (previous `&& VERCEL` missed self-hosted)
  // while not breaking local production-mode QA. Also rejects the dev default
  // being set EXPLICITLY on a real deploy (same reversible-pepper hazard).
  //
  // TWO INDEPENDENT TRIGGERS (audit 2026-08-12). Keying only on
  // NODE_ENV=production left a residual: a real deployment that fails to set
  // NODE_ENV — or whose DATABASE_URL literally contains the substring
  // "localhost" — fell through to the committed dev pepper in silence, and
  // every DNI hashed under it becomes rainbow-table reversible over a ~10^8
  // space. Running on a deploy PLATFORM is decisive on its own: there is no
  // legitimate local-QA case on Vercel, so the isLocalDb escape hatch does not
  // apply to it. NODE_ENV keeps covering self-hosted deploys, where the
  // remote-database test is what distinguishes a real deploy from `next start`
  // against local Supabase.
  const dbUrl = process.env.DATABASE_URL ?? "";
  const isLocalDb = dbUrl.includes("127.0.0.1") || dbUrl.includes("localhost");
  const isDeployPlatform = Boolean(process.env.VERCEL);
  const isRealProdDeploy =
    isDeployPlatform || (process.env.NODE_ENV === "production" && !isLocalDb);
  if (isRealProdDeploy && (!pepper || pepper === DEV_TEST_PEPPER)) {
    throw new Error(
      "DNI_HASH_PEPPER must be set to a non-default secret in production. " +
        "Refusing to hash DNIs with the public dev pepper.",
    );
  }
  return pepper ?? DEV_TEST_PEPPER;
}

/**
 * Computes HMAC-SHA256(dni, pepper) and returns the hex digest.
 *
 * Deterministic: same dni + pepper always produces the same hash.
 * Used for equality checks in DB queries (WHERE dni_hash = hashDni(input)).
 *
 * @param dni - The raw DNI string (digits only, 7–8 chars).
 */
export function hashDni(dni: string): string {
  const pepper = getPepper();
  return createHmac("sha256", pepper).update(dni).digest("hex");
}

/**
 * Returns the last 4 digits of a DNI for display in operator UI.
 * Never use this value as an identifier — it is for human disambiguation only.
 */
export function dniLast4(dni: string): string {
  return dni.slice(-4);
}

// Physical-tag activation-code hashing helper (physical-tag-lifecycle D2).
//
// The wrapper-printed activation code is the proof-of-possession secret for
// tag activation. It is stored ONLY as HMAC-SHA256 over a domain-separated
// message, keyed with the same server-side pepper as DNI hashing:
//
//   pet_tags.activation_code_hash = HMAC-SHA256("tag-activation-code:v1:" + code, DNI_HASH_PEPPER)
//
// WHY HMAC AND NOT bcrypt/argon2: the evidence gate compares the hash INSIDE a
// SQL predicate (lib/infra/tag-lookup.ts — the hash column is never SELECTed
// into JS), which requires a deterministic digest. Slow hashing is
// unnecessary here because — unlike a DNI — WE generate the code with 31^8
// (~2^39.6) entropy from a CSPRNG; the pepper defends the DB-only-leak case.
//
// WHY THE SAME PEPPER: a dedicated TAG_CODE_PEPPER env var would be one more
// deployment knob to silently misconfigure (the SITE_URL QR incident). Domain
// separation via the "tag-activation-code:v1:" message prefix keeps the two
// uses cryptographically independent under one key.
//
// Fail-closed prod gate mirrored from lib/utils/dni-hash.ts: a REAL production
// deployment (remote DB) refuses to run with the public dev pepper.

import { createHmac } from "node:crypto";

// Fallback pepper for local development / tests. MUST NOT be used in prod.
const DEV_TEST_PEPPER = "dim-test-pepper-v1";

// Domain-separation prefix. Bump v1 -> v2 if the message shape ever changes.
const DOMAIN_PREFIX = "tag-activation-code:v1:";

function getPepper(): string {
  const pepper = process.env.DNI_HASH_PEPPER;
  // Fail closed on a REAL production deployment (remote DB), not merely
  // NODE_ENV=production: `next start` local QA runs production mode against
  // the LOCAL Supabase and must be allowed the dev pepper. Same gate as
  // dni-hash.ts — see that file for the full rationale.
  const dbUrl = process.env.DATABASE_URL ?? "";
  const isLocalDb = dbUrl.includes("127.0.0.1") || dbUrl.includes("localhost");
  const isRealProdDeploy = process.env.NODE_ENV === "production" && !isLocalDb;
  if (isRealProdDeploy && (!pepper || pepper === DEV_TEST_PEPPER)) {
    throw new Error(
      "DNI_HASH_PEPPER must be set to a non-default secret in production. " +
        "Refusing to hash tag activation codes with the public dev pepper.",
    );
  }
  return pepper ?? DEV_TEST_PEPPER;
}

/**
 * Computes HMAC-SHA256("tag-activation-code:v1:" + code, pepper) hex digest.
 *
 * Deterministic: same code + pepper always produces the same hash — required
 * so the activation evidence gate can compare inside a SQL WHERE predicate
 * without ever SELECTing the stored hash into JS.
 *
 * The code is normalized (trim + uppercase) so user input like " wxyz-6789 "
 * matches the issued "WXYZ-6789".
 */
export function hashTagActivationCode(code: string): string {
  const pepper = getPepper();
  const normalized = code.trim().toUpperCase();
  return createHmac("sha256", pepper).update(`${DOMAIN_PREFIX}${normalized}`).digest("hex");
}

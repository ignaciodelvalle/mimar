// Intake chip-match claim token — Lost & Found cross-tenant isolation
// (review 24, HIGH #6/#7).
//
// When an org-side intake microchip cross-check finds an existing pet with
// status='lost', createIntake redirects the operator to the match-confirmation
// page. That page (and the confirm-match writer) expose the lost pet's owner
// PII (first name + last-seen location) and can create shelter_custody. Loading
// the pet by publicToken ALONE let any org member of any org open that page for
// ANY lost pet token — a cross-tenant PII leak.
//
// This module issues an HMAC-signed claim that binds (orgToken, matchedPetToken)
// to the specific intake redirect. The match page and the confirm-match writer
// require a valid, unexpired claim before revealing PII or mutating. An operator
// can only obtain a claim by running their OWN org's intake against that exact
// chip — a claim for org A's token cannot authorize org B, and a claim for pet X
// cannot authorize pet Y.
//
// Mirrors lib/infra/microchip-force-token.ts (same signing-key fallback, same
// format, same replay semantics): the claim is not persisted; the writer still
// re-checks live DB state (pet still 'lost', no existing custody) inside its tx.

import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes — operator photo-verifies the animal.

function getSigningKey(): string {
  if (process.env.INTAKE_MATCH_CLAIM_SECRET) return process.env.INTAKE_MATCH_CLAIM_SECRET;
  // Fallback: derive from SUPABASE_SERVICE_ROLE_KEY (always present in app env).
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Last resort for tests where neither var is set — fail closed in production.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "INTAKE_MATCH_CLAIM_SECRET (or SUPABASE_SERVICE_ROLE_KEY) must be set in production.",
    );
  }
  return "dim-dev-fallback-key-not-for-production";
}

/**
 * Generate a signed intake-match claim binding the org (by public token) to the
 * matched lost pet (by public token). Issued only inside createIntake after a
 * successful chip cross-check against a lost pet.
 */
export function generateIntakeMatchClaim(orgToken: string, matchedPetToken: string): string {
  const ts = Date.now().toString();
  const key = getSigningKey();
  const mac = createHmac("sha256", key)
    .update(`${orgToken}:${matchedPetToken}:${ts}`)
    .digest("hex");
  return `${Buffer.from(mac, "hex").toString("base64url")}.${ts}`;
}

/**
 * Validate an intake-match claim for the given (orgToken, matchedPetToken) pair.
 * Returns true only when the HMAC matches BOTH bound identifiers and the claim
 * has not expired. A claim minted for a different org or a different pet fails.
 */
export function validateIntakeMatchClaim(
  orgToken: string,
  matchedPetToken: string,
  token: string,
): boolean {
  try {
    if (!token) return false;
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx === -1) return false;
    const macPart = token.slice(0, dotIdx);
    const tsPart = token.slice(dotIdx + 1);
    const ts = Number.parseInt(tsPart, 10);
    if (Number.isNaN(ts)) return false;
    if (Date.now() - ts > TOKEN_TTL_MS) return false;

    const key = getSigningKey();
    const expectedMac = createHmac("sha256", key)
      .update(`${orgToken}:${matchedPetToken}:${tsPart}`)
      .digest("hex");
    const expectedBuf = Buffer.from(expectedMac, "hex");
    const actualBuf = Buffer.from(macPart, "base64url");
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

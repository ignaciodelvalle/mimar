// Unsubscribe capability for the daily operator digest — "works without
// login, is unguessable, and cannot flip anyone else's account".
//
// SHAPE mirrors lib/infra/denuncia-reporter-token.ts / apply-intent.ts /
// microchip-force-token.ts / tattoo-ack-token.ts (one token shape to audit in
// this repo, not five): base64url(hex(hmac)), signed over a purpose string
// that binds the MAC to exactly one user and one action, so a token minted
// for THIS purpose can never be replayed as a session cookie or any other
// capability those siblings mint.
//
// NO TIMESTAMP / NO TTL, and that is a deliberate difference from the
// siblings above. An unsubscribe link has to keep working for as long as the
// digest keeps arriving — it rides in an email a person may open a week
// later — so there is no expiry to encode and nothing to check an age
// against. What makes it SAFE without a TTL is what the capability actually
// DOES: it can only ever flip `daily_digest_opt_out` to true for the ONE
// userId baked into the MAC. Replaying an old link is a no-op (idempotent —
// it just re-confirms "stop mailing me"), and it can never be used to opt
// someone ELSE out, read anything, or perform any other write. The only way
// to revoke every outstanding link at once is to rotate the signing key,
// which is the same global-revoke story the siblings tell.
//
// Base key: DIGEST_UNSUBSCRIBE_SECRET → SUPABASE_SERVICE_ROLE_KEY → dev
// fallback, failing closed in production — same resolution order as every
// sibling token in this file's header comment.
//
// DOMAIN-SEPARATED SUBKEY (security review, 2026-09-18). The base key is, in
// every environment that has not set DIGEST_UNSUBSCRIBE_SECRET, the service-
// role key itself — the one credential that bypasses RLS. MACing user-chosen
// input directly under it means every link this module hands out is an HMAC
// oracle over that key. So the MAC is never computed with the base key: it is
// computed with HMAC(baseKey, SUBKEY_LABEL), a key that exists for this one
// purpose. Bumping the label's version revokes every outstanding link without
// touching the base key.
//
// SHAPE GATE. `u` arrives from a query string. It is refused unless it is a
// UUID BEFORE any MAC is computed, so an attacker cannot feed arbitrary
// strings through the HMAC at all — only the shape a profile id can have.

import { createHmac, timingSafeEqual } from "node:crypto";

import { isUuid } from "@/lib/utils/uuid";

const PURPOSE = "daily_digest_unsubscribe";
const SUBKEY_LABEL = "dim/digest-unsubscribe/v1";

function getBaseKey(): string {
  if (process.env.DIGEST_UNSUBSCRIBE_SECRET) return process.env.DIGEST_UNSUBSCRIBE_SECRET;
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "DIGEST_UNSUBSCRIBE_SECRET (or SUPABASE_SERVICE_ROLE_KEY) must be set in production.",
    );
  }
  return "dim-dev-fallback-key-not-for-production";
}

/** The purpose-bound subkey — never the base key itself (see header). */
function getSigningKey(): Buffer {
  return createHmac("sha256", getBaseKey()).update(SUBKEY_LABEL).digest();
}

function payload(userId: string): string {
  return `${PURPOSE}:${userId}`;
}

function macHex(userId: string): string {
  return createHmac("sha256", getSigningKey()).update(payload(userId)).digest("hex");
}

/** Mint an unsubscribe capability for `userId`. Deterministic (no timestamp) —
 * the same link can be reissued into every digest without re-minting. Throws
 * on a non-UUID id: minting a link nobody can redeem is a caller bug. */
export function generateDigestUnsubscribeToken(userId: string): string {
  if (!isUuid(userId)) {
    throw new Error("generateDigestUnsubscribeToken: userId must be a UUID");
  }
  return Buffer.from(macHex(userId), "hex").toString("base64url");
}

/**
 * True when `token` is a live unsubscribe capability for exactly `userId`.
 * Fails closed on every malformed input (a non-UUID `userId` is refused before
 * any MAC is computed); comparison is timing-safe.
 */
export function validateDigestUnsubscribeToken(userId: string, token: string): boolean {
  try {
    if (!userId || !token) return false;
    if (!isUuid(userId)) return false;
    const expectedMac = macHex(userId);
    const expectedBuf = Buffer.from(expectedMac, "hex");
    const actualBuf = Buffer.from(token, "base64url");
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

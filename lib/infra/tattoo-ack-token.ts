// Advisory acknowledgement token for tattoo possible-match override.
//
// When a tattoo cross-check finds an existing pet, the intake is paused
// with a TATTOO_MATCH_POSSIBLE advisory. The UI shows the conflict and
// offers the operator a "continue anyway" path backed by this HMAC-signed
// token. Unlike the chip force-token (which is a hard block on active pets),
// this is purely advisory — the operator asserts they photo-verified the
// animals are different.
//
// Token format:  base64url(hex(hmac)) + "." + timestamp(ms)
// Expiry:        15 minutes from issuance
//
// Token is bound to the normalized tattoo code so a token issued for
// code "K9-2014" cannot ack code "A1-XXXX".
//
// Reuses the same signing-key resolution as microchip-force-token.ts
// (TATTOO_ACK_SECRET → SUPABASE_SERVICE_ROLE_KEY → dev fallback).

import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

function getSigningKey(): string {
  if (process.env.TATTOO_ACK_SECRET) return process.env.TATTOO_ACK_SECRET;
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (process.env.NODE_ENV === "production") {
    throw new Error("TATTOO_ACK_SECRET (or SUPABASE_SERVICE_ROLE_KEY) must be set in production.");
  }
  return "dim-dev-fallback-key-not-for-production";
}

/** Generate a signed acknowledgement token for the given tattoo code. */
export function generateTattooAckToken(tattooCode: string): string {
  return generateTattooAckTokenAtTime(tattooCode, Date.now());
}

/**
 * Test-only: generate a token whose timestamp is set to `atMs`.
 * Produces a valid MAC over the old timestamp so TTL tests exercise the
 * expiry path rather than the MAC-mismatch path.
 * @internal
 */
export function generateTattooAckTokenAtTime(tattooCode: string, atMs: number): string {
  const ts = atMs.toString();
  const key = getSigningKey();
  const mac = createHmac("sha256", key).update(`tattoo:${tattooCode}:${ts}`).digest("hex");
  return `${Buffer.from(mac, "hex").toString("base64url")}.${ts}`;
}

/** Validate a tattoo ack token. Returns true if valid and not expired. */
export function validateTattooAckToken(tattooCode: string, token: string): boolean {
  try {
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx === -1) return false;
    const macPart = token.slice(0, dotIdx);
    const tsPart = token.slice(dotIdx + 1);
    const ts = Number.parseInt(tsPart, 10);
    if (Number.isNaN(ts)) return false;
    if (Date.now() - ts > TOKEN_TTL_MS) return false;

    const key = getSigningKey();
    const expectedMac = createHmac("sha256", key)
      .update(`tattoo:${tattooCode}:${tsPart}`)
      .digest("hex");
    const expectedBuf = Buffer.from(expectedMac, "hex");
    const actualBuf = Buffer.from(macPart, "base64url");
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

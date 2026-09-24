// Force-create token for microchip active-match override — Lost & Found Fase 2.
//
// When a chip cross-check finds an existing pet with status='active', the
// intake is blocked with a warning. The UI shows the conflict and offers the
// actor a "continue anyway" path backed by this HMAC-signed token.
//
// Token format:  base64url(hex(hmac)) + "." + timestamp(ms)
// Expiry:        15 minutes from issuance
//
// MICROCHIP_FORCE_SECRET — optional env var. If absent, the signing key is
// derived from SUPABASE_SERVICE_ROLE_KEY (available in all environments where
// the app runs). This means:
//   - Production: set MICROCHIP_FORCE_SECRET for isolation.
//   - Local / CI: falls back gracefully; no extra config needed.
//
// Security notes:
//   - HMAC-SHA256 over `${microchipId}:${timestamp}` binds the token to the
//     specific chip — a token for chip A cannot override chip B.
//   - The timestamp in the token body makes the expiry verifiable without a
//     DB round-trip.
//   - We do NOT persist tokens; they are single-use by convention (the actor
//     who generates one proceeds immediately). Replay within the 15-min window
//     is acceptable: the action already checked the live DB state.

import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

function getSigningKey(): string {
  if (process.env.MICROCHIP_FORCE_SECRET) return process.env.MICROCHIP_FORCE_SECRET;
  // Fallback: derive from SUPABASE_SERVICE_ROLE_KEY (always present in app env).
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Last resort for tests where neither var is set — fail closed in production.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "MICROCHIP_FORCE_SECRET (or SUPABASE_SERVICE_ROLE_KEY) must be set in production.",
    );
  }
  return "dim-dev-fallback-key-not-for-production";
}

/** Generate a signed force-create token for the given microchipId. */
export function generateForceToken(microchipId: string): string {
  const ts = Date.now().toString();
  const key = getSigningKey();
  const mac = createHmac("sha256", key).update(`${microchipId}:${ts}`).digest("hex");
  // Encode as base64url-safe string + timestamp
  return `${Buffer.from(mac, "hex").toString("base64url")}.${ts}`;
}

/** Validate a force-create token. Returns true if valid and not expired. */
export function validateForceToken(microchipId: string, token: string): boolean {
  try {
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx === -1) return false;
    const macPart = token.slice(0, dotIdx);
    const tsPart = token.slice(dotIdx + 1);
    const ts = Number.parseInt(tsPart, 10);
    if (Number.isNaN(ts)) return false;
    if (Date.now() - ts > TOKEN_TTL_MS) return false;

    const key = getSigningKey();
    const expectedMac = createHmac("sha256", key).update(`${microchipId}:${tsPart}`).digest("hex");
    const expectedBuf = Buffer.from(expectedMac, "hex");
    const actualBuf = Buffer.from(macPart, "base64url");
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

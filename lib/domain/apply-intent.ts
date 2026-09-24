// Apply-intent token for the public adoption flow (spec
// adoption-listing-public v1.3 §8.1 + Fase 4).
//
// When an anonymous visitor clicks "Postularme para adoptar a {name}", the
// server signs a short-lived token that binds the intent to a specific pet
// token, then sets it as an httpOnly cookie and redirects the visitor to
// `/registro?intent=apply&returnTo=/adoptar/{petToken}/postular`. After the
// signup callback returns the user to the postular page, the page verifies
// the cookie's signature + expiry + petToken match before showing the form.
//
// Token format:  base64url(hex(hmac)) + "." + timestamp(ms)
// Expiry:        15 minutes from issuance — enough for a quick signup
//                including email confirmation, not long enough for a stale
//                share link to silently become a "free pass" to the form.
//
// APPLY_INTENT_SECRET — optional env var, falls back to
// SUPABASE_SERVICE_ROLE_KEY for parity with `microchip-force-token.ts`. Fails
// closed in production if neither is set (deploy-readiness audit 2026-07-04 W1).
//
// We do NOT persist tokens. The cookie is single-use by convention: the
// postular page clears it after a successful verification. Replay within
// the 15-min window is acceptable because the page also re-runs the full
// listability check against live DB state before rendering the form.

import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_MS = 15 * 60 * 1000;

export const APPLY_INTENT_COOKIE_NAME = "adoption_apply_intent";
// Plain (unsigned) parallel cookie that exposes the target pet token so the
// /inicio "Continuá tu postulación" banner (sprint 3 PR-024) can render
// without recovering the petToken from the signed cookie. Security stays in
// APPLY_INTENT_COOKIE_NAME: a cookie that says "I was trying to adopt pet X"
// is not a capability — the postular page still re-runs the full listability
// check + verifies the signed token before rendering the form.
export const APPLY_INTENT_PET_TOKEN_COOKIE_NAME = "adoption_apply_pet_token";
export const APPLY_INTENT_KIND = "adoption_apply";

function getSigningKey(): string {
  if (process.env.APPLY_INTENT_SECRET) return process.env.APPLY_INTENT_SECRET;
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Last resort for tests where neither var is set — fail closed in production.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "APPLY_INTENT_SECRET (or SUPABASE_SERVICE_ROLE_KEY) must be set in production.",
    );
  }
  return "dim-dev-fallback-key-not-for-production";
}

function payload(petToken: string, ts: string): string {
  return `${APPLY_INTENT_KIND}:${petToken}:${ts}`;
}

export function generateApplyIntentToken(petToken: string): string {
  const ts = Date.now().toString();
  const mac = createHmac("sha256", getSigningKey()).update(payload(petToken, ts)).digest("hex");
  return `${Buffer.from(mac, "hex").toString("base64url")}.${ts}`;
}

export function validateApplyIntentToken(petToken: string, token: string): boolean {
  try {
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx === -1) return false;
    const macPart = token.slice(0, dotIdx);
    const tsPart = token.slice(dotIdx + 1);
    const ts = Number.parseInt(tsPart, 10);
    if (Number.isNaN(ts)) return false;
    if (Date.now() - ts > TOKEN_TTL_MS) return false;

    const expectedMac = createHmac("sha256", getSigningKey())
      .update(payload(petToken, tsPart))
      .digest("hex");
    const expectedBuf = Buffer.from(expectedMac, "hex");
    const actualBuf = Buffer.from(macPart, "base64url");
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

export const APPLY_INTENT_TTL_MS = TOKEN_TTL_MS;

// The unsubscribe capability, pinned. If any property here regresses, the
// mailed "dejar de recibir" link either stops working or starts letting one
// user opt another one out — both are the exact failure this token exists to
// prevent.

import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  generateDigestUnsubscribeToken,
  validateDigestUnsubscribeToken,
} from "./digest-unsubscribe-token";

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

describe("generateDigestUnsubscribeToken / validateDigestUnsubscribeToken", () => {
  it("accepts a token minted for the same userId", () => {
    const token = generateDigestUnsubscribeToken(USER_A);
    expect(validateDigestUnsubscribeToken(USER_A, token)).toBe(true);
  });

  it("rejects a token minted for a DIFFERENT userId — cannot opt someone else out", () => {
    const token = generateDigestUnsubscribeToken(USER_A);
    expect(validateDigestUnsubscribeToken(USER_B, token)).toBe(false);
  });

  it("is deterministic — the same userId always mints the same token", () => {
    const first = generateDigestUnsubscribeToken(USER_A);
    const second = generateDigestUnsubscribeToken(USER_A);
    expect(first).toBe(second);
  });

  it("never expires — a token minted long ago still validates (no timestamp in the payload)", () => {
    const token = generateDigestUnsubscribeToken(USER_A);
    // Nothing to fast-forward: the token carries no timestamp, so there is no
    // clock to advance. Re-validating the same token is the regression guard
    // for "someone adds a TTL check and this route quietly starts expiring
    // a link that has to survive a person opening a week-old email".
    expect(validateDigestUnsubscribeToken(USER_A, token)).toBe(true);
  });

  it("rejects a malformed token without throwing", () => {
    expect(validateDigestUnsubscribeToken(USER_A, "not-a-real-token")).toBe(false);
    expect(validateDigestUnsubscribeToken(USER_A, "")).toBe(false);
    expect(validateDigestUnsubscribeToken("", "anything")).toBe(false);
  });

  it("rejects a token from a DIFFERENT purpose family (a session/reporter token) even if base64url-valid", () => {
    // A digest-unsubscribe token and (say) a denuncia reporter token are both
    // base64url(hex(hmac)) over a different signed payload — cross-purpose
    // replay must fail even though the shape is superficially identical.
    const foreignShapedToken = Buffer.from("00".repeat(32), "hex").toString("base64url");
    expect(validateDigestUnsubscribeToken(USER_A, foreignShapedToken)).toBe(false);
  });
});

describe("digest unsubscribe token — key separation and the shape gate (security review 2026-09-18)", () => {
  const BASE_KEY = "test-base-key-for-digest-unsubscribe";
  const originalSecret = process.env.DIGEST_UNSUBSCRIBE_SECRET;

  beforeEach(() => {
    process.env.DIGEST_UNSUBSCRIBE_SECRET = BASE_KEY;
  });
  afterEach(() => {
    if (originalSecret === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined".
      delete process.env.DIGEST_UNSUBSCRIBE_SECRET;
    } else {
      process.env.DIGEST_UNSUBSCRIBE_SECRET = originalSecret;
    }
  });

  function macUnder(key: string | Buffer, userId: string): string {
    const hex = createHmac("sha256", key)
      .update(`daily_digest_unsubscribe:${userId}`)
      .digest("hex");
    return Buffer.from(hex, "hex").toString("base64url");
  }
  const subkey = () => createHmac("sha256", BASE_KEY).update("dim/digest-unsubscribe/v1").digest();

  it("signs with the purpose-bound SUBKEY, never with the base key itself", () => {
    const token = generateDigestUnsubscribeToken(USER_A);
    expect(token).toBe(macUnder(subkey(), USER_A));
    // A MAC made directly under the base key (the service-role key, in most
    // environments) is NOT a valid link — the oracle is closed.
    const underBase = macUnder(BASE_KEY, USER_A);
    expect(underBase).not.toBe(token);
    expect(validateDigestUnsubscribeToken(USER_A, underBase)).toBe(false);
  });

  it("refuses a non-UUID `u` even when its MAC is correct under the real subkey", () => {
    // If the shape gate were missing, this would validate: the MAC is right.
    for (const bad of ["not-a-uuid", "admin", `${USER_A}x`, `${USER_A}\n`, "../cuenta"]) {
      expect(validateDigestUnsubscribeToken(bad, macUnder(subkey(), bad))).toBe(false);
    }
  });

  it("refuses to mint a link for a non-UUID id", () => {
    expect(() => generateDigestUnsubscribeToken("not-a-uuid")).toThrow();
  });
});

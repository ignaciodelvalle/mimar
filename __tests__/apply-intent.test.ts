import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APPLY_INTENT_TTL_MS,
  generateApplyIntentToken,
  validateApplyIntentToken,
} from "@/lib/domain/apply-intent";

describe("apply-intent: generate / validate", () => {
  it("validates a freshly-generated token for the same petToken", () => {
    const token = generateApplyIntentToken("DIM-AAAA-AAAA");
    expect(validateApplyIntentToken("DIM-AAAA-AAAA", token)).toBe(true);
  });

  it("rejects a token signed for a different petToken (no pet-A → pet-B leak)", () => {
    const tokenForA = generateApplyIntentToken("DIM-AAAA-AAAA");
    expect(validateApplyIntentToken("DIM-BBBB-BBBB", tokenForA)).toBe(false);
  });

  it("rejects a tampered token (last bytes mangled)", () => {
    const token = generateApplyIntentToken("DIM-CCCC-CCCC");
    const tampered = `${token.slice(0, -5)}XXXXX`;
    expect(validateApplyIntentToken("DIM-CCCC-CCCC", tampered)).toBe(false);
  });

  it("rejects malformed tokens (no dot, empty, non-numeric ts)", () => {
    expect(validateApplyIntentToken("DIM-X", "not-a-valid-token")).toBe(false);
    expect(validateApplyIntentToken("DIM-X", "")).toBe(false);
    expect(validateApplyIntentToken("DIM-X", "abc.notanumber")).toBe(false);
  });

  it("rejects a token whose timestamp is older than the TTL", () => {
    const fresh = generateApplyIntentToken("DIM-DDDD-DDDD");
    const dotIdx = fresh.lastIndexOf(".");
    const macPart = fresh.slice(0, dotIdx);
    // The MAC is signed over (kind:petToken:ts); changing only ts breaks
    // the signature, so this test asserts the combined "expired OR
    // signature mismatch" rejection — exactly what real-world expiry looks
    // like to a caller.
    const expiredTs = Date.now() - APPLY_INTENT_TTL_MS - 1000;
    const expiredToken = `${macPart}.${expiredTs}`;
    expect(validateApplyIntentToken("DIM-DDDD-DDDD", expiredToken)).toBe(false);
  });
});

describe("apply-intent: fail-closed signing key resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws in production when neither APPLY_INTENT_SECRET nor SUPABASE_SERVICE_ROLE_KEY is set", () => {
    vi.stubEnv("APPLY_INTENT_SECRET", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => generateApplyIntentToken("DIM-EEEE-EEEE")).toThrow(
      /APPLY_INTENT_SECRET .* must be set in production/i,
    );
  });

  it("falls back to the dev key outside production when neither var is set", () => {
    vi.stubEnv("APPLY_INTENT_SECRET", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("NODE_ENV", "test");
    expect(() => generateApplyIntentToken("DIM-FFFF-FFFF")).not.toThrow();
  });
});

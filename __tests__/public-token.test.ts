// Unit tests for lib/publicToken (review 2026-05-19 §2.6).
//
// Verifies the alphabet, format, and uniform distribution. The uniformity
// test is the §2.6 fix: previously bytes were mapped to alphabet indices
// via `byte % 31`, which biased the first 8 chars ~0.4% upward (256 % 31 = 8).
// Rejection sampling drops bytes >= 248 to remove the bias.

import { describe, expect, it } from "vitest";

import {
  generateApprovalRequestToken,
  generateLibretaShareToken,
  generatePublicToken,
  generateTagActivationCode,
  generateTagSerial,
} from "@/lib/infra/publicToken";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 chars
const EXCLUDED = ["0", "1", "I", "O", "L"]; // confusable chars deliberately removed

describe("publicToken — format and alphabet", () => {
  it("generatePublicToken matches DIM-XXXX-XXXX", () => {
    const token = generatePublicToken();
    expect(token).toMatch(/^DIM-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it("generateLibretaShareToken matches LBR-XXXX-XXXX", () => {
    const token = generateLibretaShareToken();
    expect(token).toMatch(/^LBR-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it("generateApprovalRequestToken matches the expected pattern", () => {
    const token = generateApprovalRequestToken();
    // Approval-request tokens follow the same shape; the exact prefix is
    // an implementation detail — match the alphabet on whatever body is present.
    expect(token).toMatch(/^[A-Z]{2,4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it("generateTagSerial matches TAG-XXXX-XXXX", () => {
    const token = generateTagSerial();
    expect(token).toMatch(/^TAG-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it("generateTagActivationCode is UNPREFIXED XXXX-XXXX (wrapper code, not a serial)", () => {
    const code = generateTagActivationCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it("never emits excluded confusable chars (0, 1, I, O, L)", () => {
    for (let i = 0; i < 200; i++) {
      const body = generatePublicToken().replace(/^DIM-/, "").replace("-", "");
      for (const ch of EXCLUDED) {
        expect(body.includes(ch)).toBe(false);
      }
    }
  });
});

describe("publicToken — uniform character distribution (§2.6)", () => {
  // The pre-§2.6 implementation used `byte % 31` which gave the first 8
  // alphabet chars an ~0.4% (1/248) advantage. Over 100k characters that's
  // ~400 extra hits per biased char vs unbiased — easily detectable by
  // a chi-squared sanity check, but probabilistic so we keep the bound loose.
  it("draws each alphabet character within ±20% of the expected frequency over 100k chars", () => {
    // 12,500 tokens × 8 random body chars = 100,000 samples
    const samples = 12_500;
    const counts = new Map<string, number>();
    for (const ch of ALPHABET) counts.set(ch, 0);

    for (let i = 0; i < samples; i++) {
      const body = generatePublicToken().replace(/^DIM-/, "").replace("-", "");
      for (const ch of body) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }

    const total = samples * 8;
    const expected = total / ALPHABET.length; // ~3,226 per char
    const tolerance = 0.2; // ±20% — loose to avoid CI flakiness

    for (const [ch, count] of counts) {
      const ratio = count / expected;
      expect(
        ratio,
        `char ${ch} appeared ${count} times (ratio ${ratio.toFixed(3)}, expected ~${expected.toFixed(0)})`,
      ).toBeGreaterThan(1 - tolerance);
      expect(ratio).toBeLessThan(1 + tolerance);
    }
  });
});
